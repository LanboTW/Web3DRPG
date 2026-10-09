"""
Procedural skeleton body for MPFB's game_engine rig.

Every bone of the skeleton (skull, vertebrae, ribs, pelvis, limbs, hands and
feet) is modelled from simple primitives placed along the rig's rest pose and
bound rigidly (weight 1) to one rig bone, so the human animations drive it
unchanged. Built in world space with the character facing -Y.
"""
import math

import bmesh
import bpy
from mathutils import Matrix, Vector

UP = Vector((0, 0, 1))


class Body:
    def __init__(self, rig):
        self.rig = rig
        self.bm = bmesh.new()
        self.deform = self.bm.verts.layers.deform.verify()
        self.groups = {}
        self.W = rig.matrix_world

    # -------------------------------------------------------------- rig access
    def head(self, b):
        return self.W @ self.rig.data.bones[b].head_local

    def tail(self, b):
        return self.W @ self.rig.data.bones[b].tail_local

    # -------------------------------------------------------------- primitives
    def _bind(self, verts, bone, mat):
        gi = self.groups.setdefault(bone, len(self.groups))
        for v in verts:
            v[self.deform][gi] = 1.0
            for f in v.link_faces:
                f.material_index = mat

    def blob(self, centre, radii, bone, mat=0, rot=None, subdiv=2):
        r = bmesh.ops.create_icosphere(self.bm, subdivisions=subdiv, radius=1.0)
        m = Matrix.Translation(Vector(centre)) @ (rot or Matrix()) @ Matrix.Diagonal((*radii, 1))
        bmesh.ops.transform(self.bm, matrix=m, verts=r['verts'])
        for f in {f for v in r['verts'] for f in v.link_faces}:
            f.smooth = True
        self._bind(r['verts'], bone, mat)

    def tube(self, points, radii, bone, mat=0, sides=7, caps=True):
        """Sweeps a circle along a polyline; radii per point (or one value)."""
        pts = [Vector(p) for p in points]
        if not isinstance(radii, (list, tuple)):
            radii = [radii] * len(pts)
        rings = []
        prev_side = None
        for i, p in enumerate(pts):
            d = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
            side = prev_side if prev_side is not None else (d.cross(UP) if abs(d.dot(UP)) < 0.95 else d.cross(Vector((1, 0, 0))))
            side = (side - d * side.dot(d)).normalized()
            prev_side = side
            up = d.cross(side)
            ring = []
            for k in range(sides):
                a = k / sides * math.tau
                ring.append(self.bm.verts.new(p + (side * math.cos(a) + up * math.sin(a)) * radii[i]))
            rings.append(ring)
        verts = [v for r in rings for v in r]
        for i in range(len(rings) - 1):
            for k in range(sides):
                j = (k + 1) % sides
                f = self.bm.faces.new((rings[i][k], rings[i][j], rings[i + 1][j], rings[i + 1][k]))
                f.smooth = True
        if caps:
            self.bm.faces.new(rings[0][::-1])
            self.bm.faces.new(rings[-1])
        self._bind(verts, bone, mat)

    def long_bone(self, a, b, r, bone, knob0=1.7, knob1=1.6, mat=0):
        """Shaft with knobbly ends (epiphyses)."""
        a, b = Vector(a), Vector(b)
        d = b - a
        self.tube([a + d * 0.08, a + d * 0.3, a + d * 0.7, b - d * 0.08], [r * 1.25, r * 0.95, r * 0.95, r * 1.25], bone, mat)
        q = d.to_track_quat('Z', 'Y').to_matrix().to_4x4()
        self.blob(a + d * 0.05, (r * knob0, r * knob0 * 0.85, r * knob0 * 0.9), bone, mat, rot=q, subdiv=1)
        self.blob(b - d * 0.05, (r * knob1, r * knob1 * 0.85, r * knob1 * 0.9), bone, mat, rot=q, subdiv=1)

    # -------------------------------------------------------------- finish
    def build(self, name, materials, tile=0.18):
        bm = self.bm
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        uv = bm.loops.layers.uv.new('UVMap')
        for f in bm.faces:
            n = f.normal
            ax = max(range(3), key=lambda i: abs(n[i]))
            for l in f.loops:
                p = l.vert.co
                u, v = ((p.y, p.z), (p.x, p.z), (p.x, p.y))[ax]
                l[uv].uv = (u / tile, v / tile)
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        for m in materials:
            me.materials.append(m)
        obj = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(obj)
        for bone, gi in sorted(self.groups.items(), key=lambda kv: kv[1]):
            assert obj.vertex_groups.new(name=bone).index == gi
        obj.parent = self.rig
        mod = obj.modifiers.new('rig', 'ARMATURE')
        mod.object = self.rig
        return obj


