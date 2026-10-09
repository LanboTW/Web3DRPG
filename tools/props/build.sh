#!/usr/bin/env bash
# Builds public/models/props.glb (+ low/) from Poly Haven downloads.
# 1. node tools/props/fetch_polyhaven.mjs 1k <assets...>   (see README)
# 2. tools/props/build.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
TOOLS="$(cd "${WEB3DRPG_TOOLS:-../Web3DRPG-tools}" && pwd -W 2>/dev/null || pwd)"
BLENDER="$TOOLS/blender-5.2.2-windows-x64/blender.exe"
mkdir -p "$TOOLS/raw" public/models/low
"$BLENDER" -b --factory-startup -P tools/props/build_props.py -- "$TOOLS/polyhaven" "$TOOLS/raw/props.glb" 2>&1 | grep -E "\[props\]|Error|Traceback" || true
for tier in low:512 :1024; do
  npx gltf-transform optimize "$TOOLS/raw/props.glb" "public/models/${tier%%:*}/props.glb" \
    --compress meshopt --texture-compress webp --texture-size "${tier##*:}" \
    --simplify false --join false --instance false --flatten false --palette false
done
ls -la public/models/props.glb public/models/low/props.glb
