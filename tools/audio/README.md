# Audio pipeline

All sounds are CC0 (listed in `CREDITS.md`). Sources live outside the repo in
`../Web3DRPG-tools/audio`:

- Kenney packs, unzipped as-is: `kenney_rpg-audio`, `kenney_impact-sounds`,
  `kenney_interface-sounds` (from kenney.nl/assets).
- OpenGameArt downloads in `oga/` (zips unzipped into folders of the same name):
  `swishes.zip`, `rpg_sound_pack.zip`, `bones_rattle.zip`, `sfx_loops.zip`,
  `fire.wav`, `Birds_and_Wind_-_Ambient_1.ogg`, `Loop_The_Bards_Tale.wav`,
  `Loop_The_Old_Tower_Inn.wav`, `determined_pursuit_loop.wav`,
  `Juhani_Junkala_-_Epic_Boss_Battle_Seamlessly_Looping.wav`.

```bash
node tools/audio/build_audio.mjs            # needs ffmpeg on PATH
```

writes `public/audio/*.mp3` (about 4.5 MB):

- one-shots: mono 64 kbps, leading silence trimmed, peak-normalised;
- ambience loops: mono 64 kbps, made seamless by crossfading the tail into the start;
- music: stereo 96 kbps, loudness-normalised (the tracks are authored as loops).

At runtime `src/game/audio.ts` decodes the effects into WebAudio buffers, streams
music through `<audio>` elements, and unlocks on the first tap, click or key.
`src/game/sounds.ts` maps game events (hits by enemy kind, footsteps by surface)
to samples.
