import { describe, it, expect } from 'vitest'
import { LTX_LORAS, getLtxLora } from './ltx-loras'

describe('ltx-loras registry', () => {
  it('exposes a PUBLIC (usable) object-removal LoRA — the inpaint remover', () => {
    const rem = LTX_LORAS.find(l => l.id === 'ltx-2.3-inpaint-remover.safetensors')
    expect(rem).toBeTruthy()
    expect(rem!.gated).toBeFalsy()  // downloadable without a token — works out of the box
    expect(rem!.label.toLowerCase()).toContain('removal')
    // and it's a bare filename (no subfolder) so ComfyUI resolves it cleanly
    expect(rem!.id).not.toContain('/')
  })

  it('also lists the gated Lightricks clean-plate as an alternative, with a license URL', () => {
    const cp = LTX_LORAS.find(l => l.id.includes('clean-plate'))
    expect(cp).toBeTruthy()
    expect(cp!.gated).toBe(true)
    expect(cp!.licenseUrl).toContain('huggingface.co')
  })

  it('union-control is public (not gated) and flagged as needing a control source', () => {
    const uc = LTX_LORAS.find(l => l.id.includes('union-control'))
    expect(uc).toBeTruthy()
    expect(uc!.gated).toBeFalsy()
    expect(uc!.needsControl).toBe(true)
  })

  it('getLtxLora resolves by id and tolerates undefined/unknown', () => {
    expect(getLtxLora(undefined)).toBeUndefined()
    expect(getLtxLora(null)).toBeUndefined()
    expect(getLtxLora('does-not-exist')).toBeUndefined()
    expect(getLtxLora(LTX_LORAS[0]!.id)?.id).toBe(LTX_LORAS[0]!.id)
  })

  it('every entry has a positive default strength and a real description', () => {
    for (const l of LTX_LORAS) {
      expect(l.defaultStrength).toBeGreaterThan(0)
      expect(l.defaultStrength).toBeLessThanOrEqual(1.5)
      expect(l.description.length).toBeGreaterThan(10)
    }
  })
})
