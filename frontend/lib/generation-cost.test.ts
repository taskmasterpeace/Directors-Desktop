import { describe, it, expect } from 'vitest'
import {
  snapFrames,
  estimateRenderSeconds,
  estimateTotalSeconds,
  estimateBatchSeconds,
  modelSwitchPenaltySeconds,
  groupingSavingsSeconds,
  formatDuration,
  formatEtaRange,
  resolveLocalSize,
  MODEL_LOAD_SECONDS,
  ETA_VARIANCE,
} from './generation-cost'

/**
 * Measured on the RTX 4090, MiniMax H3 int8 omni-reference, warm, 20 steps.
 * These are the runs the model was fitted to — they double as a regression
 * guard: if someone retunes the constants and these drift badly, the ETAs
 * shown in the app have silently become wrong.
 */
const MEASURED: ReadonlyArray<[label: string, w: number, h: number, secs: number, actual: number]> = [
  ['352p 5s', 608, 352, 5, 52],
  ['480p 5s', 864, 480, 5, 116.2],
  ['480p portrait 5s', 480, 864, 5, 126.1],
  ['544p 5s', 960, 544, 5, 211.7],
  ['544p 10s', 960, 544, 10, 686.1],
  ['544p 15s', 960, 544, 15, 1017.6],
  ['720p 15s', 1280, 704, 15, 2523],
  ['768 native 15s', 1344, 768, 15, 4594.4],
]

describe('snapFrames', () => {
  it('snaps to the 17k+5 grid the model actually generates', () => {
    expect(snapFrames(5)).toBe(124)
    expect(snapFrames(15)).toBe(362)
    // Every snapped value must sit on the grid.
    for (const secs of [1, 2, 4, 5, 7, 10, 12, 15]) {
      expect((snapFrames(secs) - 5) % 17).toBe(0)
    }
  })

  it('never returns fewer than the node minimum of 5 frames', () => {
    expect(snapFrames(0.01)).toBeGreaterThanOrEqual(5)
  })
})

describe('estimateRenderSeconds vs measured runs', () => {
  it.each(MEASURED)('%s is within 35%% of measured', (_label, w, h, secs, actual) => {
    const predicted = estimateRenderSeconds(w, h, secs)
    expect(Math.abs(predicted - actual) / actual).toBeLessThan(0.35)
  })

  it('averages under 20% error across all measured runs', () => {
    const errs = MEASURED.map(([, w, h, s, actual]) =>
      Math.abs(estimateRenderSeconds(w, h, s) - actual) / actual)
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length
    expect(mean).toBeLessThan(0.2)
  })

  it('prices portrait identically to landscape — orientation measured free', () => {
    expect(estimateRenderSeconds(480, 864, 5)).toBeCloseTo(estimateRenderSeconds(864, 480, 5), 6)
  })

  it('is superlinear: 720p costs more than 3x 480p at equal duration', () => {
    const p480 = estimateRenderSeconds(864, 480, 15)
    const p720 = estimateRenderSeconds(1280, 704, 15)
    const pixelRatio = (1280 * 704) / (864 * 480)
    expect(p720 / p480).toBeGreaterThan(pixelRatio)
  })

  it('returns 0 for degenerate specs rather than NaN', () => {
    expect(estimateRenderSeconds(0, 480, 5)).toBe(0)
    expect(estimateRenderSeconds(864, 480, 0)).toBe(0)
  })
})

describe('estimateTotalSeconds', () => {
  it('adds the full load when cold and nothing when warm', () => {
    const warm = estimateTotalSeconds(864, 480, 5, 'warm')
    const cold = estimateTotalSeconds(864, 480, 5, 'cold')
    expect(cold - warm).toBeCloseTo(MODEL_LOAD_SECONDS, 6)
  })

  it('treats warming as partway through the load', () => {
    const warming = estimateTotalSeconds(864, 480, 5, 'warming')
    expect(warming).toBeGreaterThan(estimateTotalSeconds(864, 480, 5, 'warm'))
    expect(warming).toBeLessThan(estimateTotalSeconds(864, 480, 5, 'cold'))
  })
})

