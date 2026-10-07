"""
Builds a game-ready character with MPFB2 inside headless Blender and exports glTF.

Usage:
  blender -b --factory-startup -P tools/blender/build_character.py -- <character.json> <out.glb> <ual.glb> [mixamo dir]

The character JSON describes body macros, skin, hair and clothes by MakeHuman
asset name. Animations come from the Quaternius Universal Animation Library
("UAL_Name") or from Mixamo FBX downloads ("mixamo:<file stem>[@start-end]") and
are retargeted onto MPFB's "game_engine" rig.
"""
import json
import math
import os
import sys

import addon_utils
import bpy
from mathutils import Matrix, Vector

addon_utils.enable('bl_ext.user_default.mpfb', default_set=True)
from bl_ext.user_default.mpfb.services.humanservice import HumanService  # noqa: E402
from bl_ext.user_default.mpfb.services.locationservice import LocationService  # noqa: E402
from bl_ext.user_default.mpfb.services.objectservice import ObjectService  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:]
CONFIG_PATH, OUT_PATH, UAL_PATH = argv[0], argv[1], argv[2]
MIXAMO_DIR = argv[3] if len(argv) > 3 else ""
with open(CONFIG_PATH, encoding='utf-8') as f:
    CFG = json.load(f)

DATA = LocationService.get_user_data()


def asset_file(kind, name, ext):
    path = os.path.join(DATA, kind, name, f'{name}.{ext}')
    if not os.path.exists(path):
        # Some packs name the file differently from the folder; take the first match.
        folder = os.path.join(DATA, kind, name)
        for fn in os.listdir(folder):
            if fn.endswith('.' + ext):
                return os.path.join(folder, fn)
        raise FileNotFoundError(path)
    return path


def log(*a):
    print('[build]', *a, flush=True)


# ------------------------------------------------------------------ human
bpy.ops.wm.read_factory_settings(use_empty=True)

macros = {
    'gender': 0.5, 'age': 0.5, 'muscle': 0.5, 'weight': 0.5, 'proportions': 0.5,
    'height': 0.5, 'cupsize': 0.5, 'firmness': 0.5,
    'race': {'asian': 0.33, 'caucasian': 0.33, 'african': 0.33},
}
macros.update({k: v for k, v in CFG.get('macros', {}).items() if k != 'race'})
macros['race'].update(CFG.get('macros', {}).get('race', {}))
basemesh = HumanService.create_human(macro_detail_dict=macros, scale=0.1, feet_on_ground=True)
log('human created', basemesh.name)

HumanService.add_builtin_rig(basemesh, 'game_engine')
rig = ObjectService.find_object_of_type_amongst_nearest_relatives(basemesh, 'Skeleton')
log('rig', rig.name, len(rig.data.bones))

skin_type = CFG.get('skinType', 'GAMEENGINE')
HumanService.set_character_skin(asset_file('skins', CFG['skin'], 'mhmat'), basemesh, skin_type=skin_type)

for kind, asset_type in [('eyes', 'Eyes'), ('eyebrows', 'Eyebrows'), ('eyelashes', 'Eyelashes'), ('hair', 'Hair')]:
    name = CFG.get(kind)
    if not name:
        continue
    if kind == 'eyes':
        mhclo = os.path.join(DATA, 'eyes', name, f'{name}.mhclo')
    else:
        mhclo = asset_file(kind, name, 'mhclo')
    HumanService.add_mhclo_asset(mhclo, basemesh, asset_type=asset_type, subdiv_levels=0, material_type='MAKESKIN')
    log('added', kind, name)

for name in CFG.get('clothes', []):
    HumanService.add_mhclo_asset(asset_file('clothes', name, 'mhclo'), basemesh, asset_type='Clothes',
                                 subdiv_levels=0, material_type='MAKESKIN')
    log('added clothes', name)

