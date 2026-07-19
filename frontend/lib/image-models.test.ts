import { describe, it, expect } from 'vitest'
import {
  IMAGE_MODELS,
  PALETTE_IMAGE_MODELS,
  DEFAULT_IMAGE_MODEL_ID,
  migrateImageModelId,
  getImageModel,
  isPaletteImageModel,
  getImageModelCost,
  coerceAspectRatio,
  supportsReferences,
  listImageModelGroups,
} from './image-models'

describe('image model registry', () => {
  it('offers exactly the four current Palette models', () => {
    expect(PALETTE_IMAGE_MODELS.map((m) => m.id)).toEqual([
      'dp-nano-banana-2',
      'dp-nano-banana-2-lite',
      'dp-gpt-image-2',
      'dp-qwen-image-edit',
    ])
  })

  it('never offers the retired flux Palette model', () => {
    expect(IMAGE_MODELS.some((m) => m.id === 'dp-flux-2-klein-9b')).toBe(false)
    expect(listImageModelGroups().flatMap((g) => g.models).some((m) => m.id === 'dp-flux-2-klein-9b')).toBe(false)
  })

  it('has unique ids', () => {
    const ids = IMAGE_MODELS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('migrateImageModelId', () => {
  it('redirects the retired Palette flux model', () => {
    expect(migrateImageModelId('dp-flux-2-klein-9b')).toBe('dp-nano-banana-2')
  })

  it('redirects other deprecated ids', () => {
    expect(migrateImageModelId('dp-seedream-5-lite')).toBe('dp-nano-banana-2')
    expect(migrateImageModelId('flux-2-klein-9b')).toBe('flux-klein-9b')
  })

  it('passes through known ids untouched', () => {
    expect(migrateImageModelId('dp-gpt-image-2')).toBe('dp-gpt-image-2')
    expect(migrateImageModelId('z-image-turbo')).toBe('z-image-turbo')
  })

  it('falls back to the default for unknown or empty ids', () => {
    expect(migrateImageModelId('totally-made-up')).toBe(DEFAULT_IMAGE_MODEL_ID)
    expect(migrateImageModelId(null)).toBe(DEFAULT_IMAGE_MODEL_ID)
    expect(migrateImageModelId('')).toBe(DEFAULT_IMAGE_MODEL_ID)
  })
})

describe('getImageModel', () => {
  it('resolves a retired id to its replacement config', () => {
    expect(getImageModel('dp-flux-2-klein-9b').id).toBe('dp-nano-banana-2')
  })

  it('marks Camera Angle as requiring an input image with a single reference', () => {
    const camera = getImageModel('dp-qwen-image-edit')
    expect(camera.requiresInputImage).toBe(true)
    expect(camera.maxReferenceImages).toBe(1)
    expect(camera.supportsCameraAngle).toBe(true)
  })

  it('classifies providers', () => {
    expect(isPaletteImageModel('dp-nano-banana-2')).toBe(true)
    expect(isPaletteImageModel('z-image-turbo')).toBe(false)
    expect(getImageModel('nano-banana-2').provider).toBe('replicate')
  })
})

describe('getImageModelCost', () => {
  it('uses flat cost for the nano models', () => {
    expect(getImageModelCost('dp-nano-banana-2')).toBe(10)
    expect(getImageModelCost('dp-nano-banana-2-lite')).toBe(5)
    expect(getImageModelCost('dp-qwen-image-edit')).toBe(5)
  })

  it('is quality-tiered for gpt-image-2', () => {
    expect(getImageModelCost('dp-gpt-image-2', 'low')).toBe(2)
    expect(getImageModelCost('dp-gpt-image-2', 'medium')).toBe(8)
    // unknown/absent quality falls back to the base cost
    expect(getImageModelCost('dp-gpt-image-2')).toBe(2)
  })

  it('is free for local GPU models', () => {
    expect(getImageModelCost('z-image-turbo')).toBe(0)
    expect(getImageModelCost('flux-dev')).toBe(0)
  })
})

describe('coerceAspectRatio', () => {
  it('keeps a supported ratio as-is', () => {
    expect(coerceAspectRatio('dp-nano-banana-2', '16:9')).toBe('16:9')
    expect(coerceAspectRatio('dp-gpt-image-2', '3:2')).toBe('3:2')
  })

  it('narrows unsupported ratios to the nearest gpt-image-2 orientation', () => {
    expect(coerceAspectRatio('dp-gpt-image-2', '16:9')).toBe('3:2')
    expect(coerceAspectRatio('dp-gpt-image-2', '9:16')).toBe('2:3')
    expect(coerceAspectRatio('dp-gpt-image-2', '1:1')).toBe('1:1')
    expect(coerceAspectRatio('dp-gpt-image-2', '4:3')).toBe('3:2')
  })
})

describe('supportsReferences', () => {
  it('is true for reference-capable models and false for local text-to-image', () => {
    expect(supportsReferences('dp-nano-banana-2')).toBe(true)
    expect(supportsReferences('dp-qwen-image-edit')).toBe(true)
    expect(supportsReferences('z-image-turbo')).toBe(false)
  })
})
