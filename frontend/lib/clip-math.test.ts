import { describe, it, expect } from 'vitest'
import {
  clamp,
  effectiveLength,
  buildSelection,
  maxStart,
  nudgeSelection,
  resizeEdge,
  formatClock,
  formatLength,
  suggestOutputName,
  suggestReferenceName,
  MIN_CLIP_LENGTH,
  MAX_CLIP_LENGTH,
  MAX_REFERENCE_LENGTH,
} from './clip-math'

describe('clamp', () => {
  it('bounds within range', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-3, 0, 10)).toBe(0)
    expect(clamp(99, 0, 10)).toBe(10)
  })
  it('returns min for NaN', () => {
    expect(clamp(NaN, 2, 10)).toBe(2)
  })
})

describe('effectiveLength', () => {
  it('caps to source when source is shorter than desired', () => {
    expect(effectiveLength(8, 15)).toBe(8)
    expect(effectiveLength(40, 30)).toBe(30)
  })
  it('is 0 for invalid durations', () => {
    expect(effectiveLength(0, 15)).toBe(0)
    expect(effectiveLength(NaN, 30)).toBe(0)
    expect(effectiveLength(Infinity, 15)).toBe(0)
  })
})

describe('buildSelection', () => {
  it('anchors a 15s window inside a long source', () => {
    const s = buildSelection(100, 15, 20)
    expect(s).toEqual({ start: 20, end: 35, length: 15 })
  })
  it('pins the window so it never runs past the end', () => {
    const s = buildSelection(100, 30, 95)
    expect(s.end).toBe(100)
    expect(s.start).toBe(70)
    expect(s.length).toBe(30)
  })
  it('clamps negative start to 0', () => {
    const s = buildSelection(100, 15, -10)
    expect(s.start).toBe(0)
    expect(s.end).toBe(15)
  })
  it('spans the whole source when source is shorter than desired', () => {
    const s = buildSelection(10, 15, 5)
    expect(s).toEqual({ start: 0, end: 10, length: 10 })
  })
  it('returns an empty selection for a zero-length source', () => {
    expect(buildSelection(0, 30, 0)).toEqual({ start: 0, end: 0, length: 0 })
  })
})

describe('maxStart', () => {
  it('is duration minus length', () => {
    expect(maxStart(100, 30)).toBe(70)
  })
  it('is 0 when source is shorter than desired', () => {
    expect(maxStart(10, 15)).toBe(0)
  })
})

describe('nudgeSelection', () => {
  const sel = { start: 20, end: 35, length: 15 }
  it('moves forward keeping length fixed', () => {
    expect(nudgeSelection(sel, 100, 5)).toEqual({ start: 25, end: 40, length: 15 })
  })
  it('stops at the end of the source', () => {
    expect(nudgeSelection(sel, 40, 100)).toEqual({ start: 25, end: 40, length: 15 })
  })
  it('stops at 0 going backward', () => {
    expect(nudgeSelection(sel, 100, -999)).toEqual({ start: 0, end: 15, length: 15 })
  })
})

describe('resizeEdge', () => {
  const sel = { start: 20, end: 35, length: 15 }

  it('moves the start edge, keeping the end fixed', () => {
    expect(resizeEdge(sel, 100, 'start', 25)).toEqual({ start: 25, end: 35, length: 10 })
  })
  it('moves the end edge, keeping the start fixed', () => {
    expect(resizeEdge(sel, 100, 'end', 30)).toEqual({ start: 20, end: 30, length: 10 })
  })
  it('enforces the minimum length from the start edge', () => {
    const next = resizeEdge(sel, 100, 'start', 34.9)
    expect(next.length).toBeCloseTo(MIN_CLIP_LENGTH)
    expect(next.end).toBe(35)
  })
  it('enforces the minimum length from the end edge', () => {
    const next = resizeEdge(sel, 100, 'end', 20.1)
    expect(next.length).toBeCloseTo(MIN_CLIP_LENGTH)
    expect(next.start).toBe(20)
  })
  it('caps growth at the maximum length', () => {
    const next = resizeEdge(sel, 100, 'end', 99)
    expect(next.length).toBe(MAX_CLIP_LENGTH)
    expect(next.start).toBe(20)
    expect(next.end).toBe(50)
  })
  it('caps the start edge at the maximum length too', () => {
    const next = resizeEdge({ start: 40, end: 50, length: 10 }, 100, 'start', 0)
    expect(next.length).toBe(MAX_CLIP_LENGTH)
    expect(next.end).toBe(50)
    expect(next.start).toBe(20)
  })
  it('never runs past the end of the source', () => {
    const next = resizeEdge({ start: 90, end: 95, length: 5 }, 100, 'end', 200)
    expect(next.end).toBe(100)
  })
  it('respects a custom max length (the 15s reference cap)', () => {
    const next = resizeEdge(sel, 100, 'end', 99, MIN_CLIP_LENGTH, MAX_REFERENCE_LENGTH)
    expect(next.length).toBe(MAX_REFERENCE_LENGTH)
  })
  it('spans a source shorter than the minimum length', () => {
    const next = resizeEdge({ start: 0, end: 0.3, length: 0.3 }, 0.3, 'end', 0.1)
    expect(next).toEqual({ start: 0, end: 0.3, length: 0.3 })
  })
  it('returns an empty selection for a zero-length source', () => {
    expect(resizeEdge(sel, 0, 'end', 10)).toEqual({ start: 0, end: 0, length: 0 })
  })
})

describe('formatLength', () => {
  it('shows whole seconds without decimals', () => {
    expect(formatLength(15)).toBe('15s')
    expect(formatLength(15.04)).toBe('15s')
  })
  it('shows one decimal for fractional lengths', () => {
    expect(formatLength(12.5)).toBe('12.5s')
    expect(formatLength(0.55)).toBe('0.6s')
  })
  it('handles negatives and NaN as 0', () => {
    expect(formatLength(-3)).toBe('0s')
    expect(formatLength(NaN)).toBe('0s')
  })
})

describe('formatClock', () => {
  it('formats M:SS', () => {
    expect(formatClock(5)).toBe('0:05')
    expect(formatClock(75)).toBe('1:15')
  })
  it('formats H:MM:SS past an hour', () => {
    expect(formatClock(3661)).toBe('1:01:01')
  })
  it('handles negatives and NaN as 0', () => {
    expect(formatClock(-5)).toBe('0:00')
    expect(formatClock(NaN)).toBe('0:00')
  })
})

describe('suggestOutputName', () => {
  it('builds a descriptive mp4 name', () => {
    expect(suggestOutputName('movie.mov', { start: 20, end: 35, length: 15 })).toBe(
      'movie_clip_20s_15s.mp4',
    )
  })
  it('handles names without an extension', () => {
    expect(suggestOutputName('clip', { start: 0, end: 30, length: 30 })).toBe('clip_clip_0s_30s.mp4')
  })
})

describe('suggestReferenceName', () => {
  const sel = { start: 20, end: 32, length: 12 }
  it('builds a stamped mp4 name', () => {
    expect(suggestReferenceName('movie.mov', sel, 123456789)).toBe('movie_ref_20s_12s_456789.mp4')
  })
  it('sanitizes unsafe characters from the source name', () => {
    expect(suggestReferenceName('my clip (1080p)!.mp4', sel, 42)).toBe(
      'my_clip_1080p_ref_20s_12s_42.mp4',
    )
  })
  it('falls back when the name is all-unsafe', () => {
    expect(suggestReferenceName('???.mp4', sel, 7)).toBe('clip_ref_20s_12s_7.mp4')
  })
})
