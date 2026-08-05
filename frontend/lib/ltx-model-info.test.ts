import { describe, it, expect } from 'vitest'
import { explainLtxModel, assessGpuFit } from './ltx-model-info'

describe('explainLtxModel', () => {
  it('classifies the four files a user actually sees', () => {
    expect(explainLtxModel('ltx-2.3-22b-dev.safetensors').kind).toBe('dev')
    expect(explainLtxModel('ltx-2.3-22b-distilled.safetensors').kind).toBe('distilled')
    expect(explainLtxModel('ltx-2.3-22b-distilled-lora-384.safetensors').kind).toBe('speed-lora')
    expect(explainLtxModel('ltx-2.3-spatial-upscaler-x2-1.0.safetensors').kind).toBe('upscaler')
  })

  it('treats add-ons (lora, upscaler, encoder) as non-generators', () => {
    expect(explainLtxModel('ltx-2.3-22b-distilled-lora-384.safetensors').isGenerator).toBe(false)
    expect(explainLtxModel('ltx-2.3-spatial-upscaler-x2-1.0.safetensors').isGenerator).toBe(false)
    expect(explainLtxModel('gemma-3-12b-it.safetensors').kind).toBe('encoder')
  })

  it('checks add-ons before base kinds (distilled-lora is a LoRA, not distilled)', () => {
    // "distilled-lora" contains "distilled" but must resolve to the LoRA add-on.
    expect(explainLtxModel('ltx-2.3-22b-distilled-lora-384.safetensors').kind).toBe('speed-lora')
  })

  it('base generators are generators', () => {
    expect(explainLtxModel('ltx-2.3-22b-dev.safetensors').isGenerator).toBe(true)
    expect(explainLtxModel('ltx-2.3-22b-distilled.safetensors').isGenerator).toBe(true)
  })
})

describe('assessGpuFit', () => {
  it('flags the 43GB BF16 model as too big for a 24GB card', () => {
    const fit = assessGpuFit(43, 24, true)
    expect(fit.level).toBe('too-big')
    expect(fit.note).toMatch(/fp8|GGUF/)
  })

  it('calls fp8 (~22GB) tight on 24GB and GGUF (~15GB) a comfortable fit', () => {
    expect(assessGpuFit(22, 24, true).level).toBe('tight')
    expect(assessGpuFit(15, 24, true).level).toBe('fits')
  })

  it('skips the VRAM check for add-ons', () => {
    expect(assessGpuFit(0.9, 24, false).level).toBe('addon')
  })

  it('does not crash when no GPU is detected', () => {
    expect(assessGpuFit(22, null, true).level).toBe('tight')
  })
})
