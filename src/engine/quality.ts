export type QualityTier = 'low' | 'medium' | 'high';
export type QualityChoice = QualityTier | 'auto';

export interface QualitySettings {
  tier: QualityTier;
  /** Upper bound for devicePixelRatio. */
  maxPixelRatio: number;
  antialias: boolean;
  shadowMapSize: number;
  /** Fraction of the full vegetation set that gets placed. */
  vegetationDensity: number;
  terrainSegments: number;
  fogNear: number;
  fogFar: number;
  /** Frame-time target used by dynamic resolution. */
  targetFps: number;
  /** Render no faster than this (phones: saves battery and heat). 0 = uncapped. */
  frameCap: number;
  /** Cascaded shadow maps (count); 0 = one shadow map that follows the player. */
  cascades: number;
  post: { ao: boolean; bloom: boolean; shafts: boolean };
}

const PRESETS: Record<QualityTier, Omit<QualitySettings, 'tier'>> = {
  low: {
    maxPixelRatio: 1.25, antialias: false, shadowMapSize: 1024, vegetationDensity: 0.45,
    terrainSegments: 128, fogNear: 40, fogFar: 150, targetFps: 30, frameCap: 30,
    cascades: 0, post: { ao: false, bloom: false, shafts: false },
  },
  medium: {
    maxPixelRatio: 1.5, antialias: true, shadowMapSize: 2048, vegetationDensity: 0.7,
    terrainSegments: 192, fogNear: 60, fogFar: 210, targetFps: 45, frameCap: 0,
    cascades: 3, post: { ao: false, bloom: true, shafts: false },
  },
  high: {
    maxPixelRatio: 2, antialias: true, shadowMapSize: 4096, vegetationDensity: 1,
    terrainSegments: 256, fogNear: 80, fogFar: 280, targetFps: 60, frameCap: 0,
    cascades: 4, post: { ao: true, bloom: true, shafts: true },
  },
};

const STORAGE_KEY = 'web3drpg.quality';

export function isTouchDevice(): boolean {
  return matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 1;
}

export function isMobileDevice(): boolean {
  const ua = navigator.userAgent;
  // iPadOS reports itself as Mac; touch points give it away.
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Guess a tier from what the browser exposes. Conservative on phones. */
export function detectTier(hasWebGPU: boolean): QualityTier {
  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  if (isMobileDevice()) {
    return cores >= 8 && memory >= 6 && hasWebGPU ? 'medium' : 'low';
  }
  if (cores <= 4 || memory <= 4) return 'medium';
  return hasWebGPU ? 'high' : 'medium';
}

export function loadChoice(): QualityChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'low' || v === 'medium' || v === 'high' || v === 'auto') return v;
  } catch { /* storage unavailable */ }
  return 'auto';
}

export function saveChoice(choice: QualityChoice): void {
  try { localStorage.setItem(STORAGE_KEY, choice); } catch { /* storage unavailable */ }
}

export function resolveQuality(choice: QualityChoice, hasWebGPU: boolean): QualitySettings {
  const tier = choice === 'auto' ? detectTier(hasWebGPU) : choice;
  return { tier, ...PRESETS[tier] };
}
