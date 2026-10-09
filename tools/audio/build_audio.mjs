// Converts the CC0 source sounds (see CREDITS.md) into small mp3 files in
// public/audio. Usage: node tools/audio/build_audio.mjs [sourceDir]
// sourceDir defaults to ../Web3DRPG-tools/audio (Kenney packs + oga/).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(process.argv[2] ?? '../Web3DRPG-tools/audio');
const OUT = resolve('public/audio');
const K_IMPACT = 'kenney_impact-sounds/Audio';
const K_RPG = 'kenney_rpg-audio/Audio';
const K_IFACE = 'kenney_interface-sounds/Audio';
const OGA = 'oga';

/** One-shots: [output name, source, peak dB, trim seconds]. Mono 64 kbps. */
const ONESHOTS = [
  ...[3, 4, 7, 9, 6].map((n, i) => [`swing_${i}`, `${OGA}/swishes/swishes/swish-${n}.wav`, -3]),
  ['swing_heavy', `${OGA}/rpg_sound_pack/RPG Sound Pack/battle/swing.wav`, -2],
  ...[0, 1, 2].map((n) => [`flesh_${n}`, `${K_IMPACT}/impactPunch_medium_00${n}.ogg`, -2]),
  ['slice_0', `${K_RPG}/knifeSlice.ogg`, -6],
  ['slice_1', `${K_RPG}/knifeSlice2.ogg`, -6],
  ...[0, 1, 2].map((n) => [`bone_${n}`, `${K_IMPACT}/impactWood_light_00${n}.ogg`, -2]),
  ...[0, 1, 2].map((n) => [`plate_${n}`, `${K_IMPACT}/impactPlate_medium_00${n}.ogg`, -2]),
  ['plate_heavy', `${K_IMPACT}/impactPlate_heavy_000.ogg`, -1],
  ['metal_heavy', `${K_IMPACT}/impactMetal_heavy_001.ogg`, -2],
  ['bell', `${K_IMPACT}/impactBell_heavy_002.ogg`, -4],
  ['body_hit', `${K_IMPACT}/impactPunch_heavy_001.ogg`, -1],
  ['body_fall', `${K_IMPACT}/impactSoft_heavy_002.ogg`, -2],
  ['slam', `${K_IMPACT}/impactMining_003.ogg`, -1],
  ...[...Array(10).keys()].map((n) => [`rattle_${n}`, `${OGA}/bones_rattle/${n}.ogg`, -3]),
  ...[0, 1, 2, 3, 4].map((n) => [`step_grass_${n}`, `${K_IMPACT}/footstep_grass_00${n}.ogg`, -6]),
  ...[0, 1, 2, 3, 4].map((n) => [`step_wood_${n}`, `${K_IMPACT}/footstep_wood_00${n}.ogg`, -6]),
  ...[0, 1, 2, 3, 4].map((n) => [`step_stone_${n}`, `${K_IMPACT}/footstep_concrete_00${n}.ogg`, -6]),
  ['cloth_0', `${K_RPG}/cloth1.ogg`, -4],
  ['cloth_1', `${K_RPG}/cloth3.ogg`, -4],
  ['leather', `${K_RPG}/dropLeather.ogg`, -4],
  ['unsheathe', `${OGA}/rpg_sound_pack/RPG Sound Pack/battle/sword-unsheathe2.wav`, -4],
  ['magic', `${OGA}/rpg_sound_pack/RPG Sound Pack/battle/magic1.wav`, -2],
  ['potion', `${OGA}/rpg_sound_pack/RPG Sound Pack/inventory/bubble2.wav`, -4],
  ['coins', `${K_RPG}/handleCoins.ogg`, -4],
  ['equip', `${OGA}/rpg_sound_pack/RPG Sound Pack/inventory/chainmail1.wav`, -4],
  ['page_0', `${K_RPG}/bookFlip1.ogg`, -6],
  ['page_1', `${K_RPG}/bookFlip2.ogg`, -6],
  ['book_open', `${K_RPG}/bookOpen.ogg`, -5],
  ['book_close', `${K_RPG}/bookClose.ogg`, -5],
  ['click', `${K_IFACE}/click_002.ogg`, -8],
  ['confirm', `${K_IFACE}/confirmation_002.ogg`, -6],
  ['levelup', `${K_IFACE}/maximize_006.ogg`, -4],
  ['error', `${K_IFACE}/error_004.ogg`, -8],
];

/** Seamless loops: [name, source, start s, length s, crossfade s]. Mono 64 kbps. */
const LOOPS = [
  ['amb_birds', `${OGA}/Birds_and_Wind_-_Ambient_1.ogg`, 4, 40, 3],
  ['amb_fire', `${OGA}/fire.wav`, 2, 12, 1.5],
  ['amb_water', `${OGA}/sfx_loops/water_flowing.ogg`, 0, 0, 0],
];

/** Music: already seamless loops from their authors. Stereo 96 kbps. */
const MUSIC = [
  ['music_explore', `${OGA}/Loop_The_Bards_Tale.wav`],
  ['music_village', `${OGA}/Loop_The_Old_Tower_Inn.wav`],
  ['music_battle', `${OGA}/determined_pursuit_loop.wav`],
  ['music_boss', `${OGA}/Juhani_Junkala_-_Epic_Boss_Battle_Seamlessly_Looping.wav`],
];

const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'pipe', 'inherit'] });

function maxVolume(file) {
  // volumedetect reports on stderr.
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /max_volume: (-?[\d.]+) dB/.exec(r.stderr);
  if (!m) throw new Error(`cannot read ${file}`);
  return parseFloat(m[1]);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const [name, src, peak, trim] of ONESHOTS) {
  const file = join(SRC, src);
  const gain = peak - maxVolume(file);
  // Trim leading silence so hits land on the frame they're triggered.
  const filters = ['silenceremove=start_periods=1:start_threshold=-50dB', `volume=${gain.toFixed(2)}dB`];
  if (trim) filters.push(`atrim=0:${trim}`);
  ff(['-i', file, '-af', filters.join(','), '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '64k', join(OUT, `${name}.mp3`)]);
}

for (const [name, src, start, len, xf] of LOOPS) {
  const file = join(SRC, src);
  const out = join(OUT, `${name}.mp3`);
  if (!len) {
    ff(['-i', file, '-af', 'loudnorm=I=-20:TP=-2', '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '64k', out]);
    continue;
  }
  // Body [start, start+len] fades in over its first `xf` seconds while the
  // audio that followed it fades out on top, so the end flows into the start.
  const graph = [
    `[0:a]asplit[a][b]`,
    `[a]atrim=${start}:${start + len},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${xf}[body]`,
    `[b]atrim=${start + len}:${start + len + xf},asetpts=PTS-STARTPTS,afade=t=out:st=0:d=${xf}[tail]`,
    `[body][tail]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-20:TP=-2[out]`,
  ].join(';');
  ff(['-i', file, '-filter_complex', graph, '-map', '[out]', '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '64k', out]);
}

for (const [name, src] of MUSIC) {
  ff(['-i', join(SRC, src), '-af', 'loudnorm=I=-18:TP=-1.5', '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '96k', join(OUT, `${name}.mp3`)]);
}

let total = 0;
for (const f of readdirSync(OUT)) total += statSync(join(OUT, f)).size;
console.log(`${readdirSync(OUT).length} files, ${(total / 1024 / 1024).toFixed(2)} MB in ${OUT}`);
