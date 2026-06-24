/**
 * Positional reference tags (@Image1..9 / @Audio1..3).
 *
 * Pure, DOM-free helpers for the reference system. The reference rail (an ordered
 * list per kind) is the single source of truth; the `@ImageN`/`@AudioN` tokens in the
 * prompt are a projection of it. Keeping these functions pure makes the prompt↔rail↔array
 * sync deterministic and testable.
 */

export type RefKind = 'image' | 'audio'

export interface RefItem {
  /** Stable id across renumbering (so removing @Image2 shifts @Image3→@Image2 correctly). */
  id: string
  kind: RefKind
  /** OS path or file:// URL — the source of truth for upload/submit. */
  path: string
  /** Display label (character / reference / file name). */
  label: string
}

export const CAPS: Record<RefKind, number> = { image: 9, audio: 3 }
const PREFIX: Record<RefKind, string> = { image: 'Image', audio: 'Audio' }
const TOKEN_RE = /@(Image|Audio)(\d+)\b/g

/** The positional token for the item at 0-based index `i` in its kind's ordered list. */
export function tokenFor(kind: RefKind, i: number): string {
  return `@${PREFIX[kind]}${i + 1}`
}

function splitByKind(items: RefItem[]): Record<RefKind, RefItem[]> {
  return {
    image: items.filter((it) => it.kind === 'image'),
    audio: items.filter((it) => it.kind === 'audio'),
  }
}

/**
 * Rewrite the positional tokens in `prompt` to match the rail mutation from `before`→`after`.
 * Tokens are remapped by stable item id (so removals shift the rest); tokens whose id no
 * longer exists in the rail are stripped (handles removed items and typed-ahead `@Image7`).
 */
export function rewritePrompt(prompt: string, before: RefItem[], after: RefItem[]): string {
  const idByOldToken = new Map<string, string>()
  const b = splitByKind(before)
  ;(['image', 'audio'] as RefKind[]).forEach((kind) =>
    b[kind].forEach((it, i) => idByOldToken.set(tokenFor(kind, i), it.id)),
  )

  const newTokenById = new Map<string, string>()
  const a = splitByKind(after)
  ;(['image', 'audio'] as RefKind[]).forEach((kind) =>
    a[kind].forEach((it, i) => newTokenById.set(it.id, tokenFor(kind, i))),
  )

  return prompt
    .replace(TOKEN_RE, (match) => {
      const id = idByOldToken.get(match)
      if (id && newTokenById.has(id)) return newTokenById.get(id) as string
      return ''
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .trim()
}

/** Add an item to the rail. Returns the assigned token, or an error when the kind is at cap. */
export function addRef(
  items: RefItem[],
  item: RefItem,
): { items: RefItem[]; token: string } | { error: string } {
  const sameKind = items.filter((it) => it.kind === item.kind)
  if (sameKind.length >= CAPS[item.kind]) {
    return { error: `Maximum ${CAPS[item.kind]} ${item.kind} references reached.` }
  }
  const next = [...items, item]
  return { items: next, token: tokenFor(item.kind, sameKind.length) }
}

/** Remove an item by id, returning the new rail. */
export function removeRef(items: RefItem[], id: string): RefItem[] {
  return items.filter((it) => it.id !== id)
}

/** Subtractive sync: drop rail items whose token the user deleted from the prompt text. */
export function syncFromPrompt(items: RefItem[], prompt: string): RefItem[] {
  const present = new Set<string>()
  for (const m of prompt.matchAll(TOKEN_RE)) present.add(m[0])
  const byKind = splitByKind(items)
  const keep = new Set<string>()
  ;(['image', 'audio'] as RefKind[]).forEach((kind) =>
    byKind[kind].forEach((it, i) => {
      if (present.has(tokenFor(kind, i))) keep.add(it.id)
    }),
  )
  return items.filter((it) => keep.has(it.id))
}

/** Ordered paths for a kind — fed into GenerationSettings.referenceImagePaths/audioReferencePaths. */
export function pathsForKind(items: RefItem[], kind: RefKind): string[] {
  return items.filter((it) => it.kind === kind).map((it) => it.path)
}
