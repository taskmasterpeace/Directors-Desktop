import { describe, it, expect } from 'vitest'
import {
  clampSeekTime,
  scaledDimensions,
  jpegQualityFromFfmpegQ,
  tempFrameName,
} from './video-frames'

describe('clampSeekTime', () => {
  it('passes through in-range seeks', () => {
    expect(clampSeekTime(3, 10)).toBe(3)
  })
  it('clamps the "9999 means last frame" convention to just before EOF', () => {
    expect(clampSeekTime(9999, 8)).toBeCloseTo(7.95)
  })
  it('clamps negatives and NaN to 0', () => {
    expect(clampSeekTime(-2, 10)).toBe(0)
    expect(clampSeekTime(NaN, 10)).toBe(0)
  })
  it('returns 0 for invalid durations', () => {
    expect(clampSeekTime(5, 0)).toBe(0)
    expect(clampSeekTime(5, NaN)).toBe(0)
  })
  it('never goes negative for ultra-short media', () => {
    expect(clampSeekTime(5, 0.01)).toBe(0)
  })
})

describe('scaledDimensions', () => {
  it('keeps natural size without a target', () => {
    expect(scaledDimensions(1920, 1080)).toEqual({ width: 1920, height: 1080 })
  })
  it('scales to target width preserving aspect', () => {
    expect(scaledDimensions(1920, 1080, 512)).toEqual({ width: 512, height: 288 })
  })
  it('handles portrait video', () => {
    expect(scaledDimensions(1080, 1920, 512)).toEqual({ width: 512, height: 910 })
  })
  it('returns zeros for degenerate input', () => {
    expect(scaledDimensions(0, 1080, 512)).toEqual({ width: 0, height: 0 })
  })
})

describe('jpegQualityFromFfmpegQ', () => {
  it('maps the default high-quality settings', () => {
    expect(jpegQualityFromFfmpegQ(undefined)).toBe(0.92)
    expect(jpegQualityFromFfmpegQ(2)).toBe(0.92)
  })
  it('maps the thumbnail-quality setting used by gap generation', () => {
    expect(jpegQualityFromFfmpegQ(3)).toBe(0.85)
  })
  it('degrades but stays in a sane band for higher q values', () => {
    const q10 = jpegQualityFromFfmpegQ(10)
    expect(q10).toBeGreaterThanOrEqual(0.7)
    expect(q10).toBeLessThan(0.92)
  })
})

describe('tempFrameName', () => {
  it('builds a jpg in the ltx_frame family', () => {
    expect(tempFrameName(1234, 'abc123')).toBe('ltx_frame_hw_1234_abc123.jpg')
  })
  it('sanitizes the random component', () => {
    expect(tempFrameName(1, '!!//..')).toBe('ltx_frame_hw_1_x.jpg')
  })
})
