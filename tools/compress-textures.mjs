// Converts downloaded Poly Haven JPGs in public/textures/<res>/ to WebP in place.
import { readdir, unlink } from 'node:fs/promises';
import sharp from 'sharp';

for (const res of ['1k', '2k']) {
  const dir = `public/textures/${res}`;
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.jpg')) continue;
    const quality = file.includes('nor') ? 85 : 80;
    await sharp(`${dir}/${file}`).webp({ quality }).toFile(`${dir}/${file.replace('.jpg', '.webp')}`);
    await unlink(`${dir}/${file}`);
  }
}
