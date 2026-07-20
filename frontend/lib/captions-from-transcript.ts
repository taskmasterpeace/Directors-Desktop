/**
 * Transcript → caption cues (the bridge the transcript system never had).
 *
 * Groups word-level timestamps into readable subtitle cues. Rules (spec
 * 2026-07-20): max ~42 chars per cue, prefer breaking at sentence punctuation,
 * always break at silence gaps ≥ 0.4s, and never emit a zero-length cue.
 * Pure and deterministic — callers hand in words already mapped to the
 * timebase they want (timeline seconds for timeline captions).
 */

export interface CaptionWord {
  text: string
  start: number
  end: number
}

export interface CaptionCue {
  text: string
  start: number
  end: number
}

export interface CaptionOptions {
  maxCharsPerCue: number
  /** A silence this long (seconds) always starts a new cue. */
  silenceBreak: number
  /** Minimum cue duration — very short cues get padded to this. */
  minCueSeconds: number
}

const DEFAULTS: CaptionOptions = {
  maxCharsPerCue: 42,
  silenceBreak: 0.4,
  minCueSeconds: 0.7,
}

const SENTENCE_END = /[.!?…]["')\]]?$/

export function captionsFromWords(
  words: CaptionWord[],
  options: Partial<CaptionOptions> = {},
): CaptionCue[] {
  const opts = { ...DEFAULTS, ...options }
  const cues: CaptionCue[] = []
  let current: CaptionWord[] = []

  const flush = () => {
    if (current.length === 0) return
    const start = current[0].start
    const rawEnd = current[current.length - 1].end
    cues.push({
      text: current.map((w) => w.text.trim()).filter(Boolean).join(' '),
      start,
      end: Math.max(rawEnd, start + opts.minCueSeconds),
    })
    current = []
  }

  for (const word of words) {
    if (!word.text.trim()) continue
    const prev = current[current.length - 1]

    // Hard break: a real silence between words.
    if (prev && word.start - prev.end >= opts.silenceBreak) flush()

    const lengthWith =
      current.map((w) => w.text.trim()).join(' ').length + word.text.trim().length + 1
    if (current.length > 0 && lengthWith > opts.maxCharsPerCue) flush()

    current.push(word)

    // Prefer to end a cue at sentence punctuation once it has some substance.
    const soFar = current.map((w) => w.text.trim()).join(' ')
    if (SENTENCE_END.test(word.text.trim()) && soFar.length >= opts.maxCharsPerCue * 0.5) {
      flush()
    }
  }
  flush()

  // Clamp overlaps introduced by min-duration padding: a cue never runs past
  // the start of the next one.
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start
  }
  return cues
}
