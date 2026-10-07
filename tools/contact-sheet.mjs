// Stitches <dir>/<name>_<i>.png frame renders into labelled contact sheets.
// Usage: node tools/contact-sheet.mjs <dir> <out-prefix> [rowsPerSheet] [name-filter-regex]
import sharp from 'sharp';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const [dir, outPrefix, rowsArg = '8', filter = '.'] = process.argv.slice(2);
const rowsPer = Number(rowsArg);
const files = readdirSync(dir).filter((f) => /_\d+\.png$/.test(f));
const names = [...new Set(files.map((f) => f.replace(/_\d+\.png$/, '')))].filter((n) => new RegExp(filter).test(n)).sort();
const frames = Math.max(...files.map((f) => Number(f.match(/_(\d+)\.png$/)[1]))) + 1;
const meta = await sharp(join(dir, files[0])).metadata();
const W = meta.width, H = meta.height, LABEL = 22;

for (let s = 0; s * rowsPer < names.length; s++) {
  const rows = names.slice(s * rowsPer, (s + 1) * rowsPer);
  const composites = [];
  rows.forEach((name, r) => {
    const y = r * (H + LABEL);
    const svg = `<svg width="${W * frames}" height="${LABEL}"><rect width="100%" height="100%" fill="#222"/><text x="6" y="16" font-size="15" font-family="sans-serif" fill="#fff">${name}</text></svg>`;
    composites.push({ input: Buffer.from(svg), left: 0, top: y });
    for (let i = 0; i < frames; i++) {
      const f = join(dir, `${name}_${i}.png`);
      if (files.includes(`${name}_${i}.png`)) composites.push({ input: f, left: i * W, top: y + LABEL });
    }
  });
  const out = `${outPrefix}${s}.png`;
  await sharp({ create: { width: W * frames, height: rows.length * (H + LABEL), channels: 3, background: '#444' } })
    .composite(composites).png().toFile(out);
  console.log(out);
}
