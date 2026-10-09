import * as THREE from 'three/webgpu';
import { assetUrl } from './character';

/**
 * Sound for the whole game on one WebAudio graph:
 *   sources → (panner) → sfx | ui | amb bus → master → speakers
 *   music <audio> elements → per-track gain → music bus → master
 * Browsers start audio suspended; the first tap, click or key unlocks it.
 * Files come from tools/audio/build_audio.mjs (CC0, see CREDITS.md).
 */

/** Sounds with variations: `swing` picks one of swing_0..swing_4. */
const VARIANTS: Record<string, number> = {
  swing: 5, flesh: 3, slice: 2, bone: 3, plate: 3, rattle: 10,
  step_grass: 5, step_wood: 5, step_stone: 5, cloth: 2, page: 2,
};
const SINGLES = [
  'swing_heavy', 'plate_heavy', 'metal_heavy', 'bell', 'body_hit', 'body_fall', 'slam', 'leather', 'unsheathe',
  'magic', 'potion', 'coins', 'equip', 'book_open', 'book_close', 'click', 'confirm', 'levelup', 'error',
  'amb_birds', 'amb_fire', 'amb_water',
];
export type MusicTrack = 'explore' | 'village' | 'battle' | 'boss';
const MUSIC: MusicTrack[] = ['explore', 'village', 'battle', 'boss'];

type Bus = 'sfx' | 'ui' | 'amb';
export interface PlayOptions {
  /** World position; omitted plays flat (UI, the player's own sounds). */
  at?: THREE.Vector3;
  volume?: number;
  rate?: number;
  /** Random pitch spread, ± this fraction. */
  jitter?: number;
  delay?: number;
  bus?: Bus;
}

export interface AudioSettings {
  master: number;
  music: number;
  sfx: number;
}
const SETTINGS_KEY = 'web3drpg.audio';
const MAX_VOICES = 24;
/** Positional one-shots farther than this are not worth a voice. */
const HEARING_RANGE = 45;

/** A looping, optionally positional sound whose volume the game drives. */
export class AudioLoop {
  constructor(
    readonly gain: GainNode,
    readonly panner: PannerNode | null,
  ) {}

  setVolume(v: number, ctx: AudioContext, smooth = 0.3): void {
    this.gain.gain.setTargetAtTime(v, ctx.currentTime, smooth);
  }

  setPosition(p: THREE.Vector3): void {
    if (!this.panner) return;
    this.panner.positionX.value = p.x;
    this.panner.positionY.value = p.y;
    this.panner.positionZ.value = p.z;
  }
}

class AudioSystem {
  readonly ctx: AudioContext | null;
  readonly settings: AudioSettings = { master: 0.8, music: 0.5, sfx: 0.9 };
  private master!: GainNode;
  private buses = {} as Record<Bus | 'music', GainNode>;
  private buffers = new Map<string, AudioBuffer>();
  private voices = 0;
  private unlocked = false;
  private tracks = new Map<MusicTrack, { el: HTMLAudioElement; gain: GainNode }>();
  private current: MusicTrack | null = null;
  private pendingLoops: { name: string; loop: AudioLoop }[] = [];
  /** Listener position, for skipping sounds out of earshot. */
  private ears = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  private lastResume = 0;
  private up = new THREE.Vector3();

