import { describe, it, expect } from 'vitest'
import {
  parseSingleTag,
  parseReferenceTags,
  hasReferenceTags,
  isCategoryReference,
  getCategoryFromTag,
} from './reference-tags'

describe('parseSingleTag', () => {
  it('parses a plain tag', () => {
    expect(parseSingleTag('@hero')).toEqual({ raw: '@hero', name: 'hero', version: undefined })
  })
  it('parses a numeric version', () => {
    expect(parseSingleTag('@hero:v2')).toEqual({ raw: '@hero:v2', name: 'hero', version: 2 })
  })
  it('parses the latest alias', () => {
    expect(parseSingleTag('@hero:latest')).toEqual({ raw: '@hero:latest', name: 'hero', version: 'latest' })
  })
  it('lowercases the name', () => {
    expect(parseSingleTag('@Hero')?.name).toBe('hero')
  })
  it('rejects non-tags', () => {
    expect(parseSingleTag('hero')).toBeNull()
    expect(parseSingleTag('@hero!')).toBeNull()
  })
})

describe('parseReferenceTags', () => {
  it('separates specific refs, category refs, and filters prompt-library categories', () => {
    const r = parseReferenceTags('Show @hero fighting @people in @cinematic lighting')
    expect(r.specificReferences).toEqual(['@hero'])
    expect(r.categoryReferences).toEqual(['people'])
    expect(r.allReferences).toEqual(['@hero', '@people'])
    // @cinematic is a prompt-library category → excluded from image refs entirely
    expect(r.allReferences).not.toContain('@cinematic')
  })

  it('dedupes by lowercase raw but keeps versions distinct', () => {
    const r = parseReferenceTags('@Twork and @twork and @twork:v2')
    expect(r.specificReferences).toEqual(['@twork', '@twork:v2'])
    expect(r.specificParsed).toEqual([
      { raw: '@twork', name: 'twork', version: undefined },
      { raw: '@twork:v2', name: 'twork', version: 2 },
    ])
  })

  it('treats @1 (Anchor Transform) as reserved, not a reference', () => {
    const r = parseReferenceTags('@1 style anchor @hero')
    expect(r.specificReferences).toEqual(['@hero'])
    expect(r.allReferences).not.toContain('@1')
  })

  it('collects all four reference-library categories', () => {
    const r = parseReferenceTags('@people @places @props @layouts')
    expect(r.categoryReferences).toEqual(['people', 'places', 'props', 'layouts'])
  })

  it('returns empty for non-strings and empty prompts', () => {
    expect(parseReferenceTags('')).toEqual({
      specificReferences: [], categoryReferences: [], allReferences: [], specificParsed: [],
    })
    // @ts-expect-error exercising the runtime guard
    expect(parseReferenceTags(null).allReferences).toEqual([])
  })
})

describe('hasReferenceTags', () => {
  it('is true only for real image refs', () => {
    expect(hasReferenceTags('a @hero here')).toBe(true)
    expect(hasReferenceTags('a @people here')).toBe(true)
    expect(hasReferenceTags('a @cinematic here')).toBe(false)
    expect(hasReferenceTags('no tags')).toBe(false)
  })
})

describe('isCategoryReference / getCategoryFromTag', () => {
  it('recognizes reference-library categories', () => {
    expect(isCategoryReference('@people')).toBe(true)
    expect(isCategoryReference('@PLACES')).toBe(true)
    expect(isCategoryReference('@hero')).toBe(false)
  })
  it('extracts category names', () => {
    expect(getCategoryFromTag('@props')).toBe('props')
    expect(getCategoryFromTag('@styles')).toBe('styles')
    expect(getCategoryFromTag('@hero')).toBeNull()
  })
})
