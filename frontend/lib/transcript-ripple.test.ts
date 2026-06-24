import { describe, it, expect } from 'vitest'
import {
  rippleDeleteSpan,
  snapSpanToSilence,
  sourceTimeToTimelineTime,
  type RippleClip,
} from './transcript-ripple'

const clip = (over: Partial<RippleClip> & { id: string }): RippleClip => ({
  startTime: 0,
  duration: 10,
  trimStart: 0,
  trimEnd: 0,
  speed: 1,
  trackIndex: 0,
  ...over,
})

describe('sourceTimeToTimelineTime', () => {
  it('maps source seconds to timeline, speed-aware', () => {
    const c = clip({ id: 'a', startTime: 5, trimStart: 2, speed: 2 })
    expect(sourceTimeToTimelineTime(6, c)).toBe(7) // 5 + (6-2)/2
  })
})

describe('rippleDeleteSpan — speed = 1', () => {
  it('splits into left + repositioned right and removes the middle', () => {
    const result = rippleDeleteSpan([clip({ id: 'a' })], 'a', 3, 5)
    expect(result).toHaveLength(2)
    const [left, right] = result
    expect(left.duration).toBe(3)
    expect(left.trimEnd).toBe(7) // covers source [0,3]
    expect(right.id).toBe('a:r')
    expect(right.startTime).toBe(3) // ripples up to meet the left piece
    expect(right.trimStart).toBe(5) // covers source [5,10]
    expect(right.duration).toBe(5)
  })
})

describe('rippleDeleteSpan — speed = 2 (R2: must multiply by speed)', () => {
  it('trims in SOURCE units, not timeline units', () => {
    // 10s timeline clip playing 2x => 20s of source. Delete source [6,10] => timeline [3,5].
    const result = rippleDeleteSpan([clip({ id: 'a', speed: 2 })], 'a', 6, 10)
    const [left, right] = result
    expect(left.duration).toBe(3)
    expect(left.trimEnd).toBe(14) // source end = 20 - 14 = 6
    expect(right.trimStart).toBe(10) // source [10,20]
    expect(right.duration).toBe(5)
    expect(right.startTime).toBe(3)
  })
})

describe('rippleDeleteSpan — linked A/V (R3 track-scoped, R4 linked)', () => {
  it('cuts both linked clips and ripples only their tracks', () => {
    const a = clip({ id: 'a', trackIndex: 0, linkedClipIds: ['b'] })
    const b = clip({ id: 'b', trackIndex: 1, linkedClipIds: ['a'] })
    const later = clip({ id: 'c', trackIndex: 0, startTime: 10, duration: 4 })
    const untouched = clip({ id: 'd', trackIndex: 2, startTime: 10, duration: 4 })

    const result = rippleDeleteSpan([a, b, later, untouched], 'a', 3, 5)

    // a and b each split (2 pieces each) + c shifted + d untouched = 6
    expect(result).toHaveLength(6)
    const c = result.find((r) => r.id === 'c')!
    const d = result.find((r) => r.id === 'd')!
    expect(c.startTime).toBe(8) // 10 - amount(2): rippled because on a cut track
    expect(d.startTime).toBe(10) // untouched track 2 stays put
  })
})

describe('rippleDeleteSpan — edge cases', () => {
  it('removes a whole clip when the span covers it entirely', () => {
    const result = rippleDeleteSpan([clip({ id: 'a' })], 'a', 0, 10)
    expect(result).toHaveLength(0)
  })

  it('is a no-op for an unknown clip id', () => {
    const input = [clip({ id: 'a' })]
    expect(rippleDeleteSpan(input, 'missing', 1, 2)).toBe(input)
  })
})

describe('snapSpanToSilence', () => {
  const words = [
    { start: 0, end: 0.4 },
    { start: 0.6, end: 1.0 },
    { start: 1.5, end: 2.0 },
  ]
  it('snaps interior cuts to the gap midpoints', () => {
    expect(snapSpanToSilence(words, 1, 1)).toEqual({ start: 0.5, end: 1.25 })
  })
  it('falls back to the exact boundary at the clip head/tail', () => {
    expect(snapSpanToSilence(words, 0, 0)).toEqual({ start: 0, end: 0.5 })
    expect(snapSpanToSilence(words, 2, 2)).toEqual({ start: 1.25, end: 2.0 })
  })
})
