/**
 * Local generation cost model — "how long will this shot take on my GPU?"
 *
 * Loading a local video model costs minutes and only ONE fits in 24GB at a time,
 * so the expensive facts are invisible at the moment the user picks a spec. This
 * module turns them into a number we can put on the Generate button.
 *
 * Fitted to 20 measured runs on an RTX 4090 (MiniMax H3 int8, omni-reference,
 * 20 steps) on 2026-08-04. Full data + the fitting script live in the benchmark
 * notes; the shape that matters:
 *
 *     seconds = FIXED + A * (pixels * frames) ^ K      with K ~= 1.85
 *
 * K > 1 is the whole point: cost is SUPERLINEAR in pixels x frames, so 720p is
 * ~6x the cost of 480p rather than ~3x, and users routinely under-estimate it.
 *
 * Accuracy is +/-12%, and that ceiling is measurement noise, not model error --
 * session warmth alone moved identical specs by that much (480p/15s measured
 * SLOWER than 544p/15s despite 20% fewer pixels). Callers should show
 * `formatEtaRange`, never a bare point estimate, or they imply precision we
 * do not have.
 *
 * Orientation is deliberately NOT a term: portrait measured the same as
 * landscape across four pairs (often marginally faster), so only the pixel
 * count matters.
 */

/** Fitted constants. Changing these changes every ETA in the app. */
const FIXED_SECONDS = 20
const COEFFICIENT = 5.604e-13
const EXPONENT = 1.85

/** Measured session-to-session variance. Quote a band this wide. */
export const ETA_VARIANCE = 0.12

/**
 * Cold-load cost for a local video model: streaming ~20GB of weights plus
 * staging the text encoder into VRAM. Measured 8-10 min; the same 10s clip took
 * 19.2 min cold vs 11.4 min warm.
 */
export const MODEL_LOAD_SECONDS = 540

export const GENERATION_FPS = 24

export type ModelWarmth = 'cold' | 'warming' | 'warm'

/**
 * Pixel sizes the local pipeline actually renders, mirroring RESOLUTION_MAP_16_9
 * in backend/handlers/video_generation_handler.py. If that map changes, change
 * this too or every local ETA silently drifts.
 */
const LOCAL_RESOLUTIONS: Readonly<Record<string, readonly [number, number]>> = {
  '512p': [960, 544],
  '540p': [960, 544],
  '720p': [1280, 704],
  '1080p': [1920, 1088],
}

const DEFAULT_LOCAL_SIZE: readonly [number, number] = [960, 544]

/**
 * Portrait is the same pixel budget transposed — measured free across four
 * pairs — so this only swaps the axes.
 */
export function resolveLocalSize(
  resolution: string,
  aspectRatio: '16:9' | '9:16' = '16:9',
): { width: number; height: number } {
  const [w, h] = LOCAL_RESOLUTIONS[resolution] ?? DEFAULT_LOCAL_SIZE
  return aspectRatio === '9:16' ? { width: h, height: w } : { width: w, height: h }
}

/**
 * MiniMax H3 snaps frame counts to a 17k+5 grid; 5s -> 124, 15s -> 362.
 * Rounding here rather than at the call site keeps ETAs consistent with what
 * the backend actually generates.
 */
export function snapFrames(seconds: number, fps: number = GENERATION_FPS): number {
  const raw = Math.max(5, Math.round(seconds * fps))
  return raw + ((5 - (raw % 17)) % 17)
}

/** Render time only — assumes the model is already resident. */
export function estimateRenderSeconds(width: number, height: number, seconds: number): number {
  if (width <= 0 || height <= 0 || seconds <= 0) return 0
  const tokens = width * height * snapFrames(seconds)
  return FIXED_SECONDS + COEFFICIENT * Math.pow(tokens, EXPONENT)
}

/**
 * Total wall time the user will actually wait, including a model load when the
 * requested model is not the resident one.
 */
export function estimateTotalSeconds(
  width: number,
  height: number,
  seconds: number,
  warmth: ModelWarmth,
): number {
  const render = estimateRenderSeconds(width, height, seconds)
  if (warmth === 'warm') return render
  if (warmth === 'warming') return render + MODEL_LOAD_SECONDS / 2
  return render + MODEL_LOAD_SECONDS
}

/** Cost of a whole shot list, with the model loaded once rather than per shot. */
export function estimateBatchSeconds(
  shots: ReadonlyArray<{ width: number; height: number; seconds: number }>,
  warmth: ModelWarmth = 'cold',
): number {
  const render = shots.reduce((t, s) => t + estimateRenderSeconds(s.width, s.height, s.seconds), 0)
  return warmth === 'warm' ? render : render + MODEL_LOAD_SECONDS
}

/**
 * Reload penalty for a shot list that alternates between models. Only one model
 * fits in VRAM, so every switch pays a full load — sorting the list by model
 * collapses that to one load per distinct model.
 */
export function modelSwitchPenaltySeconds(modelsInShotOrder: readonly string[]): number {
  let switches = 0
  for (let i = 1; i < modelsInShotOrder.length; i++) {
    if (modelsInShotOrder[i] !== modelsInShotOrder[i - 1]) switches++
  }
  return switches * MODEL_LOAD_SECONDS
}

/** Seconds saved by grouping a mixed shot list by model instead of interleaving. */
export function groupingSavingsSeconds(modelsInShotOrder: readonly string[]): number {
  const distinct = new Set(modelsInShotOrder).size
  const grouped = Math.max(0, distinct - 1) * MODEL_LOAD_SECONDS
  return Math.max(0, modelSwitchPenaltySeconds(modelsInShotOrder) - grouped)
}

/** Compact human duration: "45 sec", "2.4 min", "1 hr 12 min". */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0 sec'
  if (totalSeconds < 60) return `${Math.round(totalSeconds)} sec`
  const minutes = totalSeconds / 60
  // One decimal below 10 min, but never a bare ".0" — "9 min" reads finished,
  // "9.0 min" reads like a bug.
  if (minutes < 10) return `${minutes.toFixed(1).replace(/\.0$/, '')} min`
  if (minutes < 60) return `${Math.round(minutes)} min`
  const hours = Math.floor(minutes / 60)
  const rem = Math.round(minutes % 60)
  return rem === 0 ? `${hours} hr` : `${hours} hr ${rem} min`
}

/**
 * The honest form: a band, because a point estimate implies precision the
 * measurements do not support.
 */
export function formatEtaRange(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0 sec'
  const lo = totalSeconds * (1 - ETA_VARIANCE)
  const hi = totalSeconds * (1 + ETA_VARIANCE)
  if (hi < 60) return `${Math.round(lo)}–${Math.round(hi)} sec`
  return `${formatDuration(lo).replace(/ (min|hr).*$/, '')}–${formatDuration(hi)}`
}
