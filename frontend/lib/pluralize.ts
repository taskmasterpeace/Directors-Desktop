/**
 * Count + noun with the noun pluralised only when it should be.
 *
 * The Director status strip read "lyrics: 1 words" — small, but it reads as a
 * bug and undermines confidence in everything next to it. Regular-plural nouns
 * (word→words, shot→shots) just take an "s"; pass `plural` for the irregulars.
 */
export function pluralize(count: number, singular: string, plural?: string): string {
  const noun = count === 1 ? singular : (plural ?? `${singular}s`)
  return `${count} ${noun}`
}
