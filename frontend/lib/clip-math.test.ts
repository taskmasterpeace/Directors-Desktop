import { describe, it, expect } from 'vitest'
import {
  clamp,
  effectiveLength,
  buildSelection,
  maxStart,
  nudgeSelection,
  formatClock,
  suggestOutputName,
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
