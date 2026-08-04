import { describe, it, expect } from 'vitest'
import {
  effectiveSpeed,
  timelineDeltaToSource,
  sourceDeltaToTimeline,
  sourceWindowEnd,
  timelineToSource,
  sourceToTimeline,
  splitTrims,
  type TimeMappedClip,
} from './clip-time'

/** A 10s timeline clip at 1x starting 5s into a 30s source. */
const base: TimeMappedClip = {
  startTime: 100,
  duration: 10,
  trimStart: 5,
  trimEnd: 15,
  speed: 1,
  reversed: false,
}

const fast: TimeMappedClip = { ...base, speed: 2, trimEnd: 5 } // 10s timeline = 20s source
const backwards: TimeMappedClip = { ...base, reversed: true }

describe('effectiveSpeed', () => {
  it('folds the degenerate values to 1 so they can never divide by zero', () => {
    expect(effectiveSpeed({ speed: 0 })).toBe(1)
    expect(effectiveSpeed({ speed: undefined })).toBe(1)
    expect(effectiveSpeed({ speed: Number.NaN })).toBe(1)
    expect(effectiveSpeed({ speed: -2 })).toBe(1)
    expect(effectiveSpeed({ speed: 2 })).toBe(2)
  })
})

describe('delta conversion', () => {
  it('scales by speed in the right direction', () => {
    // 3s of timeline at 2x consumes 6s of source.
    expect(timelineDeltaToSource(3, fast)).toBe(6)
    expect(sourceDeltaToTimeline(6, fast)).toBe(3)
  })

  it('round-trips', () => {
    for (const speed of [0.25, 0.5, 1, 2, 4]) {
      expect(sourceDeltaToTimeline(timelineDeltaToSource(7, { speed }), { speed })).toBeCloseTo(7, 9)
    }
  })
})

describe('timelineToSource / sourceToTimeline', () => {
  it('maps a forward clip', () => {
    expect(timelineToSource(100, base)).toBe(5)   // clip start -> trimStart
    expect(timelineToSource(110, base)).toBe(15)  // clip end -> window end
  })

  it('maps a sped-up clip using source time, not timeline time', () => {
    // 3s into a 2x clip is 6s into the source, not 3s. This is the F8 bug class.
    expect(timelineToSource(103, fast)).toBe(11) // trimStart 5 + 6
  })

  it('starts a reversed clip at the END of its source window', () => {
    expect(sourceWindowEnd(backwards)).toBe(15)
    expect(timelineToSource(100, backwards)).toBe(15) // start of clip = end of window
    expect(timelineToSource(110, backwards)).toBe(5)  // end of clip = start of window
  })

  it('is invertible for every combination of speed and direction', () => {
    for (const clip of [base, fast, backwards, { ...fast, reversed: true }]) {
      for (const t of [100, 102.5, 105, 109.9]) {
        expect(sourceToTimeline(timelineToSource(t, clip), clip)).toBeCloseTo(t, 9)
      }
    }
  })
})

describe('splitTrims', () => {
  it('splits a 1x clip the way the old code did — the no-speed case was always fine', () => {
    const { firstHalf, secondHalf } = splitTrims(base, 4)
    expect(firstHalf).toEqual({ duration: 4, trimStart: 5, trimEnd: 15 + 6 })
    expect(secondHalf).toEqual({ duration: 6, trimStart: 5 + 4, trimEnd: 15 })
  })

  it('F8: scales the split by speed', () => {
    // 4s into a 2x clip is 8s of source, NOT 4s. The old blade added 4.
    const { firstHalf, secondHalf } = splitTrims(fast, 4)
    expect(secondHalf.trimStart).toBe(5 + 8)
    expect(firstHalf.trimEnd).toBe(5 + 12) // remaining 6s timeline = 12s source
  })

  it('splits a reversed clip from the far end of the window', () => {
    // First half on the timeline shows the LATER source material.
    const { firstHalf, secondHalf } = splitTrims(backwards, 4)
    expect(firstHalf).toEqual({ duration: 4, trimStart: 5 + 6, trimEnd: 15 })
    expect(secondHalf).toEqual({ duration: 6, trimStart: 5, trimEnd: 15 + 4 })
  })

  it('conserves the source window across the cut, in every mode', () => {
    // The halves must together cover exactly what the original covered — this is
    // the invariant that catches a swapped trimStart/trimEnd.
    for (const clip of [base, fast, backwards, { ...fast, reversed: true }]) {
      for (const at of [1, 4, 7, 9]) {
        const { firstHalf, secondHalf } = splitTrims(clip, at)
        const sourceOf = (h: { duration: number; trimStart: number; trimEnd: number }) =>
          timelineDeltaToSource(h.duration, clip)
        expect(sourceOf(firstHalf) + sourceOf(secondHalf)).toBeCloseTo(
          timelineDeltaToSource(clip.duration, clip), 9,
        )
        // Neither half may reach outside the original window.
        expect(firstHalf.trimStart).toBeGreaterThanOrEqual(clip.trimStart - 1e-9)
        expect(secondHalf.trimStart).toBeGreaterThanOrEqual(clip.trimStart - 1e-9)
        expect(firstHalf.trimEnd).toBeGreaterThanOrEqual(clip.trimEnd - 1e-9)
        expect(secondHalf.trimEnd).toBeGreaterThanOrEqual(clip.trimEnd - 1e-9)
      }
    }
  })

  it('keeps the two halves adjacent in source time', () => {
    // Forward: first half ends exactly where the second begins.
    const { firstHalf, secondHalf } = splitTrims(fast, 4)
    const firstEnd = firstHalf.trimStart + timelineDeltaToSource(firstHalf.duration, fast)
    expect(firstEnd).toBeCloseTo(secondHalf.trimStart, 9)
  })
})
