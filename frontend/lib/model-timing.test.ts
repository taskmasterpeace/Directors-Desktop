import { beforeEach, describe, expect, it } from 'vitest'
import { getModelAvgSeconds, getPersonalEtaSeconds, recordModelTiming } from './model-timing'

// The suite runs in plain Node — give the module a real localStorage.
class MemStorage {
  private store = new Map<string, string>()
  getItem(k: string): string | null { return this.store.get(k) ?? null }
  setItem(k: string, v: string): void { this.store.set(k, String(v)) }
  removeItem(k: string): void { this.store.delete(k) }
  clear(): void { this.store.clear() }
}

describe('model timing memory', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemStorage()
  })

  it('warm and cold samples never blend', () => {
    recordModelTiming('ltx-comfy', 90_000, false)
    recordModelTiming('ltx-comfy', 100_000, false)
    recordModelTiming('ltx-comfy', 1_012_000, true)
    expect(getModelAvgSeconds('ltx-comfy', false)).toBeCloseTo(95, 0)
    expect(getModelAvgSeconds('ltx-comfy', true)).toBeCloseTo(1012, 0)
  })

  it('personal ETA needs two samples, average needs one', () => {
    recordModelTiming('h3-local', 340_000, false)
    expect(getModelAvgSeconds('h3-local', false)).toBeCloseTo(340, 0)
    expect(getPersonalEtaSeconds('h3-local', false)).toBeNull()
    recordModelTiming('h3-local', 360_000, false)
    expect(getPersonalEtaSeconds('h3-local', false)).toBeCloseTo(350, 0)
  })

  it('keeps only the last 8 samples per bucket', () => {
    for (let i = 1; i <= 10; i++) recordModelTiming('m', i * 1000, false)
    // Last 8 samples = 3..10 seconds → average 6.5s
    expect(getModelAvgSeconds('m', false)).toBeCloseTo(6.5, 1)
  })

  it('rejects garbage', () => {
    recordModelTiming('', 5000, false)
    recordModelTiming('m', -5, false)
    recordModelTiming('m', NaN, false)
    expect(getModelAvgSeconds('m', false)).toBeNull()
  })
})
