import { describe, it, expect } from 'vitest'
import { parseDynamicPrompt } from './dynamic-prompt'

const WCS = [
  { name: 'mood', entries: ['happy', 'gritty', 'noir'] },
  { name: 'city', entries: ['Tokyo'] },
]

describe('parseDynamicPrompt — Palette 1:1 grammar', () => {
  it('plain prompt passes through', () => {
    const r = parseDynamicPrompt('a hero shot', WCS)
    expect(r.isValid).toBe(true)
    expect(r.totalCount).toBe(1)
    expect(r.chains).toEqual([['a hero shot']])
  })

  it('wildcards substitute first (random, injectable)', () => {
    const r = parseDynamicPrompt('a _mood_ street', WCS, {}, () => 0)
    expect(r.hasWildCards).toBe(true)
    expect(r.expandedPrompts[0]).toBe('a happy street')
  })

  it('locked wildcard _name=value_ picks that entry', () => {
    const r = parseDynamicPrompt('a _mood=noir_ street', WCS)
    expect(r.expandedPrompts[0]).toBe('a noir street')
  })

  it('unknown wildcard invalidates the prompt', () => {
    const r = parseDynamicPrompt('a _nope_ street', WCS)
    expect(r.isValid).toBe(false)
    expect(r.error).toContain('_nope_')
  })

  it('does not treat snake_case words as wildcards', () => {
    const r = parseDynamicPrompt('use file_name_here now', WCS)
    expect(r.isValid).toBe(true)
    expect(r.hasWildCards).toBe(false)
  })

  it('brackets expand to one prompt per option', () => {
    const r = parseDynamicPrompt('a [red, blue, green] car', WCS)
    expect(r.hasBrackets).toBe(true)
    expect(r.totalCount).toBe(3)
    expect(r.expandedPrompts).toEqual(['a red car', 'a blue car', 'a green car'])
  })

  it('pipes become sequential chains (each stage feeds the next)', () => {
    const r = parseDynamicPrompt('wide shot | zoom to face | extreme close-up', WCS)
    expect(r.hasPipes).toBe(true)
    expect(r.totalCount).toBe(1)
    expect(r.chains[0]).toEqual(['wide shot', 'zoom to face', 'extreme close-up'])
  })

  it('brackets x pipes cross-product', () => {
    const r = parseDynamicPrompt('[day, night] street | add rain', WCS)
    expect(r.totalCount).toBe(2)
    expect(r.chains).toEqual([
      ['day street', 'add rain'],
      ['night street', 'add rain'],
    ])
  })

  it('soft limit flags confirmation above 10', () => {
    const opts = Array.from({ length: 12 }, (_, i) => `o${i}`).join(', ')
    const r = parseDynamicPrompt(`a [${opts}] car`, WCS)
    expect(r.totalCount).toBe(12)
    expect(r.needsConfirmation).toBe(true)
  })

  it('hard cap at maxTotalImages with a warning', () => {
    const opts = Array.from({ length: 60 }, (_, i) => `o${i}`).join(', ')
    const r = parseDynamicPrompt(`a [${opts}] car`, WCS, { maxOptions: 60 })
    expect(r.totalCount).toBe(50)
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it('slot machine braces are detected, not expanded', () => {
    const r = parseDynamicPrompt('a {cyberpunk theme} alley', WCS)
    expect(r.hasSlotMachine).toBe(true)
    expect(r.slotMachineCount).toBe(1)
    expect(r.totalCount).toBe(1)
  })

  it('kill-switches disable each syntax', () => {
    const r = parseDynamicPrompt('a [x, y] _mood_ p | q', WCS, {
      disableBracketSyntax: true,
      disablePipeSyntax: true,
      disableWildcardSyntax: true,
    })
    expect(r.totalCount).toBe(1)
    expect(r.hasBrackets).toBe(false)
    expect(r.hasPipes).toBe(false)
    expect(r.hasWildCards).toBe(false)
  })
})
