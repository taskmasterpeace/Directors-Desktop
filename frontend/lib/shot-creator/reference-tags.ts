/**
 * @reference-tag parsing — ported 1:1 from Palette Shot Creator
 * (src/features/shot-creator/helpers/parse-reference-tags.ts).
 *
 * Distinguishes prompt-library categories (NOT image refs), reference-library
 * categories (random pick), and specific image references (optionally versioned).
 */

// Prompt-library categories — these are prompt-snippet groups, NOT image refs.
const PROMPT_LIBRARY_CATEGORIES = new Set([
  '@cinematic',
  '@characters',
  '@character',
  '@lighting',
  '@environments',
  '@environment',
  '@location',
  '@effects',
  '@effect',
  '@moods',
  '@mood',
  '@camera',
  '@styles',
  '@style',
  '@1', // reserved: Anchor Transform syntax
])

// Reference-library categories — resolve to a random image from that category.
const REFERENCE_LIBRARY_CATEGORIES = new Set(['@people', '@places', '@props', '@layouts'])

export type ReferenceCategory = 'people' | 'places' | 'props' | 'layouts' | 'styles'

export interface ParsedReferenceTag {
  /** e.g. "@twork:v2" */
  raw: string
  /** e.g. "twork" (lowercase, no @) */
  name: string
  /** undefined → highest version; 'latest' → explicit alias; number → that version */
  version: number | 'latest' | undefined
}

export interface ParsedReferences {
  specificReferences: string[]
  categoryReferences: ReferenceCategory[]
  allReferences: string[]
  specificParsed: ParsedReferenceTag[]
}

/** Parse a single tag like `@twork`, `@twork:v2`, `@twork:latest`. */
export function parseSingleTag(raw: string): ParsedReferenceTag | null {
  if (typeof raw !== 'string') return null
  const m = raw.match(/^@([a-zA-Z0-9_-]+)(?::(v\d+|latest))?$/i)
  if (!m) return null
  const name = m[1].toLowerCase()
  const versionRaw = m[2]?.toLowerCase()
  let version: number | 'latest' | undefined
  if (versionRaw === 'latest') {
    version = 'latest'
  } else if (versionRaw && /^v\d+$/.test(versionRaw)) {
    const n = parseInt(versionRaw.slice(1), 10)
    if (n > 0) version = n
  }
  return { raw, name, version }
}

/** Extract @reference tags, separating specific refs from category refs. */
export function parseReferenceTags(prompt: string): ParsedReferences {
  if (!prompt || typeof prompt !== 'string') {
    return { specificReferences: [], categoryReferences: [], allReferences: [], specificParsed: [] }
  }

  const regex = /@[a-zA-Z0-9_-]+(?::(?:v\d+|latest))?/gi
  const matches = prompt.match(regex) || []

  // Dedupe by lowercase raw so "@Twork" and "@twork" collapse, but "@twork" and
  // "@twork:v2" stay distinct.
  const seen = new Set<string>()
  const uniqueTags = matches
    .map((t) => t.toLowerCase())
    .filter((t) => (seen.has(t) ? false : (seen.add(t), true)))

  const specificReferences: string[] = []
  const categoryReferences: ReferenceCategory[] = []
  const allReferences: string[] = []
  const specificParsed: ParsedReferenceTag[] = []

  uniqueTags.forEach((tag) => {
    const baseTag = tag.split(':')[0]
    if (PROMPT_LIBRARY_CATEGORIES.has(baseTag)) return
    if (REFERENCE_LIBRARY_CATEGORIES.has(baseTag)) {
      categoryReferences.push(baseTag.replace('@', '') as ReferenceCategory)
      allReferences.push(tag)
    } else {
      specificReferences.push(tag)
      allReferences.push(tag)
      const parsed = parseSingleTag(tag)
      if (parsed) specificParsed.push(parsed)
    }
  })

  return { specificReferences, categoryReferences, allReferences, specificParsed }
}

/** True if the prompt has any image-reference tag (prompt-library categories excluded). */
export function hasReferenceTags(prompt: string): boolean {
  return parseReferenceTags(prompt).allReferences.length > 0
}

/** True if the tag is a reference-library category (random selection). */
export function isCategoryReference(tag: string): boolean {
  return REFERENCE_LIBRARY_CATEGORIES.has(tag.toLowerCase())
}

/** Category name from a tag (strips @), or null if not a known category. */
export function getCategoryFromTag(tag: string): ReferenceCategory | null {
  const normalized = tag.toLowerCase().replace('@', '')
  if (['people', 'places', 'props', 'layouts', 'styles'].includes(normalized)) {
    return normalized as ReferenceCategory
  }
  return null
}
