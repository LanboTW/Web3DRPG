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

## Build
```bash
tools/blender/build.sh            # all characters
tools/blender/build.sh heroine    # one character
```
Each `characters/<name>.json` picks body macros, skin, hair, clothes (by MakeHuman
asset folder name) and which UAL clips to bake under which in-game name.

Animations are retargeted onto MPFB's `game_engine` rig (same bone names as UAL)
by transferring each bone's world-space rotation delta from rest pose.
