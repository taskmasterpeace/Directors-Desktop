// Pure math for the Clip Tool: given a source video duration and a desired
// segment length, compute a valid [start, end] window and keep it in-bounds as
// the user scrubs or resizes. No DOM / Electron dependencies so this stays
// unit-testable in the node vitest environment.

/** The snap presets offered in the UI. Selections themselves can be any length. */
export type SegmentLength = 15 | 30

/** Shortest selection the edge handles allow. */
export const MIN_CLIP_LENGTH = 0.5
/** Longest selection the tool supports (the 30s preset). */
export const MAX_CLIP_LENGTH = 30
/** Longest clip Seedance 2.0 accepts as a video reference. */
export const MAX_REFERENCE_LENGTH = 15

export interface ClipSelection {
  /** Segment start in seconds, always >= 0 */
  start: number
  /** Segment end in seconds, always <= duration */
  end: number
  /** Effective length in seconds (end - start) */
  length: number
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.max(min, Math.min(max, value))
}

/**
 * The actual length a segment can be. If the source is shorter than the
 * requested length, the segment is capped to the whole source.
 */
export function effectiveLength(duration: number, desired: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  return Math.min(desired, duration)
}

/**
 * Build a selection anchored at `start`, of the given length, clamped so it
 * never runs past the end of the source. If the source is shorter than the
 * requested length the selection spans the whole source (start pinned to 0).
 */
export function buildSelection(
  duration: number,
  desired: number,
  start: number,
): ClipSelection {
  const len = effectiveLength(duration, desired)
  if (len <= 0) return { start: 0, end: 0, length: 0 }

  const maxStart = Math.max(0, duration - len)
  const clampedStart = clamp(start, 0, maxStart)
  const end = clampedStart + len
  return { start: clampedStart, end, length: len }
}

/**
 * Latest valid start position for a segment of `desired` length in a source of
 * `duration` seconds. Useful for scrubber bounds.
 */
export function maxStart(duration: number, desired: number): number {
  const len = effectiveLength(duration, desired)
  return Math.max(0, duration - len)
}

/**
 * Move one edge of the selection to `time`, keeping the other edge fixed and
 * the resulting length within [minLength, maxLength] (and inside the source).
 * If the source itself is shorter than `minLength` the selection spans it all.
 */
export function resizeEdge(
  selection: ClipSelection,
  duration: number,
  edge: 'start' | 'end',
  time: number,
  minLength: number = MIN_CLIP_LENGTH,
  maxLength: number = MAX_CLIP_LENGTH,
): ClipSelection {
  if (!Number.isFinite(duration) || duration <= 0) return { start: 0, end: 0, length: 0 }
  const minLen = Math.min(minLength, duration)
  if (edge === 'start') {
    const end = clamp(selection.end, minLen, duration)
    const start = clamp(time, Math.max(0, end - maxLength), end - minLen)
    return { start, end, length: end - start }
  }
  const start = clamp(selection.start, 0, duration - minLen)
  const end = clamp(time, start + minLen, Math.min(duration, start + maxLength))
  return { start, end, length: end - start }
}

/**
 * Move an existing selection by `deltaSeconds`, keeping it in-bounds and the
 * length fixed.
 */
export function nudgeSelection(
  selection: ClipSelection,
  duration: number,
  deltaSeconds: number,
): ClipSelection {
  const maxS = Math.max(0, duration - selection.length)
  const start = clamp(selection.start + deltaSeconds, 0, maxS)
  return { start, end: start + selection.length, length: selection.length }
}

/** Format seconds as M:SS (for short clips) or H:MM:SS. */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`
  return `${m}:${ss}`
}

/** Format a selection length compactly: whole seconds as "12s", else "12.5s". */
export function formatLength(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const rounded = Math.round(seconds * 10) / 10
  return Number.isInteger(rounded) ? `${rounded}s` : `${rounded.toFixed(1)}s`
}

/** A safe default output filename for a trimmed segment. */
export function suggestOutputName(sourceName: string, selection: ClipSelection): string {
  const dot = sourceName.lastIndexOf('.')
  const base = dot > 0 ? sourceName.slice(0, dot) : sourceName
  const start = Math.round(selection.start)
  const len = Math.round(selection.length)
  return `${base}_clip_${start}s_${len}s.mp4`
}

/**
 * Filename for a clip auto-exported as a generation reference. `stamp` is a
 * caller-provided uniquifier (e.g. Date.now()) so re-trims never overwrite a
 * clip an earlier generation might still point at.
 */
export function suggestReferenceName(
  sourceName: string,
  selection: ClipSelection,
  stamp: number,
): string {
  const dot = sourceName.lastIndexOf('.')
  const base = dot > 0 ? sourceName.slice(0, dot) : sourceName
  const safe =
    base
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'clip'
  const start = Math.round(selection.start)
  const len = Math.round(selection.length)
  return `${safe}_ref_${start}s_${len}s_${Math.abs(Math.floor(stamp)) % 1_000_000}.mp4`
}
