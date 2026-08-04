/**
 * The one place that knows how timeline time maps to source-media time.
 *
 * A clip plays the source window `[trimStart, sourceTotal - trimEnd]` at `speed`,
 * occupying timeline `[startTime, startTime + duration]` where
 * `duration = (sourceTotal - trimStart - trimEnd) / speed`. When `reversed`, the
 * clip walks that same window backwards: timeline start shows the window's END.
 *
 * Two conversions therefore exist, and getting either wrong corrupts edits
 * silently — the clip still looks right, it just plays the wrong frames:
 *
 *     source delta = timeline delta * speed
 *     timeline delta = source delta / speed
 *
 * This module exists because the repo previously had five independent
 * implementations of that arithmetic and two of them dropped `* speed`
 * (the blade / Cut-to-Beats) or ignored `reversed` (captions, FCPXML export).
 * `transcript-ripple.ts` documented the correct rule but only for itself.
 * Anything converting between the two clocks should call these helpers rather
 * than re-deriving the maths.
 */

/** The subset of a clip this arithmetic needs. Generic so callers keep extra fields. */
export interface TimeMappedClip {
  startTime: number
  duration: number
  trimStart: number
  trimEnd: number
  speed?: number
  reversed?: boolean
}

/** Speed with the degenerate cases (0, NaN, undefined) folded to 1. */
export function effectiveSpeed(clip: Pick<TimeMappedClip, 'speed'>): number {
  const s = clip.speed
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 1
}

/** A duration on the timeline, expressed in source-media seconds. */
export function timelineDeltaToSource(delta: number, clip: Pick<TimeMappedClip, 'speed'>): number {
  return delta * effectiveSpeed(clip)
}

/** A duration of source media, expressed in timeline seconds. */
export function sourceDeltaToTimeline(delta: number, clip: Pick<TimeMappedClip, 'speed'>): number {
  return delta / effectiveSpeed(clip)
}

/**
 * Total source duration implied by the clip's own fields.
 *
 * Derived rather than read off the asset so the maths stays correct for clips
 * whose asset is missing or still generating.
 */
export function sourceWindowEnd(clip: TimeMappedClip): number {
  return clip.trimStart + timelineDeltaToSource(clip.duration, clip)
}

/**
 * Map a time on the timeline to the source-media time actually shown there.
 *
 * Honours `reversed`: at the start of a reversed clip the playhead is at the END
 * of the source window, walking backwards.
 */
export function timelineToSource(timelineTime: number, clip: TimeMappedClip): number {
  const offset = timelineDeltaToSource(timelineTime - clip.startTime, clip)
  return clip.reversed ? sourceWindowEnd(clip) - offset : clip.trimStart + offset
}

/** Inverse of {@link timelineToSource}: where a given source time lands on the timeline. */
export function sourceToTimeline(sourceTime: number, clip: TimeMappedClip): number {
  const offset = clip.reversed ? sourceWindowEnd(clip) - sourceTime : sourceTime - clip.trimStart
  return clip.startTime + sourceDeltaToTimeline(offset, clip)
}

/** Trim window for one slice of a segmented clip, in source-media seconds. */
export interface ClipSegmentTrims {
  /** Timeline offset (seconds) of this segment's start, relative to the clip. */
  offset: number
  /** Timeline duration (seconds) of this segment. */
  duration: number
  trimStart: number
  trimEnd: number
}

/**
 * Slice a clip at a set of interior timeline offsets (e.g. beat positions),
 * returning the trim window for each resulting segment.
 *
 * Extracted from Cut-to-Beats so the speed/reverse arithmetic is unit-tested
 * rather than re-derived inline. `interiorOffsets` are timeline seconds measured
 * from the clip's start; out-of-range and unsorted values are ignored.
 */
export function segmentClipAtOffsets(
  clip: TimeMappedClip,
  interiorOffsets: readonly number[],
): ClipSegmentTrims[] {
  const eps = 1e-4
  const cuts = interiorOffsets
    .filter((o) => o > eps && o < clip.duration - eps)
    .slice()
    .sort((a, b) => a - b)
  const bounds = [0, ...cuts, clip.duration]
  const out: ClipSegmentTrims[] = []
  for (let i = 0; i < bounds.length - 1; i++) {
    const offset = bounds[i]
    const duration = bounds[i + 1] - offset
    const head = timelineDeltaToSource(offset, clip)
    const tail = timelineDeltaToSource(clip.duration - (offset + duration), clip)
    out.push({
      offset,
      duration,
      // A reversed clip consumes its window from the far end, so the first
      // timeline segment holds the LAST source material.
      trimStart: clip.reversed ? clip.trimStart + tail : clip.trimStart + head,
      trimEnd: clip.reversed ? clip.trimEnd + head : clip.trimEnd + tail,
    })
  }
  return out
}

/**
 * Split a clip at a timeline offset, returning the trim values for both halves.
 *
 * The blade and Cut-to-Beats previously added the raw timeline offset to
 * `trimStart`/`trimEnd`. On any clip whose speed is not 1 that cuts the wrong
 * frame — at 2x, a cut 3s into the timeline is 6s into the source.
 */
export function splitTrims(
  clip: TimeMappedClip,
  splitPoint: number,
): {
  firstHalf: { duration: number; trimStart: number; trimEnd: number }
  secondHalf: { duration: number; trimStart: number; trimEnd: number }
} {
  const consumed = timelineDeltaToSource(splitPoint, clip)
  const remaining = timelineDeltaToSource(clip.duration - splitPoint, clip)

  if (clip.reversed) {
    // A reversed clip walks its window backwards, so the FIRST half on the
    // timeline is the LATER source material. It keeps trimEnd and raises
    // trimStart; the second half keeps trimStart and raises trimEnd.
    return {
      firstHalf: { duration: splitPoint, trimStart: clip.trimStart + remaining, trimEnd: clip.trimEnd },
      secondHalf: { duration: clip.duration - splitPoint, trimStart: clip.trimStart, trimEnd: clip.trimEnd + consumed },
    }
  }
  return {
    firstHalf: { duration: splitPoint, trimStart: clip.trimStart, trimEnd: clip.trimEnd + remaining },
    secondHalf: { duration: clip.duration - splitPoint, trimStart: clip.trimStart + consumed, trimEnd: clip.trimEnd },
  }
}
