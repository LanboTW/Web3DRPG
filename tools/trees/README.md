# Trees

`bake_trees.mjs` turns [ez-tree](https://github.com/dgreenheck/ez-tree) (MIT) presets into
`public/models/trees.bin` + `trees.json` (positions, normals, uvs and indices per variant;
leaves also get crown-bent normals and an occlusion term) and copies the bark/leaf
textures to `public/textures/trees/` as WebP (1024 and `_low` 512).

```bash
npm pack @dgreenheck/ez-tree   # then unzip to ../Web3DRPG-tools/package
node tools/trees/bake_trees.mjs [path to the unpacked package]
```

Only ez-tree's geometry generator is used; its WebGL materials are skipped. In the game
(`src/game/vegetation.ts`) each variant becomes two instanced meshes (bark, leaves) with
TSL wind for trees near the camera, and an impostor for trees further away: eight views
of the tree rendered at load time into an albedo and a normal atlas, drawn on a
camera-facing card and lit like everything else.
