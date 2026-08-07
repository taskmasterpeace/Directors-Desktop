import { describe, it, expect } from 'vitest'
import {
  buildRegenWithRefRequest,
  validateRegenWithRef,
  clampRegenDuration,
  SEEDANCE_MAX_SECONDS,
  REF_CAPS,
} from './regen-with-reference'

describe('regen-with-reference — the render request', () => {
  const base = {
    clipDurationSeconds: 5.2,
    prompt: 'a rapper on a rooftop at dusk',
    referenceImagePaths: ['C:/frames/crop.jpg'],
    videoReferencePaths: [] as string[],
  }

  it('renders at the clip length, rounded and clamped to 1..15s', () => {
    expect(clampRegenDuration(5.2)).toBe(5)
    expect(clampRegenDuration(5.6)).toBe(6)
    expect(clampRegenDuration(0.3)).toBe(1)          // floor at 1
    expect(clampRegenDuration(42)).toBe(SEEDANCE_MAX_SECONDS) // cap at 15
    expect(clampRegenDuration(NaN)).toBe(1)          // never NaN in the request
    expect(buildRegenWithRefRequest(base).params.duration).toBe('5')
  })

  it('always targets Seedance 2.0 (the omni-reference engine) with the refs attached', () => {
    const req = buildRegenWithRefRequest({ ...base, videoReferencePaths: ['C:/clips/ref.mp4'] })
    expect(req.type).toBe('video')
    expect(req.model).toBe('seedance-2.0')
    expect(req.params.referenceImagePaths).toEqual(['C:/frames/crop.jpg'])
    expect(req.params.videoReferencePaths).toEqual(['C:/clips/ref.mp4'])
  })

  it('appends the note to the base prompt, and survives an empty prompt', () => {
    expect(buildRegenWithRefRequest({ ...base, note: 'more rain, keep the camera move' }).params.prompt)
      .toBe('a rapper on a rooftop at dusk, more rain, keep the camera move')
    expect(buildRegenWithRefRequest({ ...base, prompt: '', note: 'slower push-in' }).params.prompt)
      .toBe('slower push-in')
    expect(buildRegenWithRefRequest({ ...base, prompt: '', note: '' }).params.prompt)
      .toBe('regenerate this shot') // never an empty prompt
  })

  it('carries resolution/aspect/seed through, with sensible defaults', () => {
    const def = buildRegenWithRefRequest(base).params
    expect(def.resolution).toBe('720p')
    expect(def.aspectRatio).toBe('16:9')
    expect(def.seed).toBeUndefined()
    const custom = buildRegenWithRefRequest({ ...base, resolution: '1080p', aspectRatio: '9:16', seed: 4242 }).params
    expect(custom).toMatchObject({ resolution: '1080p', aspectRatio: '9:16', seed: 4242 })
  })

  it('validation requires at least one reference and enforces the omni-ref caps', () => {
    expect(validateRegenWithRef({ referenceImagePaths: [], videoReferencePaths: [] }))
      .toHaveLength(1) // "add at least one reference"
    expect(validateRegenWithRef({ referenceImagePaths: ['a'], videoReferencePaths: [] })).toHaveLength(0)
    expect(validateRegenWithRef({ referenceImagePaths: [], videoReferencePaths: ['v'] })).toHaveLength(0)
    const tooManyImgs = Array.from({ length: REF_CAPS.image + 1 }, (_, i) => `img${i}`)
    expect(validateRegenWithRef({ referenceImagePaths: tooManyImgs, videoReferencePaths: [] }).some((e) => e.includes('image references'))).toBe(true)
    const tooManyVids = Array.from({ length: REF_CAPS.video + 1 }, (_, i) => `v${i}`)
    expect(validateRegenWithRef({ referenceImagePaths: [], videoReferencePaths: tooManyVids }).some((e) => e.includes('clip references'))).toBe(true)
  })
})
