# Builds public world props into one glTF: decimated Poly Haven models (CC0),
# ruined fort walls cut from Poly Haven's modular_fort_01, and procedurally
# modelled half-timbered houses, well, fence, columns and dais textured with
# Poly Haven materials.
#
# blender -b --factory-startup -P tools/props/build_props.py -- <polyhaven dir> <out.glb>
#
# Every asset ends up as one top-level object named after its key, origin at
# the centre of its footprint, ground at z = 0, front facing -Y (glTF +Z).
import bpy, bmesh, sys, math, random
from mathutils import Vector, Matrix, noise

PH, OUT = sys.argv[sys.argv.index('--') + 1:][:2]
random.seed(7)
bpy.ops.wm.read_factory_settings(use_empty=True)
out_objs = []


def log(*a):
    print('[props]', *a, flush=True)


# ------------------------------------------------------------------ helpers
def select_only(objs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]


def import_ph(asset, tex=1024):
    before, images = set(bpy.data.objects), set(bpy.data.images)
    bpy.ops.import_scene.gltf(filepath=f'{PH}/{asset}/{asset}.gltf')
    for im in set(bpy.data.images) - images:  # small props get smaller textures
        if im.size[0] > tex:
            im.scale(tex, tex)
            im.pack()
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == 'MESH']
    select_only(meshes)
    bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
    for o in new:
        if o.type != 'MESH':
            bpy.data.objects.remove(o)
    return {o.name: o for o in meshes}


def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def finish(objs, name, target=None, centre=True):
    """Join, apply transforms, put the origin at the footprint centre, decimate."""
    select_only(objs)
    if len(objs) > 1:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if centre:
        vs = [v.co for v in o.data.vertices]
        c = Vector(((min(v.x for v in vs) + max(v.x for v in vs)) / 2, (min(v.y for v in vs) + max(v.y for v in vs)) / 2, min(v.z for v in vs)))
        o.data.transform(Matrix.Translation(-c))
    if target and tris(o) > target:
        m = o.modifiers.new('dec', 'DECIMATE')
        m.ratio = target / tris(o)
        m.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=m.name)
    o.name = o.data.name = name
    out_objs.append(o)
    log(name, tris(o), 'tris', tuple(round(x, 2) for x in o.dimensions))
    return o


def gltf_output_group():
    g = bpy.data.node_groups.get('glTF Material Output')
    if not g:
        g = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
        g.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
    return g


