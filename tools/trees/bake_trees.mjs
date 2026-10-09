// Bakes ez-tree (MIT, Daniel Greenheck) presets into one binary the game streams in.
// Usage: node tools/trees/bake_trees.mjs [path to ez-tree package]
// Writes public/models/trees.bin + trees.json and copies the bark/leaf textures
// (WebP, two sizes) to public/textures/trees/.
//
// ez-tree's own materials are WebGL-only (onBeforeCompile), so only its branch and
// leaf geometry generator is used; the game shades and animates the result in TSL.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '../..');
const pkg = path.resolve(process.argv[2] ?? path.join(root, '../Web3DRPG-tools/package'));
const threeUrl = pathToFileURL(path.join(root, 'node_modules/three/build/three.module.js')).href;

// The prebuilt library imports bare "three"; point it at this repo's copy.
const tmp = path.join(root, 'node_modules/.cache/ez-tree.mjs');
fs.mkdirSync(path.dirname(tmp), { recursive: true });
fs.writeFileSync(tmp, fs.readFileSync(path.join(pkg, 'build/ez-tree.es.js'), 'utf8').replace(/from\s*"three"/g, `from "${threeUrl}"`));
// Its texture table loads images at import time; give it inert elements.
globalThis.document = { createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, style: {} }) };
const THREE = await import(threeUrl);
const { Tree } = await import(pathToFileURL(tmp).href);

/** Keeps the raw arrays instead of building WebGL meshes and loading textures. */
class Generator extends Tree {
  createBranchesGeometry() {}
  createLeavesGeometry() {}
  createTrellis() {}
}

const preset = (name) => JSON.parse(fs.readFileSync(path.join(pkg, `src/lib/presets/${name}.json`), 'utf8'));

// [name, preset, seed, height (m), tweaks] — tweaks trim triangle counts for the web.
const VARIANTS = [
  ['pine_a', 'pine_large', 44166, 17, (o) => { o.branch.children[0] = 64; o.leaves.count = 22; o.leaves.size *= 1.35; o.branch.radius[1] *= 0.6; }],
  ['pine_b', 'pine_medium', 7311, 13, (o) => { o.leaves.count = 20; o.leaves.size *= 1.35; o.branch.radius[1] *= 0.6; }],
  ['oak_a', 'oak_large', 23399, 12, (o) => { o.branch.children[0] = 7; o.branch.segments[1] = 4; o.leaves.count = 7; o.branch.sections[3] = 2; }],
  ['oak_b', 'oak_medium', 9182, 10, (o) => { o.branch.segments[1] = Math.min(o.branch.segments[1], 4); o.leaves.count = Math.min(o.leaves.count, 7); }],
  ['ash_a', 'ash_large', 5521, 11, (o) => { o.branch.segments[1] = Math.min(o.branch.segments[1], 4); o.leaves.count = Math.min(o.leaves.count, 8); }],
  ['bush_a', 'bush_1', 45590, 1.7, (o) => { o.branch.segments[0] = 3; o.leaves.count = 9; }],
  ['bush_b', 'bush_2', 1203, 1.4, (o) => { o.branch.segments[0] = 3; }],
];

const chunks = [];
let offset = 0;
function push(typed) {
  const pad = (4 - (offset % 4)) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
  const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  chunks.push(buf);
  const at = offset;
  offset += buf.length;
  return at;
}