# ------------------------------------------------------------------ retarget
# Sources are T-posed (UAL, Mixamo) while MPFB rests in an A-pose with bent
# forearms. Each target bone is therefore first aligned to the source's rest
# frame (bone direction + a reference axis), then driven by the source bone's
# world-space rotation:
#   dst_world = src_world @ src_rest^-1 @ align @ dst_rest
scene = bpy.context.scene
scene.render.fps = 30  # Mixamo is 30 fps; glTF clips are imported in seconds.

SIDES = (('l', 'Left'), ('r', 'Right'))
FINGERS = ('thumb', 'index', 'middle', 'ring', 'pinky')
MIXAMO_MAP = {'pelvis': 'Hips', 'spine_01': 'Spine', 'spine_02': 'Spine1', 'spine_03': 'Spine2', 'neck_01': 'Neck', 'head': 'Head'}
for s, S in SIDES:
    MIXAMO_MAP.update({f'clavicle_{s}': f'{S}Shoulder', f'upperarm_{s}': f'{S}Arm', f'lowerarm_{s}': f'{S}ForeArm',
                       f'hand_{s}': f'{S}Hand', f'thigh_{s}': f'{S}UpLeg', f'calf_{s}': f'{S}Leg',
                       f'foot_{s}': f'{S}Foot', f'ball_{s}': f'{S}ToeBase'})
    for f in FINGERS:
        for i in (1, 2, 3):
            MIXAMO_MAP[f'{f}_0{i}_{s}'] = f'{S}Hand{f.capitalize()}{i}'
MIXAMO_MAP = {k: 'mixamorig:' + v for k, v in MIXAMO_MAP.items()}

# The bone whose head each bone points at (canonical MPFB names).
NEXT = {'spine_01': 'spine_02', 'spine_02': 'spine_03', 'spine_03': 'neck_01', 'neck_01': 'head'}
for s, _ in SIDES:
    NEXT.update({f'clavicle_{s}': f'upperarm_{s}', f'upperarm_{s}': f'lowerarm_{s}', f'lowerarm_{s}': f'hand_{s}',
                 f'hand_{s}': f'middle_01_{s}', f'thigh_{s}': f'calf_{s}', f'calf_{s}': f'foot_{s}', f'foot_{s}': f'ball_{s}'})
    for f in FINGERS:
        NEXT[f'{f}_01_{s}'] = f'{f}_02_{s}'
        NEXT[f'{f}_02_{s}'] = f'{f}_03_{s}'
NO_ALIGN = {'Root', 'pelvis'}
FINGER_BONES = {f'{f}_0{i}_{s}' for f in FINGERS for i in (1, 2, 3) for s, _ in SIDES}


def rest_world(arm, bone_name):
    return arm.matrix_world @ arm.data.bones[bone_name].matrix_local


def rot3(m):
    return m.to_3x3().normalized()


def frame(primary, secondary):
    y = primary.normalized()
    x = (secondary - y * secondary.dot(y)).normalized()
    z = x.cross(y)
    return Matrix((x, y, z)).transposed()


