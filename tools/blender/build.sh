#!/usr/bin/env bash
# Builds every character in tools/blender/characters into public/models.
# Requires the portable Blender + MPFB2 setup described in tools/blender/README.md.
set -euo pipefail
cd "$(dirname "$0")/../.."
TOOLS="${WEB3DRPG_TOOLS:-../Web3DRPG-tools}"
BLENDER="$TOOLS/blender-5.2.2-windows-x64/blender.exe"
UAL="$TOOLS/ual/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb"
mkdir -p "$TOOLS/raw" public/models
for cfg in tools/blender/characters/${1:-*}.json; do
  name=$(basename "$cfg" .json)
  echo "== $name"
  "$BLENDER" -b --factory-startup -P tools/blender/build_character.py -- "$cfg" "$TOOLS/raw/$name.glb" "$UAL" 2>&1 | grep -E "\[build\]|Error|Traceback" || true
  npx gltf-transform optimize "$TOOLS/raw/$name.glb" "public/models/$name.glb" \
    --compress meshopt --texture-compress webp --texture-size 1024 --simplify false
done