const header = { variants: [] };
for (const [name, presetName, seed, height, tweak] of VARIANTS) {
  const opts = preset(presetName);
  opts.seed = seed;
  tweak(opts);
  // Thin twigs read as lines from a few metres away: fewer rings and sides.
  for (let lvl = 1; lvl <= 3; lvl++) {
    opts.branch.segments[lvl] = Math.min(opts.branch.segments[lvl], lvl === 1 ? 4 : 3);
    opts.branch.sections[lvl] = Math.min(opts.branch.sections[lvl], [0, 5, 3, 2][lvl]);
  }
  const tree = new Generator();
  tree.loadFromJson(opts);
  const b = tree.branches;
  const l = tree.leaves;

  // Normalise to metres, trunk base at the origin.
  let maxY = 0, maxR = 0;
  for (const v of [b.verts, l.verts]) {
    for (let i = 0; i < v.length; i += 3) {
      maxY = Math.max(maxY, v[i + 1]);
      maxR = Math.max(maxR, Math.hypot(v[i], v[i + 2]));
    }
  }
  const s = height / maxY;
  const bPos = Float32Array.from(b.verts, (x) => x * s);
  const lPos = Float32Array.from(l.verts, (x) => x * s);

  // Foliage normals bent outward from the crown centre so the canopy shades as
  // one volume; inner leaves get darker occlusion.
  const box = new THREE.Box3().setFromArray(lPos);
  const centre = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const crown = new THREE.Vector3(size.x / 2, size.y / 2, size.z / 2);
  const lNor = new Float32Array(lPos.length);
  const lAo = new Float32Array(lPos.length / 3);
  const faceN = new THREE.Vector3(), out = new THREE.Vector3(), p = new THREE.Vector3();
  for (let i = 0; i < lPos.length / 3; i++) {
    p.fromArray(lPos, i * 3);
    out.copy(p).sub(centre).divide(crown);
    const depth = Math.min(1, out.length());
    out.normalize();
    faceN.fromArray(l.normals, i * 3).normalize();
    if (faceN.dot(out) < 0) faceN.negate();
    faceN.lerp(out, 0.75).normalize().toArray(lNor, i * 3);
    lAo[i] = 0.45 + 0.55 * depth;
  }
  // Leaf "height along the twig" for flutter (uv.y of the quad) is the leaf uv.
  const bIdx = b.verts.length / 3 > 65535 ? Uint32Array.from(b.indices) : Uint16Array.from(b.indices);
  const lIdx = l.verts.length / 3 > 65535 ? Uint32Array.from(l.indices) : Uint16Array.from(l.indices);

  const v = {
    name,
    bark: opts.bark.type,
    leaf: opts.leaves.type,
    barkTint: opts.bark.tint,
    leafTint: opts.leaves.tint,
    barkRepeat: [opts.bark.textureScale.x, opts.bark.textureScale.y],
    alphaTest: opts.leaves.alphaTest,
    height,
    radius: Math.max(box.max.x, -box.min.x, box.max.z, -box.min.z),
    branches: {
      vertices: b.verts.length / 3,
      indices: bIdx.length,
      index32: bIdx instanceof Uint32Array,
      position: push(bPos),
      normal: push(Float32Array.from(b.normals)),
      uv: push(Float32Array.from(b.uvs)),
      index: push(bIdx),
    },
    leaves: {
      vertices: l.verts.length / 3,
      indices: lIdx.length,
      index32: lIdx instanceof Uint32Array,
      position: push(lPos),
      normal: push(lNor),
      uv: push(Float32Array.from(l.uvs)),
      ao: push(lAo),
      index: push(lIdx),
    },
  };
  header.variants.push(v);
  console.log(`${name}: ${v.branches.indices / 3} branch tris, ${v.leaves.indices / 3} leaf tris, h=${height} r=${v.radius.toFixed(1)} (raw height ${maxY.toFixed(1)}, raw r ${maxR.toFixed(1)})`);
}

const models = path.join(root, 'public/models');
fs.writeFileSync(path.join(models, 'trees.bin'), Buffer.concat(chunks));
fs.writeFileSync(path.join(models, 'trees.json'), JSON.stringify(header));
console.log(`trees.bin ${(offset / 1024).toFixed(0)} KB`);

// Textures: leaves keep alpha; bark colour + normal.
const tex = path.join(root, 'public/textures/trees');
fs.mkdirSync(tex, { recursive: true });
const assets = path.join(pkg, 'src/lib/assets');
const leaves = [...new Set(header.variants.map((v) => v.leaf))];
const barks = [...new Set(header.variants.map((v) => v.bark))];
for (const [size, suffix] of [[1024, ''], [512, '_low']]) {
  for (const leaf of leaves) {
    await sharp(path.join(assets, `leaves/${leaf}_color.png`)).resize(size, size).webp({ quality: 88, alphaQuality: 90 })
      .toFile(path.join(tex, `${leaf}_leaves${suffix}.webp`));
  }
  for (const bark of barks) {
    for (const map of ['color', 'normal']) {
      await sharp(path.join(assets, `bark/${bark}_${map}_1k.jpg`)).resize(size, size).webp({ quality: map === 'normal' ? 92 : 85 })
        .toFile(path.join(tex, `${bark}_bark_${map}${suffix}.webp`));
    }
  }
}
console.log('textures:', fs.readdirSync(tex).join(', '));
