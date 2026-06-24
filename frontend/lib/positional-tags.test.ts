import { describe, it, expect } from 'vitest'
import {
  addRef,
  removeRef,
  rewritePrompt,
  syncFromPrompt,
  pathsForKind,
  tokenFor,
  CAPS,
  type RefItem,
} from './positional-tags'

const img = (id: string): RefItem => ({ id, kind: 'image', path: `/p/${id}.png`, label: id })

describe('tokenFor', () => {
  it('is 1-based per kind', () => {
    expect(tokenFor('image', 0)).toBe('@Image1')
    expect(tokenFor('audio', 2)).toBe('@Audio3')
  })
})

describe('rewritePrompt', () => {
  it('renumbers remaining tokens when a middle item is removed', () => {
    const before = [img('1'), img('2'), img('3')]
    const after = [img('1'), img('3')]
    // @Image1 stays, @Image2 (removed) is stripped, @Image3 -> @Image2
    expect(rewritePrompt('a @Image1 b @Image2 c @Image3', before, after)).toBe('a @Image1 b c @Image2')
  })

  it('strips tokens whose item no longer exists (typed-ahead / removed)', () => {
    expect(rewritePrompt('hello @Image5 world', [], [])).toBe('hello world')
  })
})

describe('addRef', () => {
  it('assigns the next positional token', () => {
    const r = addRef([img('1')], img('2'))
    expect('token' in r && r.token).toBe('@Image2')
  })
  it('rejects past the cap instead of dropping', () => {
    const full = Array.from({ length: CAPS.image }, (_, i) => img(String(i)))
    const r = addRef(full, img('overflow'))
    expect('error' in r).toBe(true)
  })
})

describe('removeRef + syncFromPrompt', () => {
  it('removeRef drops by id', () => {
    expect(removeRef([img('1'), img('2')], '1').map((i) => i.id)).toEqual(['2'])
  })
  it('syncFromPrompt is subtractive — drops items whose token the user deleted', () => {
    const kept = syncFromPrompt([img('1'), img('2')], 'only @Image1 remains')
    expect(kept.map((i) => i.id)).toEqual(['1'])
  })
})

describe('pathsForKind', () => {
  it('returns ordered paths for the kind', () => {
    const items: RefItem[] = [
      img('1'),
      { id: 'a', kind: 'audio', path: '/a.mp3', label: 'a' },
      img('2'),
    ]
    expect(pathsForKind(items, 'image')).toEqual(['/p/1.png', '/p/2.png'])
    expect(pathsForKind(items, 'audio')).toEqual(['/a.mp3'])
  })
})
