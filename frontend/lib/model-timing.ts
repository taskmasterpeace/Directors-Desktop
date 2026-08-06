/**
 * Per-model generation timing memory (localStorage).
 *
 * Records how long each model's generations ACTUALLY took on this machine and
 * exposes a rolling average that (a) renders on the clapperboard as "your
 * avg", and (b) replaces the static table estimate once enough samples exist,
 * so the countdown dynamically adjusts to the user's real hardware.
 *
 * Warm and cold runs live in SEPARATE buckets: a first-of-session render pays
 * a multi-minute model load (LTX measured 1012s cold vs 90s warm), so one
 * blended average would be wrong in both directions. Callers say which bucket
 * a sample belongs to (use-generation knows coldStart at submit time).
 */

const STORAGE_KEY = 'dd-model-timing-v2'
const MAX_SAMPLES = 8
/** Personal average starts driving the ETA once this many samples exist. */
const MIN_SAMPLES_FOR_ETA = 2

interface ModelTimings {
  [model: string]: { warm: number[]; cold: number[] }
}

function load(): ModelTimings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as ModelTimings
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function save(t: ModelTimings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(t))
  } catch {
    // storage full/unavailable — timing memory is a nicety, never fatal
  }
}

/** Record a completed generation's wall time for a model. */
export function recordModelTiming(model: string, elapsedMs: number, cold: boolean): void {
  if (!model || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return
  const t = load()
  const entry = t[model] ?? { warm: [], cold: [] }
  const bucket = cold ? 'cold' : 'warm'
  entry[bucket] = [...(entry[bucket] ?? []), elapsedMs].slice(-MAX_SAMPLES)
  t[model] = entry
  save(t)
}

/** Rolling average for a model+bucket, in seconds. null until data exists. */
export function getModelAvgSeconds(model: string, cold: boolean): number | null {
  const entry = load()[model]
  const bucket = cold ? entry?.cold : entry?.warm
  if (!bucket || bucket.length === 0) return null
  return bucket.reduce((a, b) => a + b, 0) / bucket.length / 1000
}

/**
 * The ETA the countdown should use: the user's own average once it has
 * enough samples to trust, otherwise null (caller falls back to the table).
 */
export function getPersonalEtaSeconds(model: string, cold: boolean): number | null {
  const entry = load()[model]
  const bucket = cold ? entry?.cold : entry?.warm
  if (!bucket || bucket.length < MIN_SAMPLES_FOR_ETA) return null
  return bucket.reduce((a, b) => a + b, 0) / bucket.length / 1000
}
