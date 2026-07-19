/**
 * Script-of-truth alignment.
 *
 * Speech-to-text gets words wrong; audio dramas and audiobooks have a real
 * script. This aligns the user's ground-truth script TEXT to the STT's word
 * TIMINGS: the script provides what is said, the STT provides when.
 *
 * Approach: two-pointer walk over normalized tokens with a bounded resync
 * window. Exact matches anchor timing; near-misses become substitutions
 * (script word carries the STT word's timing); script words the STT missed get
 * timings interpolated between surrounding anchors; STT words the script
 * doesn't contain (hallucinations) are dropped. Output timings are forced
 * monotonic so downstream seek/ripple math stays sane.
 *
 * Pure and DOM-free — unit-tested in the node vitest environment.
 */
import type { TranscriptWord } from './transcript-api'

export interface AlignmentResult {
  /** Script words (original text) with source-media timings. */
  words: TranscriptWord[]
  /** Script words that took timing directly from an STT word (match or substitution). */
  matchedCount: number
  /** Script words whose timing was synthesized (STT missed them). */
  interpolatedCount: number
  /** STT words discarded as unmatched (mishears the script doesn't contain). */
  droppedSttCount: number
  /** matchedCount / script word count, 0..1 — a rough confidence signal. */
  coverage: number
}

/** How far ahead (in words, on both sequences) we search to re-synchronize. */
const RESYNC_WINDOW = 8
/** Synthesized width for words hanging off the ends of the timed region. */
const EDGE_WORD_SECONDS = 0.3

/** Lowercase and strip everything but letters/digits — "Hello," ≡ "hello". */
export function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '').replace(/^'+|'+$/g, '')
}

/** Split a pasted script into displayable word tokens (whitespace-delimited). */
export function tokenizeScript(script: string): string[] {
  return script.split(/\s+/).filter((t) => t.length > 0)
}

interface PendingWord {
  text: string
  /** null until timing is assigned (interpolated in the second pass). */
  start: number | null
  end: number | null
}

export function alignScriptToTranscript(
  script: string,
  stt: TranscriptWord[],
): AlignmentResult {
  const scriptTokens = tokenizeScript(script)
  if (scriptTokens.length === 0) {
    throw new Error('The script is empty.')
  }
  if (stt.length === 0) {
    throw new Error('Transcribe the audio first — the script needs STT timings to align to.')
  }

  const scriptNorms = scriptTokens.map(normalizeToken)
  const sttNorms = stt.map((w) => normalizeToken(w.text))

  const out: PendingWord[] = []
  let matchedCount = 0
  let droppedSttCount = 0

  let i = 0 // script cursor
  let j = 0 // stt cursor

  const pairAt = (si: number, ti: number) => {
    out.push({ text: scriptTokens[si], start: stt[ti].start, end: stt[ti].end })
    matchedCount++
  }
  const pushUntimed = (si: number) => {
    out.push({ text: scriptTokens[si], start: null, end: null })
  }

  while (i < scriptTokens.length && j < stt.length) {
    if (scriptNorms[i] !== '' && scriptNorms[i] === sttNorms[j]) {
      pairAt(i, j)
      i++
      j++
      continue
    }

    // Look ahead on both sequences for the nearest point where they agree again.
    let bestK = -1
    let bestL = -1
    let bestCost = Number.POSITIVE_INFINITY
    const maxK = Math.min(RESYNC_WINDOW, scriptTokens.length - i - 1)
    const maxL = Math.min(RESYNC_WINDOW, stt.length - j - 1)
    for (let k = 0; k <= maxK; k++) {
      for (let l = 0; l <= maxL; l++) {
        if (k === 0 && l === 0) continue
        if (scriptNorms[i + k] !== '' && scriptNorms[i + k] === sttNorms[j + l]) {
          const cost = k + l + Math.max(k, l) * 0.1
          if (cost < bestCost) {
            bestCost = cost
            bestK = k
            bestL = l
          }
        }
      }
    }

    if (bestK < 0) {
      // No resync point in the window — treat as a straight substitution
      // (misheard word: script text, STT timing).
      pairAt(i, j)
      i++
      j++
      continue
    }

    // Consume the disagreeing region before the resync point: pair up as many
    // substitutions as both sides allow, interpolate leftover script words,
    // drop leftover STT words.
    const subs = Math.min(bestK, bestL)
    for (let m = 0; m < subs; m++) pairAt(i + m, j + m)
    for (let m = subs; m < bestK; m++) pushUntimed(i + m)
    droppedSttCount += bestL - subs
    i += bestK
    j += bestL
    pairAt(i, j)
    i++
    j++
  }

  // Tails: leftover script words are untimed; leftover STT words are dropped.
  for (; i < scriptTokens.length; i++) pushUntimed(i)
  droppedSttCount += stt.length - j

  interpolateUntimed(out)

  const words = enforceMonotonic(
    out.map((w) => ({ text: w.text, start: w.start ?? 0, end: w.end ?? 0 })),
  )

  const interpolatedCount = scriptTokens.length - matchedCount
  return {
    words,
    matchedCount,
    interpolatedCount,
    droppedSttCount,
    coverage: matchedCount / scriptTokens.length,
  }
}

/** Fill null timings by spreading runs across the gap between their anchors. */
function interpolateUntimed(words: PendingWord[]): void {
  let idx = 0
  while (idx < words.length) {
    if (words[idx].start !== null) {
      idx++
      continue
    }
    // Find the untimed run [runStart, runEnd].
    const runStart = idx
    let runEnd = idx
    while (runEnd + 1 < words.length && words[runEnd + 1].start === null) runEnd++
    const count = runEnd - runStart + 1

    const prev = runStart > 0 ? words[runStart - 1] : null
    const next = runEnd + 1 < words.length ? words[runEnd + 1] : null

    let gapStart: number
    let gapEnd: number
    if (prev && next) {
      gapStart = prev.end as number
      gapEnd = Math.max(gapStart, next.start as number)
    } else if (prev) {
      // Trailing run — synthesize width after the last anchor.
      gapStart = prev.end as number
      gapEnd = gapStart + count * EDGE_WORD_SECONDS
    } else if (next) {
      // Leading run — squeeze in before the first anchor, never below 0.
      gapEnd = next.start as number
      gapStart = Math.max(0, gapEnd - count * EDGE_WORD_SECONDS)
    } else {
      // No anchors at all (cannot happen: alignment always pairs something,
      // but keep the math total).
      gapStart = 0
      gapEnd = count * EDGE_WORD_SECONDS
    }

    const span = gapEnd - gapStart
    // Weight by word length so long words get proportionally more of the gap.
    const weights = []
    let totalWeight = 0
    for (let m = runStart; m <= runEnd; m++) {
      const w = Math.max(1, normalizeToken(words[m].text).length)
      weights.push(w)
      totalWeight += w
    }
    let cursor = gapStart
    for (let m = runStart; m <= runEnd; m++) {
      const width = span * (weights[m - runStart] / totalWeight)
      words[m].start = cursor
      words[m].end = cursor + width
      cursor += width
    }
    idx = runEnd + 1
  }
}

/** Clamp timings so starts/ends never move backward (seek math relies on it). */
function enforceMonotonic(words: TranscriptWord[]): TranscriptWord[] {
  let floor = 0
  return words.map((w) => {
    const start = Math.max(floor, w.start)
    const end = Math.max(start, w.end)
    floor = end
    return { text: w.text, start, end }
  })
}
