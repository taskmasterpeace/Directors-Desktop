import { describe, it, expect } from 'vitest'
import { QUICK_MODES, applyQuickModeFields, missingQuickModeFields } from './quick-modes'

describe('quick-mode fields', () => {
  it('Wardrobe and Style are automatic (no fields); Character and Location have fields', () => {
    expect(QUICK_MODES.wardrobe.fields).toBeUndefined()
    expect(QUICK_MODES.style.fields).toBeUndefined()
    expect(QUICK_MODES.character.fields?.map((f) => f.key)).toEqual(['name', 'description'])
    expect(QUICK_MODES.location.fields?.map((f) => f.key)).toEqual(['name', 'notes'])
  })

  it('substitutes field values into the recipe (all marker occurrences)', () => {
    const c = QUICK_MODES.character
    const out = applyQuickModeFields(c.prompt, c.fields, { name: 'Maya', description: 'twenties, short dark hair, denim jacket' })
    expect(out).not.toContain('@[CHARACTER NAME]')       // both occurrences replaced
    expect(out).not.toContain('[DESCRIBE THE CHARACTER]')
    expect(out).toContain('CHARACTER @Maya')
    expect(out).toContain('twenties, short dark hair, denim jacket')
  })

  it('an empty OPTIONAL field becomes "none" so the sentence still reads', () => {
    const l = QUICK_MODES.location
    const out = applyQuickModeFields(l.prompt, l.fields, { name: "Maya's kitchen", notes: '' })
    expect(out).toContain("@Maya's kitchen")
    expect(out).not.toContain('[LOCATION NAME]')
    expect(out).toContain('Additional notes: none')
    expect(out).not.toContain('[OPTIONAL NOTES]')
  })

  it('required fields left blank are reported and block generation', () => {
    const c = QUICK_MODES.character
    expect(missingQuickModeFields(c.fields, {}).map((f) => f.key)).toEqual(['name', 'description'])
    expect(missingQuickModeFields(c.fields, { name: 'Maya', description: 'x' })).toHaveLength(0)
    // whitespace-only does not count as filled
    expect(missingQuickModeFields(c.fields, { name: '  ', description: 'x' }).map((f) => f.key)).toEqual(['name'])
    // optional (notes) never blocks
    expect(missingQuickModeFields(QUICK_MODES.location.fields, { name: 'Kitchen' })).toHaveLength(0)
  })
})
