"""
Builds a game-ready character with MPFB2 inside headless Blender and exports glTF.

Usage:
  blender -b --factory-startup -P tools/blender/build_character.py -- <character.json> <out.glb> <ual.glb>

The character JSON describes body macros, skin, hair and clothes by MakeHuman
asset name. Animations come from the Quaternius Universal Animation Library and
are retargeted onto MPFB's "game_engine" rig, whose bone names match UAL's.
"""
import json
import math
import os
import sys

import addon_utils
import bpy
from mathutils import Matrix

addon_utils.enable('bl_ext.user_default.mpfb', default_set=True)
from bl_ext.user_default.mpfb.services.humanservice import HumanService  # noqa: E402
from bl_ext.user_default.mpfb.services.locationservice import LocationService  # noqa: E402
from bl_ext.user_default.mpfb.services.objectservice import ObjectService  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:]
CONFIG_PATH, OUT_PATH, UAL_PATH = argv[0], argv[1], argv[2]
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
before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=UAL_PATH)
src_rig = next(o for o in set(bpy.data.objects) - before if o.type == 'ARMATURE')
src_objs = set(bpy.data.objects) - before
log('UAL rig', src_rig.name, 'actions', len(bpy.data.actions))

src_names = {b.name.lower(): b.name for b in src_rig.data.bones}
mapping = {b.name: src_names[b.name.lower()] for b in rig.data.bones if b.name.lower() in src_names}
log('mapped bones', len(mapping), 'of', len(rig.data.bones))

# Scale: compare pelvis heights at rest so root motion translates sensibly.
def rest_world(arm, bone_name):
    return arm.matrix_world @ arm.data.bones[bone_name].matrix_local

src_pelvis_h = rest_world(src_rig, mapping['pelvis']).translation.z
dst_pelvis_h = rest_world(rig, 'pelvis').translation.z
height_ratio = dst_pelvis_h / src_pelvis_h
log('pelvis heights', round(src_pelvis_h, 3), round(dst_pelvis_h, 3))

# Order target bones parent-first so parents are posed before children.
ordered = []
def walk(b):
    ordered.append(b)
    for c in b.children:
        walk(c)
for b in rig.data.bones:
    if b.parent is None:
        walk(b)

wanted = CFG.get('animations')  # {exportName: UALActionName}
src_rest = {n: rest_world(src_rig, mapping[n]) for n in mapping}
dst_rest = {b.name: rest_world(rig, b.name) for b in rig.data.bones}

rig.animation_data_create()
src_rig.animation_data_create()
for pb in rig.pose.bones:
    pb.rotation_mode = 'QUATERNION'  # we key rotation_quaternion below
# The importer stashes every clip as an NLA track; those would override the active action.
for t in src_rig.animation_data.nla_tracks:
    t.mute = True
scene = bpy.context.scene
baked = []
for export_name, ual_name in wanted.items():
    action = bpy.data.actions.get(ual_name)
    if action is None:
        log('MISSING action', ual_name)
        continue
    src_rig.animation_data.action = action
    if hasattr(action, 'slots') and len(action.slots):
        src_rig.animation_data.action_slot = action.slots[0]
    f0, f1 = int(action.frame_range[0]), int(action.frame_range[1])
    new_action = bpy.data.actions.new(export_name)
    rig.animation_data.action = new_action
    for frame in range(f0, f1 + 1):
        scene.frame_set(frame)
        # World-space delta from rest, transferred bone by bone:
        #   dst_world = src_world @ src_rest^-1 @ dst_rest   (rotation only)
        dst_world = {}
        for b in ordered:
            pb = rig.pose.bones[b.name]
            if b.name in mapping:
                spb = src_rig.pose.bones[mapping[b.name]]
                src_world = src_rig.matrix_world @ spb.matrix
                delta = src_world.to_quaternion() @ src_rest[b.name].to_quaternion().inverted()
                rot = (delta @ dst_rest[b.name].to_quaternion()).to_matrix().to_4x4()
                if b.name == 'pelvis':
                    t = src_world.translation.copy()
                    t.x *= height_ratio
                    t.y *= height_ratio
                    t.z *= height_ratio
                else:
                    parent_world = dst_world[b.parent.name] if b.parent else rig.matrix_world
                    rest_offset = (b.parent.matrix_local.inverted() @ b.matrix_local).translation if b.parent else b.matrix_local.translation
                    t = parent_world @ rest_offset
                world = Matrix.Translation(t) @ rot
            else:
                parent_world = dst_world[b.parent.name] if b.parent else rig.matrix_world
                local_rest = (b.parent.matrix_local.inverted() @ b.matrix_local) if b.parent else b.matrix_local
                world = parent_world @ local_rest
            dst_world[b.name] = world
            pb.matrix = rig.matrix_world.inverted() @ world
            bpy.context.view_layer.update()
        for b in ordered:
            pb = rig.pose.bones[b.name]
            pb.keyframe_insert('rotation_quaternion', frame=frame - f0)
            if b.name == 'pelvis':
                pb.keyframe_insert('location', frame=frame - f0)
    track = rig.animation_data.nla_tracks.new()
    track.name = export_name
    track.strips.new(export_name, 0, new_action)
    track.mute = True  # keep earlier bakes from influencing later ones
    rig.animation_data.action = None
    baked.append(export_name)
    log('baked', export_name, f1 - f0 + 1, 'frames')

for t in rig.animation_data.nla_tracks:
    t.mute = False
for o in src_objs:
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
