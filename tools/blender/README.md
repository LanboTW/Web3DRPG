# Character pipeline

Characters are generated headlessly with Blender + MPFB2 and exported to
`public/models/<name>.glb` (meshopt-compressed, WebP textures).

## One-time setup (Windows)
Everything lives in a sibling folder `../Web3DRPG-tools` (override with `WEB3DRPG_TOOLS`):

1. Portable Blender 5.2: extract `blender-5.2.2-windows-x64.zip` from download.blender.org.
2. MPFB2 2.0.17 from extensions.blender.org:
   `blender -b --factory-startup -c extension install-file -r user_default --enable add-on-mpfb-v2.0.17.zip`
3. MakeHuman CC0 asset packs (`makehuman_system_assets`, `skins01`, `hair01`, `shoes01`,
   `pants01`, `shirts01`) from https://static.makehumancommunity.org/assets/assetpacks.html,
   unzipped into MPFB's user data folder
   (`%APPDATA%/Blender Foundation/Blender/5.2/extensions/.user/user_default/mpfb/data`).
4. Quaternius Universal Animation Library (Standard) unzipped into `../Web3DRPG-tools/ual`.
5. Mixamo "Sword And Shield Pack" (FBX, With Skin, 30 fps) downloaded with your own Adobe account and
   unzipped into `../Web3DRPG-tools/mixamo`. Mixamo files may not be redistributed, so the raw FBX
   files never go into this repo; only the baked, retargeted GLBs do.

## Build
```bash
tools/blender/build.sh            # all characters
tools/blender/build.sh heroine    # one character
```
Each `characters/<name>.json` picks body macros, skin, hair, clothes (by MakeHuman
asset folder name) and which clips to bake under which in-game name: a UAL action
name, or `mixamo:<fbx file stem>[@first-last]` for a Mixamo download.
`gripFrom` + `gripHands` copy the finger pose of one clip onto every clip so hands
holding a sword and shield never open up.

Animations are retargeted onto MPFB's `game_engine` rig. UAL and Mixamo rest in a
T-pose while MPFB rests in an A-pose, so each bone is first aligned to the source's
rest frame (bone direction plus the palm's index-to-pinky axis for arms and fingers,
world X elsewhere) and then follows the source bone's world-space rotation.

`tools/contact-sheet.mjs` stitches frame renders into labelled sheets for reviewing
clips by eye.