def pbr(name, tex, tint=None, rough=None):
    """Material from a Poly Haven texture set (diffuse, GL normal, ARM)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.use_backface_culling = True
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    base = f'{PH}/{tex}/{tex}'

    def img(kind, colour):
        n = nt.nodes.new('ShaderNodeTexImage')
        n.image = bpy.data.images.load(f'{base}_{kind}.jpg', check_existing=True)
        n.image.colorspace_settings.name = 'sRGB' if colour else 'Non-Color'
        return n
    d = img('diffuse', True)
    if tint:
        mix = nt.nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        mix.blend_type = 'MULTIPLY'
        mix.inputs['Factor'].default_value = 1
        mix.inputs['B'].default_value = (*tint, 1)
        nt.links.new(d.outputs['Color'], mix.inputs['A'])
        nt.links.new(mix.outputs['Result'], bsdf.inputs['Base Color'])
    else:
        nt.links.new(d.outputs['Color'], bsdf.inputs['Base Color'])
    n = img('nor_gl', False)
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(n.outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    a = img('arm', False)
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(a.outputs['Color'], sep.inputs['Color'])
    nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
    nt.links.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    occ = nt.nodes.new('ShaderNodeGroup')
    occ.node_tree = gltf_output_group()
    nt.links.new(sep.outputs['Red'], occ.inputs['Occlusion'])
    return m


def flat(name, colour, rough):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*colour, 1)
    b.inputs['Roughness'].default_value = rough
    return m


class Builder:
    """Accumulates boxes, prisms and cylinders into one mesh with projected UVs."""

    def __init__(self, mats):
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new('UVMap')
        self.mats = mats  # list of (material, metres per texture tile)

    def _uv_box(self, faces, mi, mode, off):
        tile = self.mats[mi][1]
        for f in faces:
            f.material_index = mi
            n = f.normal
            ax = max(range(3), key=lambda i: abs(n[i]))
            for l in f.loops:
                p = l.vert.co + off
                if ax == 2:
                    u, v = (p.y, p.x) if mode == 'roof' else (p.x, p.y)
                elif ax == 0:
                    u, v = p.y, p.z
                else:
                    u, v = p.x, p.z
                l[self.uv].uv = (u / tile, v / tile)

    def box(self, size, mat4, mi, mode='box', off=None):
        r = bmesh.ops.create_cube(self.bm, size=1)
        vs = r['verts']
        bmesh.ops.scale(self.bm, vec=Vector(size), verts=vs)
        faces = list({f for v in vs for f in v.link_faces})
        bmesh.ops.recalc_face_normals(self.bm, faces=faces)
        self._uv_box(faces, mi, mode, off if off is not None else Vector((random.random() * 3, random.random() * 3, 0)))
        bmesh.ops.transform(self.bm, matrix=mat4, verts=vs)

    def at(self, size, pos, mi, rot=None, mode='box'):
        m = Matrix.Translation(Vector(pos))
        if rot:
            m = m @ rot
        self.box(size, m, mi, mode)

    def prism(self, pts, y0, y1, mi):
        """Extrudes a polygon given in the XZ plane from y0 to y1."""
        a = [self.bm.verts.new((x, y0, z)) for x, z in pts]
        b = [self.bm.verts.new((x, y1, z)) for x, z in pts]
        faces = [self.bm.faces.new(a[::-1]), self.bm.faces.new(b)]
        for i in range(len(pts)):
            j = (i + 1) % len(pts)
            faces.append(self.bm.faces.new((a[i], a[j], b[j], b[i])))
        bmesh.ops.recalc_face_normals(self.bm, faces=faces)
        self._uv_box(faces, mi, 'box', Vector((0, 0, 0)))

    def disc(self, r_out, r_in, pos, mi, sides=16, rot=None):
        """Flat upward-facing ring (or disc when r_in == 0) with planar UVs."""
        tile = self.mats[mi][1]
        outer = [self.bm.verts.new((math.cos(k / sides * math.tau) * r_out, math.sin(k / sides * math.tau) * r_out, 0)) for k in range(sides)]
        if r_in > 0:
            inner = [self.bm.verts.new((math.cos(k / sides * math.tau) * r_in, math.sin(k / sides * math.tau) * r_in, 0)) for k in range(sides)]
            faces = [self.bm.faces.new((inner[k], outer[k], outer[(k + 1) % sides], inner[(k + 1) % sides])) for k in range(sides)]
        else:
            inner = []
            faces = [self.bm.faces.new(outer)]
        for f in faces:
            f.material_index = mi
            for l in f.loops:
                l[self.uv].uv = (l.vert.co.x / tile, l.vert.co.y / tile)
        m = Matrix.Translation(Vector(pos)) @ (rot or Matrix())
        bmesh.ops.transform(self.bm, matrix=m, verts=outer + inner)

    def cylinder(self, r0, r1, h, pos, mi, sides=16, caps=True, rot=None, flip=False):
        tile = self.mats[mi][1]
        ring0, ring1 = [], []
        for k in range(sides):
            a = k / sides * math.tau
            ring0.append(self.bm.verts.new((math.cos(a) * r0, math.sin(a) * r0, 0)))
            ring1.append(self.bm.verts.new((math.cos(a) * r1, math.sin(a) * r1, h)))
        faces = []
        circ = math.tau * (r0 + r1) / 2
        for k in range(sides):
            j = (k + 1) % sides
            quad = (ring0[k], ring0[j], ring1[j], ring1[k])
            f = self.bm.faces.new(quad[::-1] if flip else quad)
            f.smooth = True
            f.material_index = mi
            for l in f.loops:
                kk = k + 1 if l.vert in (ring0[j], ring1[j]) else k
                l[self.uv].uv = (kk / sides * circ / tile, l.vert.co.z / tile)
            faces.append(f)
        if caps:
            for ring, top in ((ring0, False), (ring1, True)):
                f = self.bm.faces.new(ring if top else ring[::-1])
                f.material_index = mi
                for l in f.loops:
                    l[self.uv].uv = (l.vert.co.x / tile, l.vert.co.y / tile)
                faces.append(f)
        vs = ring0 + ring1
        m = Matrix.Translation(Vector(pos)) @ (rot or Matrix())
        bmesh.ops.transform(self.bm, matrix=m, verts=vs)

    def build(self, name):
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        for mat, _ in self.mats:
            me.materials.append(mat)
        o = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(o)
        return o


def cut_top(obj, profile, mat, uv_tile=2.5, margin=3.0, depth=None):
    """Crumbles the top of obj: removes everything above z = profile(x, y)."""
    xs = [v.co.x for v in obj.data.vertices]
    ys = [v.co.y for v in obj.data.vertices]
    x0, x1 = min(xs) - margin, max(xs) + margin
    y0, y1 = min(ys) - margin, max(ys) + margin
    nx, ny = 64, max(4, int((y1 - y0) / 0.6))
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    grid = [[bm.verts.new((x0 + (x1 - x0) * i / nx, y0 + (y1 - y0) * j / ny, 0)) for j in range(ny + 1)] for i in range(nx + 1)]
    for row in grid:
        for v in row:
            v.co.z = profile(v.co.x, v.co.y)
    bottom = []
    for i in range(nx):
        for j in range(ny):
            bottom.append(bm.faces.new((grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j])))
    ext = bmesh.ops.extrude_face_region(bm, geom=bottom)
    top_verts = [e for e in ext['geom'] if isinstance(e, bmesh.types.BMVert)]
    for v in top_verts:
        v.co.z = 80
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        for l in f.loops:
            l[uv].uv = (l.vert.co.x / uv_tile, l.vert.co.y / uv_tile)
    me = bpy.data.meshes.new('cutter')
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    cutter = bpy.data.objects.new('cutter', me)
    bpy.context.scene.collection.objects.link(cutter)
    mod = obj.modifiers.new('cut', 'BOOLEAN')
    mod.operation = 'DIFFERENCE'
    mod.object = cutter
    mod.solver = 'EXACT'
    mod.material_mode = 'TRANSFER'
    select_only([obj])
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.data.objects.remove(cutter)


def ragged(base, amp=0.7, seed=0.0, step=0.3):
    """Blocky, noisy break line around base(x)."""
    def f(x, y):
        n = noise.noise(Vector((x * 0.35 + seed, y * 0.2, seed))) * amp
        n += noise.noise(Vector((x * 1.3, y * 0.9 + seed, 3 + seed))) * amp * 0.45
        return round((base(x) + n) / step) * step
    return f


# ------------------------------------------------------------------ materials
M = {
    'plaster': (pbr('plaster', 'worn_mossy_plasterwall', tint=(1.0, 0.93, 0.8)), 3.0),
    'timber': (pbr('timber', 'weathered_planks'), 2.0),
    'door': (pbr('door', 'medieval_wood'), 1.4),
    'stone': (pbr('stone', 'rustic_stone_wall_02'), 2.2),
    'thatch': (pbr('thatch', 'thatch_roof_angled', tint=(1.0, 0.88, 0.62)), 2.5),
    'slate': (pbr('slate', 'roof_slates_02'), 2.2),
    'ruin': (pbr('ruin', 'castle_wall_slates'), 2.6),
    'floor': (pbr('floor', 'monastery_stone_floor'), 3.0),
    'canvas': (pbr('canvas', 'hessian_230', tint=(1.0, 0.96, 0.88)), 0.8),
    'glass': (flat('glass', (0.02, 0.025, 0.03), 0.15), 1.0),
    'water': (flat('well_water', (0.01, 0.025, 0.03), 0.05), 1.0),
}


def mats(*names):
    return [M[n] for n in names]


# ------------------------------------------------------------------ Poly Haven props
PROPS = [
    # (asset, key, max triangles, [object name filter])
    ('wine_barrel_01', 'barrel', 1400, None),
    ('wooden_crate_01', 'crate_small', 900, None),
    ('wooden_crate_02', 'crate_long', 900, None),
    ('wooden_bucket_01', 'bucket', 700, None),
    ('wooden_lantern_01', 'lantern', 900, None),
    ('spinning_wheel_01', 'spinning_wheel', 2500, None),
    ('wooden_stool_02', 'stool', 700, None),
    ('stone_fire_pit', 'fire_pit', 1600, None),
    ('treasure_chest', 'chest', 2600, None),
    ('dead_tree_trunk', 'log', 1400, None),
    ('wooden_axe', 'axe', 600, None),
    ('kite_shield', 'shield', 1400, None),
]
for asset, key, target, _ in PROPS:
    objs = import_ph(asset, 512)
    finish(list(objs.values()), key, target)

# Rocks: every piece of the two moss sets becomes its own asset.
for asset, target in (('rock_moss_set_01', 1600), ('rock_moss_set_02', 900)):
    objs = import_ph(asset)
    for name, o in sorted(objs.items()):
        finish([o], 'rock_' + name.split('_')[-1].replace('rock', ''), target)

# ------------------------------------------------------------------ ruined fort pieces
fort = import_ph('modular_fort_01')
wall_mat = next(m for m in bpy.data.materials if m.name.startswith('modular_fort_01_wall'))


def fort_piece(src, key, profile, target, turn=True):
    o = fort[f'modular_fort_01_{src}'].copy()
    o.data = o.data.copy()
    bpy.context.scene.collection.objects.link(o)
    select_only([o])
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    vs = [v.co for v in o.data.vertices]
    c = Vector(((min(v.x for v in vs) + max(v.x for v in vs)) / 2, (min(v.y for v in vs) + max(v.y for v in vs)) / 2, 0))
    m = Matrix.Translation(-c)
    if turn:  # length along X like the game's walls
        m = Matrix.Rotation(math.pi / 2, 4, 'Z') @ m
    o.data.transform(m)
    cut_top(o, profile, wall_mat)
    return finish([o], key, target)


fort_piece('wall_thin_straight_02', 'ruin_wall_a', ragged(lambda x: 4.6 - x * 0.16, 0.8, 1.0), 2600)
fort_piece('wall_thin_straight_01', 'ruin_wall_b', ragged(lambda x: 3.6 + 2.6 * min(1, abs(x) / 3.2) ** 2 - 2.4 * max(0, 1 - abs(x) / 3.2), 0.6, 5.0), 2000)
fort_piece('wall_thin_straight_03', 'ruin_wall_c', ragged(lambda x: 2.8 + x * 0.12, 0.6, 9.0), 1000)
fort_piece('wall_thin_gate_01', 'ruin_gate', ragged(lambda x: 7.4 - abs(x) * 0.25, 0.5, 13.0), 1600)
fort_piece('wall_thick_corner_01', 'ruin_corner', ragged(lambda x: 5.2 + x * 0.3, 0.7, 17.0), 1500, turn=False)
fort_piece('tower_round', 'ruin_tower', ragged(lambda x: 8.5 + x * 0.35 - 3.5 * max(0, 1 - abs(x - 2.5) / 2.5), 0.9, 21.0), 4000, turn=False)
for o in fort.values():
    bpy.data.objects.remove(o)

# ------------------------------------------------------------------ columns, dais
def column(key, h, broken):
    b = Builder(mats('ruin'))
    b.cylinder(0.6, 0.52, h - 1.0, (0, 0, 0.75), 0, 20, caps=True)
    if not broken:
        b.cylinder(0.55, 0.75, 0.3, (0, 0, h - 0.25), 0, 20)
        b.at((1.65, 1.65, 0.4), (0, 0, h + 0.25), 0)
    shaft = b.build(key + '_shaft')
    if broken:
        cut_top(shaft, ragged(lambda x: h - 0.6 + x * 0.5, 0.45, h, 0.12), M['ruin'][0], margin=1)
    b = Builder(mats('ruin'))
    b.at((1.7, 1.7, 0.5), (0, 0, 0.25), 0)
    b.cylinder(0.72, 0.62, 0.25, (0, 0, 0.5), 0, 20)
    return finish([b.build(key), shaft], key)


column('column', 7.0, False)
column('column_broken_a', 4.2, True)
column('column_broken_b', 2.6, True)
b = Builder(mats('ruin'))
b.cylinder(0.6, 0.6, 1.9, (0, 0, 0.6), 0, 20, rot=Matrix.Rotation(math.pi / 2, 4, 'Y') @ Matrix.Translation((0, 0, -0.95)))
finish([b.build('column_drum')], 'column_drum')

# Octagonal two-step dais with an altar.
b = Builder(mats('ruin', 'floor'))
for r, z0, z1 in ((6.0, -0.6, 0.35), (5.0, 0.35, 0.75)):
    b.cylinder(r, r, z1 - z0, (0, 0, z0), 0, 8, caps=False, rot=Matrix.Rotation(math.pi / 8, 4, 'Z'))
    b.disc(r, 0, (0, 0, z1), 1, 8, rot=Matrix.Rotation(math.pi / 8, 4, 'Z'))
b.at((2.6, 1.3, 0.25), (0, 0, 0.87), 0)
b.at((2.3, 1.1, 0.9), (0, 0, 1.4), 0)
b.at((2.6, 1.3, 0.2), (0, 0, 1.95), 0)
finish([b.build('dais')], 'dais')

# ------------------------------------------------------------------ houses
def house(key, w, d, h, roof='thatch', chimney=False, pitch=47):
    b = Builder(mats('plaster', 'timber', 'door', 'stone', roof, 'glass'))
    PL, TI, DO, ST, RF, GL = range(6)
    t = 0.22
    z0 = 0.55  # top of the stone plinth
    top = z0 + h
    b.at((w + 0.4, d + 0.4, 1.3), (0, 0, z0 - 0.65), ST)
    b.at((w, d, h), (0, 0, z0 + h / 2), PL)
    # Openings per wall: list of (centre, half width, z bottom, z top).
    two_rows = h >= 4
    win_z = [(z0 + 0.9, z0 + 1.9), (top - 1.5, top - 0.55)] if two_rows else [(z0 + 1.0, z0 + 2.0)]
    door = (0.0, 0.62, z0, z0 + 2.15)
    walls = {
        'front': (w, [door] + [(sx * w / 3.2, 0.5, a, c) for sx in (-1, 1) for a, c in win_z]),
        'back': (w, [(sx * w / 4, 0.5, a, c) for sx in (-1, 1) for a, c in win_z[-1:]]),
        'left': (d, [(0, 0.5, a, c) for a, c in win_z]),
        'right': (d, [(0, 0.5, a, c) for a, c in win_z[-1:]] if chimney else [(0, 0.5, a, c) for a, c in win_z]),
    }
    # Frame of each wall in house space: origin at the wall centre, x along it, outward normal.
    frames = {
        'front': Matrix.Translation((0, -d / 2, 0)),
        'back': Matrix.Translation((0, d / 2, 0)) @ Matrix.Rotation(math.pi, 4, 'Z'),
        'left': Matrix.Translation((-w / 2, 0, 0)) @ Matrix.Rotation(-math.pi / 2, 4, 'Z'),
        'right': Matrix.Translation((w / 2, 0, 0)) @ Matrix.Rotation(math.pi / 2, 4, 'Z'),
    }
    for name, (length, opens) in walls.items():
        F = frames[name]

        def put(size, x, z, mi=TI, out=0.0, rot=None):
            m = F @ Matrix.Translation((x, -out, z))
            if rot:
                m = m @ rot
            b.box(size, m, mi)
        half = length / 2
        put((length + t, t, t), 0, z0 + t / 2, out=0.04)          # sill
        put((length + t, t, t), 0, top - t / 2, out=0.04)         # top plate
        # Mid rail, broken around openings that cross it.
        mid = z0 + h * (0.5 if not two_rows else 0.47)
        segs = [(-half, half)]
        for cx, hw, a, c in opens:
            if a < mid < c + 0.15:
                segs = [s for seg in segs for s in ((seg[0], min(seg[1], cx - hw - 0.12)), (max(seg[0], cx + hw + 0.12), seg[1])) if s[1] - s[0] > 0.2]
        for s0, s1 in segs:
            put((s1 - s0, t * 0.9, t * 0.9), (s0 + s1) / 2, mid, out=0.03)
        # Studs every ~1.4 m that stay clear of openings; braces near the corners.
        n = max(2, round(length / 1.4))
        for i in range(1, n):
            x = -half + length * i / n
            if any(abs(x - cx) < hw + 0.25 for cx, hw, _, _ in opens):
                continue
            put((t * 0.85, t * 0.9, h - t), x, z0 + h / 2, out=0.03)
        for sx in (-1, 1):
            x_a, x_b = sx * (half - 0.15), sx * (half - min(1.3, length * 0.22))
            if any(abs((x_a + x_b) / 2 - cx) < hw + 0.7 for cx, hw, _, _ in opens):
                continue
            dz = mid - z0
            ln = math.hypot(x_b - x_a, dz)
            ang = math.atan2(dz, x_b - x_a)
            put((ln, t * 0.8, t * 0.8), (x_a + x_b) / 2, z0 + dz / 2, out=0.025, rot=Matrix.Rotation(-ang, 4, 'Y'))
        for cx, hw, a, c in opens:
            is_door = a == z0
            # Frame.
            put((t * 0.8, t, c - a + t), cx - hw - t * 0.4, (a + c) / 2, out=0.06)
            put((t * 0.8, t, c - a + t), cx + hw + t * 0.4, (a + c) / 2, out=0.06)
            put((hw * 2 + t * 1.6, t, t * 0.9), cx, c + t * 0.45, out=0.06)
            if is_door:
                put((hw * 2, 0.08, c - a), cx, (a + c) / 2, mi=DO, out=0.01)
                b.box((1.6, 0.7, 0.25), F @ Matrix.Translation((cx, -0.45, z0 - 0.12)), ST)
            else:
                put((hw * 2 + t * 1.8, 0.2, 0.09), cx, a - 0.03, out=0.1)   # sill board
                put((hw * 2, 0.04, c - a), cx, (a + c) / 2, mi=GL, out=0.005)
                put((0.05, 0.06, c - a), cx, (a + c) / 2, out=0.02)       # mullion
                put((hw * 2, 0.06, 0.05), cx, (a + c) / 2, out=0.02)
                for sx in (-1, 1):  # open shutters
                    put((hw, 0.05, c - a), cx + sx * (hw * 1.5 + t * 0.8), (a + c) / 2, mi=DO, out=0.03)
        for sx in (-1, 1):  # corner posts
            put((t * 1.1, t * 1.1, h + 0.05), sx * half, z0 + h / 2, out=0.0)

    # Gables (front and back) and the roof.
    run = w / 2
    rise = run * math.tan(math.radians(pitch))
    for y, sgn in ((-d / 2, -1), (d / 2, 1)):
        b.prism([(-run, top), (run, top), (0, top + rise)], y - sgn * 0.02, y + sgn * 0.0 - sgn * 0.3, PL)
        F = Matrix.Translation((0, y, 0)) @ (Matrix() if sgn < 0 else Matrix.Rotation(math.pi, 4, 'Z'))
        b.box((t, t, rise - 0.2), F @ Matrix.Translation((0, -0.06, top + (rise - 0.2) / 2)), TI)
        b.box((w * 0.55, t, t), F @ Matrix.Translation((0, -0.06, top + rise * 0.45)), TI)
    th = 0.38 if roof == 'thatch' else 0.16
    eave = 0.75
    slope_len = (run + eave) / math.cos(math.radians(pitch)) + 0.15
    ridge = Vector((0, 0, top + rise + th / math.cos(math.radians(pitch)) - 0.05))
    for turn in (0, math.pi):
        m = Matrix.Translation(ridge) @ Matrix.Rotation(turn, 4, 'Z') @ Matrix.Rotation(math.radians(pitch), 4, 'Y') @ Matrix.Translation((slope_len / 2 - 0.12, 0, -th / 2))
        b.box((slope_len, d + 1.1, th), m, RF, mode='roof', off=Vector((0, 0, 0)))
    b.box((0.55, d + 1.15, 0.55), Matrix.Translation(ridge + Vector((0, 0, -0.08))) @ Matrix.Rotation(math.pi / 4, 4, 'Y'), RF, mode='roof')
    if chimney:
        cx = w / 2 - 0.15
        b.at((0.9, 1.0, top + rise + 1.2), (cx, d * 0.18, (top + rise + 1.2) / 2), ST)
        b.at((1.05, 1.15, 0.2), (cx, d * 0.18, top + rise + 1.2), ST)
    return finish([b.build(key)], key)


house('house_a', 7, 6, 3.4)
house('house_b', 6, 5.5, 3.2, chimney=True)
house('house_c', 7.5, 6.5, 3.6, roof='slate', pitch=40, chimney=True)
house('house_d', 5.5, 5, 3.0)
house('house_chief', 10, 7, 4.4, roof='slate', pitch=40, chimney=True)

# ------------------------------------------------------------------ village bits
b = Builder(mats('stone', 'timber', 'slate', 'water'))
ST, TI, RF, WA = range(4)
b.cylinder(1.35, 1.3, 1.0, (0, 0, -0.2), ST, 18, caps=False)
b.cylinder(1.0, 1.0, 1.0, (0, 0, -0.2), ST, 18, caps=False, flip=True)
b.disc(1.35, 1.0, (0, 0, 0.8), ST, 18)
b.disc(1.0, 0, (0, 0, 0.35), WA, 18)
for sx in (-1, 1):
    b.at((0.2, 0.2, 2.5), (sx * 1.15, 0, 1.25), TI)
b.at((2.6, 0.14, 0.14), (0, 0, 2.05), TI)
for turn in (0, math.pi):
    m = Matrix.Translation((0, 0, 2.75)) @ Matrix.Rotation(turn, 4, 'Z') @ Matrix.Rotation(math.radians(35), 4, 'Y') @ Matrix.Translation((0.7, 0, -0.05))
    b.box((1.5, 1.6, 0.1), m, RF, mode='roof')
finish([b.build('well')], 'well')

b = Builder(mats('timber'))
for x in (-1.45, 1.45):
    b.at((0.16, 0.16, 1.3), (x, 0, 0.5), 0)
for z in (0.45, 0.95):
    b.at((3.1, 0.07, 0.15), (0, -0.1, z), 0)
finish([b.build('fence')], 'fence')

# ------------------------------------------------------------------ camp tents
M['canvas'][0].use_backface_culling = False


def tent(key, L, hw, h, sag=0.12):
    """A-frame canvas tent, open at the front (-Y), with poles and guy ropes."""
    b = Builder(mats('canvas', 'timber'))
    bm, uv = b.bm, b.uv
    nx, ny = 8, 5
    slope = math.hypot(hw, h)
    for side in (-1, 1):
        g = []
        for i in range(nx + 1):
            u = i / nx
            row = []
            for j in range(ny + 1):
                v = j / ny
                drop = sag * math.sin(math.pi * u) * math.sin(math.pi * v)
                flare = 0.12 * v ** 3
                row.append(bm.verts.new((side * (v * hw + flare - drop * 0.6), (u - 0.5) * L, h * (1 - v) - drop + 0.02)))
            g.append(row)
        for i in range(nx):
            for j in range(ny):
                q = (g[i][j], g[i + 1][j], g[i + 1][j + 1], g[i][j + 1])
                f = bm.faces.new(q[::-1] if side > 0 else q)
                f.smooth = True
                for l in f.loops:
                    l[uv].uv = ((l.vert.co.y + L / 2) / 0.8, (h - l.vert.co.z) / h * slope / 0.8)
    # Closed back wall.
    back = [bm.verts.new(p) for p in ((-hw - 0.12, L / 2, 0.02), (hw + 0.12, L / 2, 0.02), (0, L / 2, h + 0.02))]
    f = bm.faces.new(back)
    for l in f.loops:
        l[uv].uv = (l.vert.co.x / 0.8, l.vert.co.z / 0.8)
    # Poles: two uprights and the ridge.
    for y in (-L / 2 - 0.05, L / 2 + 0.05):
        b.cylinder(0.04, 0.04, h + 0.25, (0, y, 0), 1, 6)
    b.cylinder(0.035, 0.035, L + 0.3, (0, -L / 2 - 0.15, h + 0.05), 1, 6, rot=Matrix.Rotation(-math.pi / 2, 4, 'X'))
    # Guy ropes from the pole tops to stakes in front and behind.
    for y, d in ((-L / 2 - 0.05, -1), (L / 2 + 0.05, 1)):
        top, stake = Vector((0, y, h + 0.2)), Vector((0, y + d * 1.4, 0))
        dv = stake - top
        rot = dv.to_track_quat('Z', 'Y').to_matrix().to_4x4()
        b.cylinder(0.012, 0.012, dv.length, tuple(top), 1, 4, rot=rot)
        b.at((0.05, 0.05, 0.35), tuple(stake + Vector((0, 0, 0.1))), 1)
    return finish([b.build(key)], key)


tent('tent', 3.4, 1.55, 2.0)
tent('tent_small', 2.6, 1.2, 1.5)

# ------------------------------------------------------------------ export
keep = set(out_objs)
for o in list(bpy.data.objects):
    if o not in keep:
        bpy.data.objects.remove(o)
for o in out_objs:
    o.location = (0, 0, 0)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_apply=True, export_yup=True, export_image_format='AUTO', export_extras=False)
log('exported', len(out_objs), 'assets ->', OUT)
