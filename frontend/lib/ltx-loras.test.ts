import { describe, it, expect } from 'vitest'
import { LTX_LORAS, applyLtxTrigger, getLtxLora, mergeLtxLoras } from './ltx-loras'
import type { LocalLtxLoraEntry } from './ltx-loras'

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

describe('mergeLtxLoras — curated + drop-a-file discoveries', () => {
  const scanned: LocalLtxLoraEntry[] = [
    {
      file: 'CozyFelt.safetensors',
      name: 'CozyFelt',
      sizeBytes: 352_679_880,
      thumbnail: 'C:\\Users\\x\\loras\\CozyFelt.png',
      trigger: 'F3ltCut0u7, felt cutout style',
    },
    { file: 'Plain.safetensors', name: 'Plain', sizeBytes: 10, thumbnail: null, trigger: null },
  ]

  it('appends local entries after the curated registry, flagged local', () => {
    const merged = mergeLtxLoras(LTX_LORAS, scanned)
    expect(merged.slice(0, LTX_LORAS.length)).toEqual([...LTX_LORAS])
    const felt = merged.find(l => l.id === 'CozyFelt.safetensors')
    expect(felt).toBeTruthy()
    expect(felt!.local).toBe(true)
    expect(felt!.type).toBe('style')
    expect(felt!.defaultStrength).toBe(1.0)
    expect(felt!.thumbnailPath).toContain('CozyFelt.png')
    expect(felt!.trigger).toContain('F3ltCut0u7')
    expect(felt!.description).toContain('F3ltCut0u7')
  })

  it('curated wins on id collision — richer metadata', () => {
    const shadow: LocalLtxLoraEntry = {
      file: LTX_LORAS[0]!.id, name: 'shadow', sizeBytes: 1, thumbnail: null, trigger: null,
    }
    const merged = mergeLtxLoras(LTX_LORAS, [shadow])
    expect(merged.filter(l => l.id === LTX_LORAS[0]!.id)).toHaveLength(1)
    expect(merged.find(l => l.id === LTX_LORAS[0]!.id)!.local).toBeUndefined()
  })

  it('getLtxLora resolves local ids when handed the merged list', () => {
    const merged = mergeLtxLoras(LTX_LORAS, scanned)
    expect(getLtxLora('CozyFelt.safetensors')).toBeUndefined()          // static list: unknown
    expect(getLtxLora('CozyFelt.safetensors', merged)?.local).toBe(true) // merged list: found
  })

  it('other engine families never leak into the LTX picker', () => {
    const withH3: LocalLtxLoraEntry[] = [
      ...scanned,
      { file: 'h3/Turbo.safetensors', name: 'Turbo', sizeBytes: 5, family: 'h3', thumbnail: null, trigger: null },
      { file: 'flux/Sketch.safetensors', name: 'Sketch', sizeBytes: 5, family: 'flux', thumbnail: null, trigger: null },
    ]
    const merged = mergeLtxLoras(LTX_LORAS, withH3)
    expect(merged.some(l => l.id.startsWith('h3/') || l.id.startsWith('flux/'))).toBe(false)
    expect(merged.some(l => l.id === 'CozyFelt.safetensors')).toBe(true)
    // Backends that predate the family field are treated as LTX.
    const legacy = mergeLtxLoras(LTX_LORAS, [{ file: 'Old.safetensors', name: 'Old', sizeBytes: 1, thumbnail: null, trigger: null }])
    expect(legacy.some(l => l.id === 'Old.safetensors')).toBe(true)
  })
})

describe('applyLtxTrigger — sidecar trigger words ride the prompt', () => {
  it('prepends the trigger before the prompt', () => {
    expect(applyLtxTrigger('a bear cub in a forest', 'F3ltCut0u7, felt cutout style'))
      .toBe('F3ltCut0u7, felt cutout style, a bear cub in a forest')
  })

  it('never doubles when the prompt already carries the trigger token', () => {
    const already = 'F3ltCut0u7 bear cub in a felt forest'
    expect(applyLtxTrigger(already, 'F3ltCut0u7, felt cutout style')).toBe(already)
    expect(applyLtxTrigger('a f3ltcut0u7 scene', 'F3ltCut0u7')).toBe('a f3ltcut0u7 scene')
  })

  it('an empty prompt becomes just the trigger', () => {
    expect(applyLtxTrigger('', 'F3ltCut0u7')).toBe('F3ltCut0u7')
    expect(applyLtxTrigger('   ', 'F3ltCut0u7')).toBe('F3ltCut0u7')
  })

  it('no trigger (curated LoRAs) leaves the prompt untouched', () => {
    expect(applyLtxTrigger('a lighthouse', null)).toBe('a lighthouse')
    expect(applyLtxTrigger('a lighthouse', undefined)).toBe('a lighthouse')
    expect(applyLtxTrigger('a lighthouse', '  ')).toBe('a lighthouse')
  })
})