class Source:
    """A source armature plus the per-bone offsets that map it onto `rig`."""

    def __init__(self, arm, mapping):
        self.arm = arm
        self.map = {d: s for d, s in mapping.items() if s in arm.data.bones and d in rig.data.bones}
        heads = {d: rest_world(arm, s).translation for d, s in self.map.items()}
        dst_heads = {b.name: rest_world(rig, b.name).translation for b in rig.data.bones}

        def axes(name, arm_, bone, hd):
            nxt = NEXT.get(name)
            primary = (hd[nxt] - hd[name]) if nxt in hd else rot3(rest_world(arm_, bone)).col[1]
            side = name[-1] if name[-2:] in ('_l', '_r') else None
            arm_chain = side and not name.startswith(('thigh', 'calf', 'foot', 'ball'))
            if arm_chain and f'index_01_{side}' in hd and f'pinky_01_{side}' in hd:
                secondary = hd[f'pinky_01_{side}'] - hd[f'index_01_{side}']
            else:
                secondary = Vector((1, 0, 0))
            return frame(primary, secondary)

        self.offset = {}
        for d, s in self.map.items():
            src_rest = rot3(rest_world(arm, s))
            dst_rest = rot3(rest_world(rig, d))
            if d in NO_ALIGN:
                align = Matrix.Identity(3)
            else:
                align = axes(d, arm, s, heads) @ axes(d, rig, d, dst_heads).transposed()
            self.offset[d] = (src_rest.inverted() @ align @ dst_rest).to_quaternion()
        src_pelvis = rest_world(arm, self.map['pelvis']).translation.z
        self.height_ratio = rest_world(rig, 'pelvis').translation.z / src_pelvis
        arm.animation_data_create()
        log('source', arm.name, 'mapped', len(self.map), 'of', len(rig.data.bones), 'height ratio', round(self.height_ratio, 3))

    def use(self, action):
        self.arm.animation_data.action = action
        if hasattr(action, 'slots') and len(action.slots):
            self.arm.animation_data.action_slot = action.slots[0]


def import_objects(op, **kw):
    before_o, before_a = set(bpy.data.objects), set(bpy.data.actions)
    op(**kw)
    return set(bpy.data.objects) - before_o, set(bpy.data.actions) - before_a


temp_objs = set()
sources = {}

# UAL: one glTF holding every clip; bone names match MPFB's case-insensitively.
objs, _ = import_objects(bpy.ops.import_scene.gltf, filepath=UAL_PATH)
temp_objs |= objs
ual_rig = next(o for o in objs if o.type == 'ARMATURE')
ual_names = {b.name.lower(): b.name for b in ual_rig.data.bones}
sources['ual'] = Source(ual_rig, {b.name: ual_names[b.name.lower()] for b in rig.data.bones if b.name.lower() in ual_names})
ual_rig.animation_data_create()
for t in ual_rig.animation_data.nla_tracks:
    t.mute = True  # the importer stashes clips as NLA tracks that would override the active action

wanted = CFG.get('animations')  # {exportName: UALActionName | "mixamo:<file stem>[@start-end]"}
if any(v.startswith('mixamo:') for v in wanted.values()):
    objs, _ = import_objects(bpy.ops.import_scene.fbx, filepath=os.path.join(MIXAMO_DIR, 'X Bot.fbx'))
    temp_objs |= objs
    sources['mixamo'] = Source(next(o for o in objs if o.type == 'ARMATURE'), MIXAMO_MAP)


def resolve(spec):
    """Returns (source, action, first frame, last frame) for an animation spec."""
    if not spec.startswith('mixamo:'):
        action = bpy.data.actions.get(spec)
        if action is None:
            return None
        return sources['ual'], action, int(action.frame_range[0]), int(action.frame_range[1])
    stem, _, rng = spec[len('mixamo:'):].partition('@')
    objs, acts = import_objects(bpy.ops.import_scene.fbx, filepath=os.path.join(MIXAMO_DIR, stem + '.fbx'))
    for o in objs:
        bpy.data.objects.remove(o, do_unlink=True)
    action = next(iter(acts))
    f0, f1 = int(action.frame_range[0]), int(action.frame_range[1])
    if rng:
        a, b = rng.split('-')
        f0, f1 = int(a), int(b)
    return sources['mixamo'], action, f0, f1


# Order target bones parent-first so parents are posed before children.
ordered = []
def walk(b):
    ordered.append(b)
    for c in b.children:
        walk(c)
for b in rig.data.bones:
    if b.parent is None:
        walk(b)

rig.animation_data_create()
for pb in rig.pose.bones:
    pb.rotation_mode = 'QUATERNION'  # we key rotation_quaternion below

# Hands hold a sword and a shield in every clip: copy the finger pose of a
# reference clip (first frame) onto all clips so grips never open up.
grip_ref = CFG.get('gripFrom')
grip_sides = tuple(CFG.get('gripHands', []))
grip_pose = {}
order = list(wanted.items())
if grip_ref:
    order.sort(key=lambda kv: kv[0] != grip_ref)

