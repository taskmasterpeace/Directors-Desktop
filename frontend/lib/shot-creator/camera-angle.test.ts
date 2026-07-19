import { describe, it, expect } from 'vitest'
import {
  getAzimuthLabel,
  getElevationLabel,
  getDistanceLabel,
  buildCameraAnglePrompt,
  getCameraAngleDescription,
  CAMERA_PRESETS,
  DEFAULT_CAMERA_ANGLE,
} from './camera-angle'

describe('getAzimuthLabel', () => {
  it('maps the 8 cardinal/quarter views', () => {
    expect(getAzimuthLabel(0)).toBe('front view')
    expect(getAzimuthLabel(45)).toBe('front-right quarter view')
    expect(getAzimuthLabel(90)).toBe('right side view')
    expect(getAzimuthLabel(135)).toBe('back-right quarter view')
    expect(getAzimuthLabel(180)).toBe('back view')
    expect(getAzimuthLabel(225)).toBe('back-left quarter view')
    expect(getAzimuthLabel(270)).toBe('left side view')
    expect(getAzimuthLabel(315)).toBe('front-left quarter view')
  })
  it('handles the wrapping front segment (337.5–360 and 0–22.5)', () => {
    expect(getAzimuthLabel(350)).toBe('front view')
    expect(getAzimuthLabel(360)).toBe('front view')
    expect(getAzimuthLabel(10)).toBe('front view')
  })
  it('normalizes out-of-range and negative azimuths', () => {
    expect(getAzimuthLabel(450)).toBe('right side view') // 450 → 90
    expect(getAzimuthLabel(-90)).toBe('left side view') // -90 → 270
  })
})

describe('getElevationLabel', () => {
  it('maps the 4 elevation bands', () => {
    expect(getElevationLabel(-30)).toBe('low-angle shot')
    expect(getElevationLabel(0)).toBe('eye-level shot')
    expect(getElevationLabel(30)).toBe('elevated shot')
    expect(getElevationLabel(60)).toBe('high-angle shot')
  })
  it('clamps beyond the supported range', () => {
    expect(getElevationLabel(-90)).toBe('low-angle shot')
    expect(getElevationLabel(120)).toBe('high-angle shot')
  })
})

describe('getDistanceLabel', () => {
  it('maps the 3 distance bands', () => {
    expect(getDistanceLabel(1)).toBe('wide shot')
    expect(getDistanceLabel(5)).toBe('medium shot')
    expect(getDistanceLabel(9)).toBe('close-up')
  })
  it('clamps out-of-range distances', () => {
    expect(getDistanceLabel(-5)).toBe('wide shot')
    expect(getDistanceLabel(50)).toBe('close-up')
  })
})

describe('buildCameraAnglePrompt', () => {
  it('produces the <sks> token in azimuth/elevation/distance order', () => {
    expect(buildCameraAnglePrompt({ azimuth: 90, elevation: 30, distance: 9 })).toBe(
      '<sks> right side view elevated shot close-up',
    )
  })
  it('handles the default angle', () => {
    expect(buildCameraAnglePrompt(DEFAULT_CAMERA_ANGLE)).toBe('<sks> front view eye-level shot medium shot')
  })
})

describe('getCameraAngleDescription', () => {
  it('is comma-joined and has no <sks> token', () => {
    expect(getCameraAngleDescription({ azimuth: 180, elevation: 0, distance: 5 })).toBe(
      'back view, eye-level shot, medium shot',
    )
  })
})

describe('CAMERA_PRESETS', () => {
  it('has the 8 named presets', () => {
    expect(CAMERA_PRESETS.map((p) => p.name)).toEqual([
      'Front', 'Right', 'Back', 'Left', 'Hero Low', "Bird's Eye", 'Close-up', 'Wide',
    ])
  })
  it("Hero Low renders a low, wide-ish hero framing", () => {
    const hero = CAMERA_PRESETS.find((p) => p.name === 'Hero Low')!
    expect(buildCameraAnglePrompt(hero.angle)).toBe('<sks> front-right quarter view low-angle shot close-up')
  })
})
