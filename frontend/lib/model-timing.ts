/**
 * Per-model generation timing memory (localStorage).
 *
 * Palette tracks the user's own observed durations per model in a zustand
 * store; DD is contexts-only, so this is the same idea as a plain module:
 * record how long each model's generations actually took on THIS machine and
 * expose a rolling average the ClapperboardSpinner renders as the "you
 * usually finish here" marker.
 */

const STORAGE_KEY = 'dd-model-timing-v1'
const MAX_SAMPLES = 8

interface ModelTimings {
  [model: string]: { samples: number[] }
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
export function recordModelTiming(model: string, elapsedMs: number): void {
  if (!model || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return
  const t = load()
  const entry = t[model] ?? { samples: [] }
  entry.samples = [...entry.samples, elapsedMs].slice(-MAX_SAMPLES)
  t[model] = entry
  save(t)
}

/** Rolling average of the user's own completions for a model, in seconds. */
export function getModelAvgSeconds(model: string): number | null {
  const entry = load()[model]
  if (!entry || entry.samples.length === 0) return null
  const avgMs = entry.samples.reduce((a, b) => a + b, 0) / entry.samples.length
  return avgMs / 1000
}