def bone_material(tex_base, tint):
    m = bpy.data.materials.new('skeleton_bone')
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']

    def img(kind, colour):
        n = nt.nodes.new('ShaderNodeTexImage')
        n.image = bpy.data.images.load(f'{tex_base}_{kind}.jpg', check_existing=True)
        n.image.colorspace_settings.name = 'sRGB' if colour else 'Non-Color'
        return n
    d = img('diffuse', True)
    mix = nt.nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    mix.blend_type = 'MULTIPLY'
    mix.inputs['Factor'].default_value = 1
    mix.inputs['B'].default_value = (*tint, 1)
    nt.links.new(d.outputs['Color'], mix.inputs['A'])
    nt.links.new(mix.outputs['Result'], bsdf.inputs['Base Color'])
    n = img('nor_gl', False)
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(n.outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    a = img('arm', False)
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(a.outputs['Color'], sep.inputs['Color'])
    nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
    return m


def flat_material(name, colour, rough, emission=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*colour, 1)
    b.inputs['Roughness'].default_value = rough
    if emission:
        b.inputs['Emission Color'].default_value = (*emission, 1)
        b.inputs['Emission Strength'].default_value = 4.0
    return m


def build(rig, tex_base):
    B = Body(rig)
    BONE, DARK, GLOW = 0, 1, 2
    X = lambda v, s: Vector((v.x * s, v.y, v.z))  # noqa: E731  mirror helper

    # ---------------------------------------------------------- skull (head)
    h0 = B.head('head')
    sk = lambda x, y, z: h0 + Vector((x, y, z))  # noqa: E731  skull-local offsets
    B.blob(sk(0, 0.03, 0.0), (0.071, 0.092, 0.078), 'head')                       # cranium
    B.blob(sk(0, -0.03, -0.045), (0.056, 0.05, 0.045), 'head')                   # face
    for s in (-1, 1):
        B.blob(sk(s * 0.049, -0.035, -0.04), (0.022, 0.03, 0.016), 'head')       # cheekbones
        B.blob(sk(s * 0.03, -0.056, -0.006), (0.02, 0.012, 0.017), 'head', DARK)  # eye sockets
        B.blob(sk(s * 0.03, -0.066, -0.008), (0.0075, 0.005, 0.0075), 'head', GLOW, subdiv=1)
    B.blob(sk(0, -0.083, -0.042), (0.011, 0.01, 0.017), 'head', DARK)            # nasal cavity
    jaw = [sk(-0.052, 0.0, -0.05), sk(-0.048, -0.035, -0.095), sk(-0.026, -0.07, -0.104), sk(0, -0.078, -0.106),
           sk(0.026, -0.07, -0.104), sk(0.048, -0.035, -0.095), sk(0.052, 0.0, -0.05)]
    B.tube(jaw, [0.011, 0.014, 0.014, 0.015, 0.014, 0.014, 0.011], 'head')
    teeth = [sk(-0.034, -0.05, -0.081), sk(-0.02, -0.071, -0.083), sk(0, -0.077, -0.084), sk(0.02, -0.071, -0.083), sk(0.034, -0.05, -0.081)]
    B.tube(teeth, 0.0075, 'head', sides=6)

    # ---------------------------------------------------------- spine
    chain = [('pelvis', B.tail('pelvis')), ('spine_01', B.tail('spine_01')), ('spine_02', B.tail('spine_02')),
             ('spine_03', B.tail('spine_03')), ('spine_03', B.head('neck_01')), ('neck_01', B.tail('neck_01'))]
    start = B.head('pelvis') + Vector((0, 0.035, 0.07))
    for i, (bone, end) in enumerate(chain):
        seg_start = start if i == 0 else chain[i - 1][1]
        d = end - seg_start
        n = max(1, round(d.length / 0.03))
        for k in range(n):
            p = seg_start + d * ((k + 0.5) / n)
            neck = bone == 'neck_01'
            r = 0.013 if neck else 0.019
            q = d.to_track_quat('Z', 'Y').to_matrix().to_4x4()
            B.blob(p, (r, r * 0.85, 0.009), bone, rot=q, subdiv=1)
            B.blob(p + Vector((0, 0.022 if neck else 0.03, -0.004)), (0.006, 0.016 if neck else 0.022, 0.007), bone, subdiv=1)
            if not neck:
                for s in (-1, 1):
                    B.blob(p + Vector((s * 0.022, 0.012, 0)), (0.014, 0.006, 0.006), bone, subdiv=1)

    # ---------------------------------------------------------- ribcage and sternum
    top, bottom = 1.42, 1.17
    sy = B.tail('spine_02').y
    for k in range(10):
        t = k / 9
        z = top + (bottom - top) * t
        bone = 'spine_03' if z > B.tail('spine_02').z + 0.05 else 'spine_02'
        a = 0.075 + 0.06 * math.sin(min(1, t * 1.6) * math.pi / 2) - 0.012 * max(0, t - 0.7) / 0.3
        b = 0.085 + 0.02 * math.sin(t * math.pi)
        reach = 2.55 if k < 7 else 2.1 - (k - 7) * 0.25
        for s in (-1, 1):
            pts = []
            for i in range(11):
                th = 0.25 + (reach - 0.25) * i / 10
                drop = 0.06 * (th / math.pi) ** 1.4
                pts.append(Vector((s * a * math.sin(th), sy + 0.03 - b + b * math.cos(th), z - drop)))
            B.tube(pts, 0.0055 + 0.002 * math.sin(t * math.pi), bone, sides=5)
    B.blob(Vector((0, sy - 0.16, 1.33)), (0.016, 0.008, 0.085), 'spine_03', subdiv=1)

    # ---------------------------------------------------------- pelvis
    p0 = B.head('pelvis')
    for s in (-1, 1):
        B.blob(p0 + Vector((s * 0.088, 0.01, 0.045)), (0.07, 0.013, 0.055), 'pelvis', rot=Matrix.Rotation(s * 0.55, 4, 'Z') @ Matrix.Rotation(-0.25, 4, 'X'))
        B.blob(B.head(f'thigh_{"l" if s > 0 else "r"}') + Vector((-s * 0.015, 0.005, 0.02)), (0.024, 0.022, 0.026), 'pelvis', subdiv=1)
    B.blob(p0 + Vector((0, 0.045, 0.03)), (0.034, 0.02, 0.055), 'pelvis')
    B.tube([p0 + Vector((-0.1, -0.005, -0.03)), p0 + Vector((-0.05, -0.05, -0.065)), p0 + Vector((0, -0.06, -0.07)),
            p0 + Vector((0.05, -0.05, -0.065)), p0 + Vector((0.1, -0.005, -0.03))], 0.013, 'pelvis')

    for s in ('l', 'r'):
        sign = 1 if s == 'l' else -1
        # ------------------------------------------------------ shoulder girdle
        B.long_bone(B.head(f'clavicle_{s}'), B.tail(f'clavicle_{s}'), 0.007, f'clavicle_{s}', 1.6, 1.8)
        # ------------------------------------------------------ arm
        B.long_bone(B.head(f'upperarm_{s}'), B.tail(f'upperarm_{s}'), 0.012, f'upperarm_{s}', 2.0, 1.7)
        a, b = B.head(f'lowerarm_{s}'), B.tail(f'lowerarm_{s}')
        side = (b - a).cross(UP).normalized() * 0.008
        B.long_bone(a + side, b + side, 0.0065, f'lowerarm_{s}', 1.8, 1.5)
        B.long_bone(a - side, b - side, 0.006, f'lowerarm_{s}', 1.5, 1.8)
        # ------------------------------------------------------ hand
        hand = B.head(f'hand_{s}')
        B.blob(hand + (B.tail(f'hand_{s}') - hand) * 0.5, (0.02, 0.012, 0.016), f'hand_{s}', subdiv=1)
        for f in ('thumb', 'index', 'middle', 'ring', 'pinky'):
            j1 = B.head(f'{f}_01_{s}')
            base = hand + (j1 - hand) * (0.25 if f == 'thumb' else 0.35)
            B.tube([base, j1], [0.0045, 0.004], f'hand_{s}', sides=5)
            joints = [B.head(f'{f}_01_{s}'), B.head(f'{f}_02_{s}'), B.head(f'{f}_03_{s}'), B.tail(f'{f}_03_{s}')]
            for i in range(3):
                bone = f'{f}_0{i + 1}_{s}'
                r = 0.0042 - i * 0.0008
                B.tube([joints[i], joints[i + 1]], [r, r * 0.85], bone, sides=5)
                B.blob(joints[i], (r * 1.35, r * 1.35, r * 1.35), bone, subdiv=1)
        # ------------------------------------------------------ leg
        B.long_bone(B.head(f'thigh_{s}'), B.tail(f'thigh_{s}'), 0.016, f'thigh_{s}', 1.9, 1.9)
        B.blob(B.tail(f'thigh_{s}') + Vector((0, -0.035, 0.01)), (0.017, 0.009, 0.02), f'thigh_{s}', subdiv=1)  # kneecap
        a, b = B.head(f'calf_{s}'), B.tail(f'calf_{s}')
        B.long_bone(a, b, 0.014, f'calf_{s}', 2.0, 1.4)
        B.long_bone(a + Vector((sign * 0.025, 0.01, -0.03)), b + Vector((sign * 0.02, 0.008, 0.01)), 0.006, f'calf_{s}', 1.6, 2.0)
        # ------------------------------------------------------ foot
        f0, f1, toe = B.head(f'foot_{s}'), B.tail(f'foot_{s}'), B.tail(f'ball_{s}')
        B.blob(f0 + Vector((0, 0.012, -0.03)), (0.022, 0.035, 0.022), f'foot_{s}', subdiv=1)  # heel
        B.blob(f0 + (f1 - f0) * 0.35 + Vector((0, 0, -0.01)), (0.026, 0.035, 0.018), f'foot_{s}', subdiv=1)
        for i in range(5):
            o = Vector((sign * (-0.022 + i * 0.012), 0, 0))
            B.tube([f0 + (f1 - f0) * 0.45 + o * 0.6, f1 + o], [0.0055, 0.0045], f'foot_{s}', sides=5)
            B.tube([f1 + o, toe + o * 1.1 + Vector((0, 0.012 * i / 4, -0.004))], [0.0045, 0.0035], f'ball_{s}', sides=5)

    mats = [bone_material(tex_base, (0.86, 0.8, 0.66)), flat_material('skeleton_dark', (0.015, 0.012, 0.01), 0.9),
            flat_material('skeleton_glow', (0.0, 0.0, 0.0), 0.5, emission=(1.0, 0.35, 0.1))]
    obj = B.build('skeleton_body', mats)
    print('[build] bone body', len(obj.data.polygons), 'faces,', len(obj.vertex_groups), 'bones', flush=True)
    return obj
