# World props

`build_props.py` (Blender, headless) builds `public/models/props.glb` and `public/models/low/props.glb`:

- **Poly Haven models** (CC0): barrels, crates, bucket, lantern, spinning wheel, stool, fire pit,
  chest, log, axe, kite shield and the moss rock sets. They are decimated to a triangle budget;
  small props get 512 px textures.
- **Ruins**: pieces of Poly Haven's `modular_fort_01` with their tops crumbled by a boolean cut
  against a noisy, blocky break line (`cut_top`), plus columns and a two-step dais.
- **Village**: half-timbered houses (stone plinth, plastered walls, timber frame with braces,
  doors, shuttered windows, thatch or slate roofs, chimneys), a well and a rail fence, built
  from boxes and prisms with box-projected UVs and Poly Haven textures.
- **Camp**: A-frame hessian tents with poles and guy ropes.

Every asset is one top-level node: origin at the centre of its footprint, ground at y = 0,
front facing +Z. `src/game/props.ts` loads the file and places copies (or InstancedMeshes).

```bash
node tools/props/fetch_polyhaven.mjs 1k <model ids...> texture:<texture ids...>   # see CREDITS.md
tools/props/build.sh
```

Downloads go to `../Web3DRPG-tools/polyhaven` (override with `WEB3DRPG_TOOLS`).