baked = []
for export_name, spec in order:
    found = resolve(spec)
    if found is None:
        log('MISSING action', spec)
        continue
    src, action, f0, f1 = found
    src.use(action)
    new_action = bpy.data.actions.new(export_name)
    rig.animation_data.action = new_action
    for frame_no in range(f0, f1 + 1):
        scene.frame_set(frame_no)
        dst_world = {}
        for b in ordered:
            pb = rig.pose.bones[b.name]
            parent_world = dst_world[b.parent.name] if b.parent else rig.matrix_world
            local_rest = (b.parent.matrix_local.inverted() @ b.matrix_local) if b.parent else b.matrix_local
            if b.name in src.map:
                spb = src.arm.pose.bones[src.map[b.name]]
                src_world = src.arm.matrix_world @ spb.matrix
                rot = (rot3(src_world).to_quaternion() @ src.offset[b.name]).to_matrix().to_4x4()
                if b.name == 'pelvis':
                    t = src_world.translation * src.height_ratio
                else:
                    t = (parent_world @ local_rest).translation
                world = Matrix.Translation(t) @ rot
            else:
                world = parent_world @ local_rest
            dst_world[b.name] = world
            pb.matrix = rig.matrix_world.inverted() @ world
            bpy.context.view_layer.update()
        for b in ordered:
            pb = rig.pose.bones[b.name]
            if b.name in FINGER_BONES and b.name[-1] in grip_sides:
                if export_name == grip_ref and frame_no == f0:
                    grip_pose[b.name] = pb.rotation_quaternion.copy()
                if b.name in grip_pose:
                    pb.rotation_quaternion = grip_pose[b.name]
            pb.keyframe_insert('rotation_quaternion', frame=frame_no - f0)
            if b.name == 'pelvis':
                pb.keyframe_insert('location', frame=frame_no - f0)
    track = rig.animation_data.nla_tracks.new()
    track.name = export_name
    track.strips.new(export_name, 0, new_action)
    track.mute = True  # keep earlier bakes from influencing later ones
    rig.animation_data.action = None
    baked.append(export_name)
    log('baked', export_name, f1 - f0 + 1, 'frames from', spec)

for t in rig.animation_data.nla_tracks:
    t.mute = False
for o in temp_objs:
    if o.name in bpy.data.objects:
        bpy.data.objects.remove(o, do_unlink=True)
for b in rig.pose.bones:
    b.matrix_basis = Matrix.Identity(4)

# ------------------------------------------------------------------ export prep
# Apply MPFB's helper-masking modifiers so the exported mesh is clean.
for obj in [o for o in bpy.data.objects if o.type == 'MESH']:
    bpy.context.view_layer.objects.active = obj
    # Bake the body-shape targets (shape keys) into the mesh so modifiers can be applied.
    if obj.data.shape_keys:
        mixed = obj.shape_key_add(name='mixed', from_mix=True)
        for key in list(obj.data.shape_keys.key_blocks):
            if key.name != mixed.name:
                obj.shape_key_remove(key)
        obj.shape_key_remove(obj.data.shape_keys.key_blocks[0])
    for mod in list(obj.modifiers):
        if mod.type in ('MASK', 'SUBSURF'):
            try:
                bpy.ops.object.modifier_apply(modifier=mod.name)
            except RuntimeError as e:
                log('modifier apply failed', obj.name, mod.name, e)
    log('mesh', obj.name, len(obj.data.polygons), 'faces', [m.name for m in obj.material_slots])

bpy.ops.export_scene.gltf(
    filepath=OUT_PATH,
    export_format='GLB',
    export_animations=True,
    export_animation_mode='NLA_TRACKS',
    export_apply=True,
    export_yup=True,
    export_skins=True,
    export_morph=False,
    export_image_format='AUTO',
)
log('exported', OUT_PATH, 'animations', baked)
