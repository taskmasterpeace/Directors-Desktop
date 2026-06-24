/**
 * Pure ripple-trim math for transcript-driven ("Descript-style") editing.
 *
 * This module isolates the content-destructive arithmetic the plan's audit flagged
 * as easy to get subtly wrong (risks R2/R3/R4):
 *   - R2: trim math MUST be speed-aware (`source = timeline * speed`), unlike
 *         `splitClipAtPlayhead` which omits `* speed`.
 *   - R3: ripple shifts ONLY the affected track(s), not every track.
 *   - R4: linked A/V partners are cut together so they never desync.
 *
 * It is intentionally DOM-free and side-effect-free so it can be reasoned about and
 * unit-tested in isolation. The caller (VideoEditor) is responsible for the
 * integration concerns: `pushUndo()` ONCE before applying, snapping cut points to
 * silence-gap midpoints, and `resolveOverlaps` afterward.
 *
 * Time model: word timestamps are in SOURCE-media seconds. A clip plays source range
 * [trimStart, sourceTotal - trimEnd] at `speed`, occupying timeline [startTime,
 * startTime + duration] where duration = (sourceTotal - trimStart - trimEnd) / speed.
 * Reversed clips are not yet handled here (documented follow-up).
 */

const EPS = 1e-6

/** Minimal clip shape this math needs; generic so callers keep their extra fields. */
export interface RippleClip {
  id: string
  startTime: number
  duration: number
  trimStart: number
  trimEnd: number
  speed: number
  trackIndex: number
  linkedClipIds?: string[]
}

/** A word with SOURCE-media start/end seconds (the subset the snap math needs). */
export interface TimedWord {
  start: number
  end: number
}

/**
 * Snap a selected word span [lo, hi] to the midpoints of the surrounding silence gaps —
 * i.e. cut halfway between the previous word's end and the first word's start (and likewise
 * at the tail). This "cuts on silence" so a ripple-delete doesn't clip a neighbouring word's
 * onset. At the clip edges (no neighbour) it falls back to the exact word boundary.
 */
export function snapSpanToSilence(
  words: TimedWord[],
  lo: number,
  hi: number,
): { start: number; end: number } {
  const first = words[lo]
  const last = words[hi]
  if (!first || !last) return { start: 0, end: 0 }
  const prev = words[lo - 1]
  const next = words[hi + 1]
  const start = prev ? (prev.end + first.start) / 2 : first.start
  const end = next ? (last.end + next.start) / 2 : last.end
  return { start, end }
}

/** Map a SOURCE-media time (seconds) to its timeline time for a given clip. */
export function sourceTimeToTimelineTime<T extends RippleClip>(sourceTime: number, clip: T): number {
  const speed = clip.speed || 1
  return clip.startTime + (sourceTime - clip.trimStart) / speed
}

/**
 * Split a clip to remove the timeline window [cutIn, cutOut], returning the surviving
 * left/right pieces. The right piece is repositioned to butt against the left (ripple).
 * Trim math is speed-aware: `sourceDelta = timelineDelta * speed`.
 */
export function splitForDelete<T extends RippleClip>(
  clip: T,
  cutIn: number,
  cutOut: number,
  makeId: (clip: T) => string,
): { left: T | null; right: T | null } {
  const speed = clip.speed || 1
  const sStart = clip.startTime
  const sEnd = clip.startTime + clip.duration
  const inC = Math.max(cutIn, sStart)
  const outC = Math.min(cutOut, sEnd)

  let left: T | null = null
  let right: T | null = null

  if (inC > sStart + EPS) {
    const leftDur = inC - sStart
    // left keeps its head; its tail trim grows by the source-length it no longer covers.
    left = { ...clip, duration: leftDur, trimEnd: clip.trimEnd + (clip.duration - leftDur) * speed }
  }

  if (outC < sEnd - EPS) {
    const consumed = outC - sStart // timeline consumed from the original start
    right = {
      ...clip,
      id: left ? makeId(clip) : clip.id, // a single clip can't yield two clips with the same id
      startTime: inC, // ripple: right piece moves up to meet the left piece
      trimStart: clip.trimStart + consumed * speed,
      duration: sEnd - outC,
    }
  }

  return { left, right }
}

/**
 * Ripple-delete the transcript span [spanStartSource, spanEndSource] (SOURCE seconds)
 * from `targetClipId`, cutting any linked partners on their own tracks and rippling
 * each affected track left by the removed timeline length. Returns a NEW clips array;
 * the input is not mutated.
 */
export function rippleDeleteSpan<T extends RippleClip>(
  clips: T[],
  targetClipId: string,
  spanStartSource: number,
  spanEndSource: number,
  makeId: (clip: T) => string = (c) => `${c.id}:r`,
): T[] {
  const target = clips.find((c) => c.id === targetClipId)
  if (!target) return clips

  const rawA = sourceTimeToTimelineTime(spanStartSource, target)
  const rawB = sourceTimeToTimelineTime(spanEndSource, target)
  const targetEnd = target.startTime + target.duration
  const cutIn = Math.max(target.startTime, Math.min(rawA, rawB))
  const cutOut = Math.min(targetEnd, Math.max(rawA, rawB))
  const amount = cutOut - cutIn
  if (amount <= EPS) return clips

  // R4: cut the target AND its linked A/V partners. R3: only their tracks ripple.
  const cutIds = new Set<string>([target.id, ...(target.linkedClipIds ?? [])])
  const cutTracks = new Set<number>(
    clips.filter((c) => cutIds.has(c.id)).map((c) => c.trackIndex),
  )

  const result: T[] = []
  for (const clip of clips) {
    if (cutIds.has(clip.id)) {
      const { left, right } = splitForDelete(clip, cutIn, cutOut, makeId)
      if (left) result.push(left)
      if (right) result.push(right)
      // both null ⇒ the whole clip fell inside the cut ⇒ removed
    } else if (cutTracks.has(clip.trackIndex) && clip.startTime >= cutOut - EPS) {
      result.push({ ...clip, startTime: clip.startTime - amount })
    } else {
      result.push(clip) // untouched (other tracks, or before the cut)
    }
  }
  return result
}