describe('batch and model-switch costs', () => {
  const shot = { width: 864, height: 480, seconds: 5 }

  it('charges the model load once for a whole batch, not per shot', () => {
    const batch = estimateBatchSeconds([shot, shot, shot], 'cold')
    const perShot = 3 * estimateTotalSeconds(864, 480, 5, 'cold')
    expect(batch).toBeLessThan(perShot)
    expect(batch).toBeCloseTo(3 * estimateRenderSeconds(864, 480, 5) + MODEL_LOAD_SECONDS, 6)
  })

  it('counts a reload for every switch in an interleaved shot list', () => {
    expect(modelSwitchPenaltySeconds(['a', 'b', 'a', 'b'])).toBe(3 * MODEL_LOAD_SECONDS)
    expect(modelSwitchPenaltySeconds(['a', 'a', 'b', 'b'])).toBe(MODEL_LOAD_SECONDS)
    expect(modelSwitchPenaltySeconds(['a', 'a', 'a'])).toBe(0)
    expect(modelSwitchPenaltySeconds([])).toBe(0)
  })

  it('reports what grouping by model would save', () => {
    // Interleaved 2 models across 4 shots: 3 reloads -> 1. Saves 2 loads.
    expect(groupingSavingsSeconds(['a', 'b', 'a', 'b'])).toBe(2 * MODEL_LOAD_SECONDS)
    // Already grouped: nothing to save.
    expect(groupingSavingsSeconds(['a', 'a', 'b', 'b'])).toBe(0)
    expect(groupingSavingsSeconds(['a', 'a', 'a'])).toBe(0)
  })

  it('never claims a negative saving', () => {
    for (const order of [[], ['a'], ['a', 'b'], ['a', 'a', 'b', 'a']]) {
      expect(groupingSavingsSeconds(order)).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('resolveLocalSize', () => {
  it('mirrors the backend resolution map', () => {
    expect(resolveLocalSize('540p')).toEqual({ width: 960, height: 544 })
    expect(resolveLocalSize('512p')).toEqual({ width: 960, height: 544 })
    expect(resolveLocalSize('720p')).toEqual({ width: 1280, height: 704 })
    expect(resolveLocalSize('1080p')).toEqual({ width: 1920, height: 1088 })
  })

  it('transposes for portrait rather than inventing a new size', () => {
    expect(resolveLocalSize('720p', '9:16')).toEqual({ width: 704, height: 1280 })
  })

  it('costs portrait and landscape the same', () => {
    const l = resolveLocalSize('720p', '16:9')
    const p = resolveLocalSize('720p', '9:16')
    expect(estimateRenderSeconds(p.width, p.height, 5))
      .toBeCloseTo(estimateRenderSeconds(l.width, l.height, 5), 6)
  })

  it('falls back to a sane size for an unknown resolution', () => {
    expect(resolveLocalSize('banana')).toEqual({ width: 960, height: 544 })
  })
})

describe('formatting', () => {
  it('scales units so the number stays readable', () => {
    expect(formatDuration(45)).toBe('45 sec')
    expect(formatDuration(150)).toBe('2.5 min')
    expect(formatDuration(540)).toBe('9 min') // not "9.0 min"
    expect(formatDuration(1800)).toBe('30 min')
    expect(formatDuration(3600)).toBe('1 hr')
    expect(formatDuration(4320)).toBe('1 hr 12 min')
  })

  it('handles zero and nonsense without emitting NaN', () => {
    expect(formatDuration(0)).toBe('0 sec')
    expect(formatDuration(Number.NaN)).toBe('0 sec')
    expect(formatEtaRange(-5)).toBe('0 sec')
  })

  it('renders a band, never a bare point estimate', () => {
    const range = formatEtaRange(600)
    expect(range).toContain('–')
    // The band must actually straddle the estimate.
    expect(600 * (1 - ETA_VARIANCE)).toBeLessThan(600)
    expect(600 * (1 + ETA_VARIANCE)).toBeGreaterThan(600)
  })
})
