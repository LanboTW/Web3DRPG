// Downloads Poly Haven (CC0) glTF models and textures into the tools folder.
// usage: node tools/props/fetch_polyhaven.mjs <res> <model|texture:id> ...
import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const OUT = process.env.WEB3DRPG_TOOLS ?? join(import.meta.dirname, '../../../Web3DRPG-tools');
const [res, ...ids] = process.argv.slice(2);

async function get(url, path) {
  try { await access(path); return; } catch { /* missing */ }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(await r.arrayBuffer()));
}

for (const spec of ids) {
  const [kind, id] = spec.includes(':') ? spec.split(':') : ['model', spec];
  const files = await (await fetch(`https://api.polyhaven.com/files/${id}`)).json();
  const dir = join(OUT, 'polyhaven', id);
  if (kind === 'model') {
    const g = files.gltf[res].gltf;
    await get(g.url, join(dir, `${id}.gltf`));
    for (const [rel, f] of Object.entries(g.include ?? {})) await get(f.url, join(dir, rel));
  } else {
    // Texture set: diffuse, GL normal, ARM (AO/rough/metal) as JPG.
    for (const map of ['Diffuse', 'nor_gl', 'arm', 'Displacement']) {
      const f = files[map]?.[res]?.jpg ?? files[map]?.[res]?.png;
      if (f) await get(f.url, join(dir, `${id}_${map.toLowerCase()}.${f.url.split('.').pop()}`));
    }
  }
  console.log('ok', id);
}
