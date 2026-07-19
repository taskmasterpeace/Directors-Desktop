import { describe, it, expect } from 'vitest'
import {
  alignScriptToTranscript,
  normalizeToken,
  tokenizeScript,
} from './transcript-align'
import type { TranscriptWord } from './transcript-api'

const w = (text: string, start: number, end: number): TranscriptWord => ({ text, start, end })

describe('normalizeToken', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalizeToken('Hello,')).toBe('hello')
    expect(normalizeToken('“Night!”')).toBe('night')
  })
  it('keeps interior apostrophes but trims edge quotes', () => {
    expect(normalizeToken("don't")).toBe("don't")
    expect(normalizeToken("'em")).toBe('em')
  })
  it('keeps digits', () => {
    expect(normalizeToken('42nd')).toBe('42nd')
  })
})

describe('tokenizeScript', () => {
  it('splits on any whitespace and drops empties', () => {
    expect(tokenizeScript('  The  quick\nfox\t jumps ')).toEqual(['The', 'quick', 'fox', 'jumps'])
  })
})

describe('alignScriptToTranscript', () => {
  it('carries exact timings on a perfect match', () => {
    const stt = [w('the', 0, 0.2), w('quick', 0.2, 0.5), w('fox', 0.5, 0.8)]
    const r = alignScriptToTranscript('The quick fox', stt)
    expect(r.words).toEqual([
      { text: 'The', start: 0, end: 0.2 },
      { text: 'quick', start: 0.2, end: 0.5 },
      { text: 'fox', start: 0.5, end: 0.8 },
    ])
    expect(r.coverage).toBe(1)
    expect(r.droppedSttCount).toBe(0)
    expect(r.interpolatedCount).toBe(0)
  })

  it('matches through case and punctuation differences', () => {
    const stt = [w('hello', 0, 0.3), w('world', 0.3, 0.6)]
    const r = alignScriptToTranscript('Hello, world!', stt)
    expect(r.words[0]).toEqual({ text: 'Hello,', start: 0, end: 0.3 })
    expect(r.words[1]).toEqual({ text: 'world!', start: 0.3, end: 0.6 })
    expect(r.coverage).toBe(1)
  })

  it('gives a misheard word the STT timing (substitution)', () => {
    // STT heard "night" as "knife"; script text wins, timing survives.
    const stt = [w('good', 0, 0.3), w('knife', 0.3, 0.7), w('friend', 0.7, 1.1)]
    const r = alignScriptToTranscript('good night friend', stt)
    expect(r.words[1]).toEqual({ text: 'night', start: 0.3, end: 0.7 })
    expect(r.coverage).toBe(1)
    expect(r.droppedSttCount).toBe(0)
  })

  it('interpolates a word the STT missed, between its neighbors', () => {
    const stt = [w('the', 0, 0.2), w('fox', 1.0, 1.3)]
    const r = alignScriptToTranscript('the quick fox', stt)
    const quick = r.words[1]
    expect(quick.text).toBe('quick')
    expect(quick.start).toBeGreaterThanOrEqual(0.2)
    expect(quick.end).toBeLessThanOrEqual(1.0)
    expect(quick.end).toBeGreaterThan(quick.start)
    expect(r.interpolatedCount).toBe(1)
    expect(r.matchedCount).toBe(2)
  })

  it('drops STT hallucinations the script does not contain', () => {
    const stt = [w('the', 0, 0.2), w('um', 0.2, 0.4), w('fox', 0.4, 0.7)]
    const r = alignScriptToTranscript('the fox', stt)
    expect(r.words.map((x) => x.text)).toEqual(['the', 'fox'])
    expect(r.droppedSttCount).toBe(1)
    expect(r.words[1]).toEqual({ text: 'fox', start: 0.4, end: 0.7 })
  })

  it('squeezes leading script words the STT never heard before the first anchor', () => {
    const stt = [w('two', 1.0, 1.3), w('three', 1.3, 1.6)]
    const r = alignScriptToTranscript('one two three', stt)
    const one = r.words[0]
    expect(one.text).toBe('one')
    expect(one.start).toBeGreaterThanOrEqual(0)
    expect(one.end).toBeLessThanOrEqual(1.0)
    expect(r.words[1].start).toBeGreaterThanOrEqual(one.end)
  })

  it('extends trailing script words past the last anchor', () => {
    const stt = [w('one', 0, 0.3)]
    const r = alignScriptToTranscript('one two three', stt)
    expect(r.words[1].start).toBeGreaterThanOrEqual(0.3)
    expect(r.words[2].start).toBeGreaterThanOrEqual(r.words[1].end)
    expect(r.words[2].end).toBeGreaterThan(r.words[2].start)
  })

  it('re-synchronizes across a multi-word divergence', () => {
    // Script: "she walked slowly into the dark house"
    // STT misheard "walked slowly" as "locked" (one word) but recovers at "into".
    const stt = [
      w('she', 0, 0.2),
      w('locked', 0.2, 0.8),
      w('into', 0.8, 1.0),
      w('the', 1.0, 1.1),
      w('dark', 1.1, 1.4),
      w('house', 1.4, 1.8),
    ]
    const r = alignScriptToTranscript('she walked slowly into the dark house', stt)
    expect(r.words.map((x) => x.text)).toEqual([
      'she', 'walked', 'slowly', 'into', 'the', 'dark', 'house',
    ])
    // "walked" pairs with "locked" as a substitution; "slowly" is interpolated.
    expect(r.words[1]).toMatchObject({ text: 'walked', start: 0.2, end: 0.8 })
    expect(r.words[3]).toMatchObject({ text: 'into', start: 0.8, end: 1.0 })
    expect(r.droppedSttCount).toBe(0)
  })

  it('always returns monotonically non-decreasing timings', () => {
    const stt = [
      w('alpha', 0, 0.4),
      w('mystery', 0.4, 0.6),
      w('gamma', 0.5, 0.9), // overlapping source timings — STT can be messy
      w('delta', 0.9, 1.2),
    ]
    const r = alignScriptToTranscript('alpha beta gamma delta epsilon', stt)
    let floor = 0
    for (const word of r.words) {
      expect(word.start).toBeGreaterThanOrEqual(floor)
      expect(word.end).toBeGreaterThanOrEqual(word.start)
      floor = word.end
    }
  })

  it('throws on an empty script', () => {
    expect(() => alignScriptToTranscript('   ', [w('a', 0, 1)])).toThrow(/script is empty/i)
  })

  it('throws when there are no STT words to time against', () => {
    expect(() => alignScriptToTranscript('hello world', [])).toThrow(/transcribe/i)
  })

  it('handles a realistic audiobook-style passage', () => {
    // STT: mishears "Marlowe" as "Marlow", drops "quite", inserts "uh".
    const stt = [
      w('mr', 0, 0.2),
      w('marlow', 0.2, 0.7),
      w('was', 0.7, 0.9),
      w('uh', 0.9, 1.0),
      w('not', 1.0, 1.2),
      w('certain', 1.4, 1.9),
      w('of', 1.9, 2.0),
      w('the', 2.0, 2.1),
      w('hour', 2.1, 2.5),
    ]
    const script = 'Mr. Marlowe was not quite certain of the hour.'
    const r = alignScriptToTranscript(script, stt)
    expect(r.words.map((x) => x.text)).toEqual([
      'Mr.', 'Marlowe', 'was', 'not', 'quite', 'certain', 'of', 'the', 'hour.',
    ])
    // "Marlowe" substituted onto "marlow" timing; "quite" interpolated into the
    // 1.2→1.4 gap; "uh" dropped.
    expect(r.words[1]).toMatchObject({ start: 0.2, end: 0.7 })
    expect(r.words[4].start).toBeGreaterThanOrEqual(1.2)
    expect(r.words[4].end).toBeLessThanOrEqual(1.4)
    expect(r.droppedSttCount).toBe(1)
    expect(r.coverage).toBeGreaterThan(0.7)
  })
})
