import { describe, it, expect } from 'vitest'
import { pluralize } from './pluralize'

describe('pluralize', () => {
  it('keeps the singular for exactly one', () => {
    expect(pluralize(1, 'word')).toBe('1 word')
    expect(pluralize(1, 'shot')).toBe('1 shot')
  })

  it('pluralises everything else, including zero', () => {
    expect(pluralize(0, 'word')).toBe('0 words')
    expect(pluralize(2, 'word')).toBe('2 words')
    expect(pluralize(45, 'shot')).toBe('45 shots')
  })

  it('takes an explicit plural for irregular nouns', () => {
    expect(pluralize(1, 'person', 'people')).toBe('1 person')
    expect(pluralize(3, 'person', 'people')).toBe('3 people')
  })
})
