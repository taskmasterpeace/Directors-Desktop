import { describe, it, expect } from 'vitest'
import { captionsFromWords , wordPopCues, WORD_POP_MIN_SECONDS } from './captions-from-transcript'

const w = (text: string, start: number, end: number) => ({ text, start, end })

describe('captionsFromWords', () => {
  it('returns empty for no words', () => {
    expect(captionsFromWords([])).toEqual([])
  })

  it('groups a short sentence into one cue', () => {
    const cues = captionsFromWords([w('Hello', 0, 0.3), w('there.', 0.35, 0.7)])
    expect(cues).toHaveLength(1)
    expect(cues[0].text).toBe('Hello there.')
    expect(cues[0].start).toBe(0)
  })

  it('breaks at the character budget', () => {
    const words = Array.from({ length: 30 }, (_, i) => w('word' + i, i * 0.2, i * 0.2 + 0.15))
    const cues = captionsFromWords(words, { maxCharsPerCue: 30 })
    expect(cues.length).toBeGreaterThan(1)
    for (const c of cues) expect(c.text.length).toBeLessThanOrEqual(31)
  })

  it('breaks at silence gaps', () => {
    const cues = captionsFromWords([
      w('Before', 0, 0.3),
      w('gap.', 0.35, 0.6),
      w('After', 2.0, 2.3), // 1.4s silence
      w('gap.', 2.35, 2.6),
    ])
    expect(cues).toHaveLength(2)
    expect(cues[0].text).toBe('Before gap.')
    expect(cues[1].start).toBe(2.0)
  })

  it('prefers sentence-punctuation breaks once a cue has substance', () => {
    const cues = captionsFromWords(
      [
        w('This', 0, 0.2), w('is', 0.25, 0.35), w('a', 0.4, 0.45),
        w('full', 0.5, 0.7), w('sentence.', 0.75, 1.1),
        w('Next', 1.15, 1.4), w('thought', 1.45, 1.8),
      ],
      { maxCharsPerCue: 42 },
    )
    expect(cues[0].text).toBe('This is a full sentence.')
    expect(cues[1].text).toBe('Next thought')
  })

  it('pads tiny cues to the minimum duration without overlapping the next cue', () => {
    const cues = captionsFromWords([
      w('Hi.', 0, 0.1),
      w('Second', 0.9, 1.2), w('cue', 1.25, 1.5), w('here.', 1.55, 2.0),
    ])
    expect(cues[0].end).toBeGreaterThanOrEqual(0.7)
    expect(cues[0].end).toBeLessThanOrEqual(cues[1].start)
  })

  it('is monotonic: cues never overlap', () => {
    const words = Array.from({ length: 60 }, (_, i) => w(`w${i}${i % 7 === 6 ? '.' : ''}`, i * 0.3, i * 0.3 + 0.25))
    const cues = captionsFromWords(words)
    for (let i = 0; i < cues.length - 1; i++) {
      expect(cues[i].end).toBeLessThanOrEqual(cues[i + 1].start)
    }
  })
})

describe('wordPopCues (F7 — karaoke cue overlap)', () => {
  it('holds a short word for the minimum when there is room', () => {
    const cues = wordPopCues([{ text: 'yo', start: 0, end: 0.02 }])
    expect(cues[0].end).toBeCloseTo(WORD_POP_MIN_SECONDS, 6)
  })

  it('never runs a cue past the next word — the double-time rap case', () => {
    // ~10 words/sec: gaps (0.1s) are shorter than the 0.12s floor, so the old
    // code put two cues on screen at once for 23 of 24 words.
    const words = Array.from({ length: 24 }, (_, i) => ({
      text: `w${i}`, start: i * 0.1, end: i * 0.1 + 0.05,
    }))
    const cues = wordPopCues(words)
    for (let i = 0; i < cues.length - 1; i++) {
      expect(cues[i].end).toBeLessThanOrEqual(cues[i + 1].start + 1e-9)
    }
  })

  it('lets the last word use the full minimum — nothing follows it', () => {
    const cues = wordPopCues([
      { text: 'a', start: 0, end: 0.05 },
      { text: 'b', start: 0.1, end: 0.15 },
    ])
    expect(cues[1].end).toBeCloseTo(0.1 + WORD_POP_MIN_SECONDS, 6)
  })

  it('never emits a negative-length cue even when words overlap', () => {
    const cues = wordPopCues([
      { text: 'a', start: 0.5, end: 0.9 },
      { text: 'b', start: 0.4, end: 0.8 }, // out of order / overlapping
    ])
    for (const c of cues) expect(c.end).toBeGreaterThanOrEqual(c.start)
  })

  it('drops whitespace-only tokens and trims the rest', () => {
    const cues = wordPopCues([
      { text: '  ', start: 0, end: 0.1 },
      { text: ' hey ', start: 0.2, end: 0.3 },
    ])
    expect(cues).toHaveLength(1)
    expect(cues[0].text).toBe('hey')
  })
})