  constructor() {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    this.ctx = Ctx ? new Ctx({ latencyHint: 'interactive' }) : null;
    try {
      Object.assign(this.settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}'));
    } catch {
      /* storage blocked: keep defaults */
    }
    if (!this.ctx) return;
    const ctx = this.ctx;
    this.master = ctx.createGain();
    // A gentle limiter so stacked hits never clip.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -6;
    comp.knee.value = 6;
    comp.ratio.value = 8;
    this.master.connect(comp).connect(ctx.destination);
    for (const b of ['sfx', 'ui', 'amb', 'music'] as const) {
      this.buses[b] = ctx.createGain();
      this.buses[b].connect(this.master);
    }
    this.applySettings();

    const unlock = () => {
      if (this.unlocked) return;
      this.unlocked = true;
      ctx.resume();
      // iOS only lets <audio> play from a gesture: prime every track now.
      for (const t of MUSIC) {
        const { el } = this.track(t);
        el.play().then(() => {
          if (t !== this.current) el.pause();
        }).catch(() => {});
      }
      for (const ev of ['pointerdown', 'keydown', 'touchend'] as const) window.removeEventListener(ev, unlock, true);
    };
    for (const ev of ['pointerdown', 'keydown', 'touchend'] as const) window.addEventListener(ev, unlock, true);
    // Silence everything while the tab is hidden (phones keep playing otherwise).
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        ctx.suspend();
        this.tracks.forEach(({ el }) => el.pause());
      } else if (this.unlocked) {
        ctx.resume();
        if (this.current) this.track(this.current).el.play().catch(() => {});
      }
    });
  }

  /** Fetches and decodes every sound effect in the background. */
  async load(): Promise<void> {
    if (!this.ctx) return;
    const names = [...SINGLES, ...Object.entries(VARIANTS).flatMap(([n, c]) => [...Array(c).keys()].map((i) => `${n}_${i}`))];
    await Promise.all(names.map(async (name) => {
      try {
        const data = await (await fetch(assetUrl(`audio/${name}.mp3`))).arrayBuffer();
        this.buffers.set(name, await this.ctx!.decodeAudioData(data));
      } catch (e) {
        console.warn(`audio ${name} failed`, e);
      }
    }));
    for (const { name, loop } of this.pendingLoops) this.startLoop(name, loop);
    this.pendingLoops = [];
  }

  applySettings(save = false): void {
    if (save) {
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
      } catch {
        /* ignore */
      }
    }
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.settings.master, t, 0.05);
    this.buses.music.gain.setTargetAtTime(this.settings.music, t, 0.05);
    this.buses.sfx.gain.setTargetAtTime(this.settings.sfx, t, 0.05);
    this.buses.ui.gain.setTargetAtTime(Math.min(1, this.settings.sfx * 1.1), t, 0.05);
    this.buses.amb.gain.setTargetAtTime(this.settings.sfx * 0.9, t, 0.05);
  }

  /** Moves the ears to the camera every frame. */
  setListener(camera: THREE.Camera): void {
    if (!this.ctx || !this.unlocked) return;
    // Browsers may suspend audio behind our back (focus changes, phone calls).
    if (this.ctx.state === 'suspended' && performance.now() - this.lastResume > 1000) {
      this.lastResume = performance.now();
      this.ctx.resume();
      if (this.current) this.track(this.current).el.play().catch(() => {});
    }
    const l = this.ctx.listener;
    const p = camera.getWorldPosition(this.ears);
    const f = this.fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const u = this.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    if (l.positionX) {
      l.positionX.value = p.x;
      l.positionY.value = p.y;
      l.positionZ.value = p.z;
      l.forwardX.value = f.x;
      l.forwardY.value = f.y;
      l.forwardZ.value = f.z;
      l.upX.value = u.x;
      l.upY.value = u.y;
      l.upZ.value = u.z;
    } else {
      // Older Safari.
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
  }

  private pick(name: string): AudioBuffer | undefined {
    const n = VARIANTS[name];
    return this.buffers.get(n ? `${name}_${Math.floor(Math.random() * n)}` : name);
  }

  private panner(at: THREE.Vector3, ref = 3): PannerNode {
    const p = this.ctx!.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = 1.2;
    p.maxDistance = 200;
    p.positionX.value = at.x;
    p.positionY.value = at.y;
    p.positionZ.value = at.z;
    return p;
  }

  play(name: string, opts: PlayOptions = {}): void {
    const ctx = this.ctx;
    if (!ctx || !this.unlocked || ctx.state !== 'running' || this.voices >= MAX_VOICES) return;
    if (opts.at && opts.at.distanceTo(this.ears) > HEARING_RANGE) return;
    const buffer = this.pick(name);
    if (!buffer) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const jitter = opts.jitter ?? 0.06;
    src.playbackRate.value = (opts.rate ?? 1) * (1 + (Math.random() * 2 - 1) * jitter);
    const gain = ctx.createGain();
    gain.gain.value = opts.volume ?? 1;
    let node: AudioNode = src.connect(gain);
    if (opts.at) node = node.connect(this.panner(opts.at));
    node.connect(this.buses[opts.bus ?? 'sfx']);
    this.voices++;
    src.onended = () => {
      this.voices--;
      src.disconnect();
      gain.disconnect();
    };
    src.start(ctx.currentTime + (opts.delay ?? 0));
  }

  /** A looping sound (ambience); starts once its buffer has loaded. */
  loop(name: string, at?: THREE.Vector3, volume = 1, ref = 4): AudioLoop | null {
    if (!this.ctx) return null;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    const panner = at ? this.panner(at, ref) : null;
    if (panner) gain.connect(panner).connect(this.buses.amb);
    else gain.connect(this.buses.amb);
    const loop = new AudioLoop(gain, panner);
    if (this.buffers.has(name)) this.startLoop(name, loop);
    else this.pendingLoops.push({ name, loop });
    return loop;
  }

  private startLoop(name: string, loop: AudioLoop): void {
    const buffer = this.buffers.get(name);
    if (!buffer || !this.ctx) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    // Skip the mp3 encoder padding at both ends so the loop has no gap.
    src.loopStart = 0.03;
    src.loopEnd = buffer.duration - 0.03;
    src.connect(loop.gain);
    src.start(0, Math.random() * buffer.duration * 0.9);
  }

  private track(name: MusicTrack): { el: HTMLAudioElement; gain: GainNode } {
    let t = this.tracks.get(name);
    if (!t) {
      const el = new Audio(assetUrl(`audio/music_${name}.mp3`));
      el.loop = true;
      el.preload = 'none';
      el.crossOrigin = 'anonymous';
      const gain = this.ctx!.createGain();
      gain.gain.value = 0;
      this.ctx!.createMediaElementSource(el).connect(gain).connect(this.buses.music);
      t = { el, gain };
      this.tracks.set(name, t);
    }
    return t;
  }

  /** Crossfades to `name` (null fades out). Battle themes restart; others resume. */
  music(name: MusicTrack | null, fade = 2.5): void {
    if (!this.ctx || name === this.current) return;
    const now = this.ctx.currentTime;
    const old = this.current ? this.track(this.current) : null;
    if (old) {
      old.gain.gain.cancelScheduledValues(now);
      old.gain.gain.setValueAtTime(old.gain.gain.value, now);
      old.gain.gain.linearRampToValueAtTime(0, now + fade);
      const el = old.el;
      const was = this.current;
      setTimeout(() => {
        if (this.current !== was) el.pause();
      }, fade * 1000 + 100);
    }
    this.current = name;
    if (!name) return;
    const next = this.track(name);
    if (name === 'battle' || name === 'boss') next.el.currentTime = 0;
    next.gain.gain.cancelScheduledValues(now);
    next.gain.gain.setValueAtTime(next.gain.gain.value, now);
    next.gain.gain.linearRampToValueAtTime(name === 'boss' ? 0.9 : name === 'battle' ? 0.75 : 0.6, now + fade * (name === 'battle' || name === 'boss' ? 0.4 : 1));
    if (this.unlocked && !document.hidden) next.el.play().catch(() => {});
  }
}

export const audio = new AudioSystem();
