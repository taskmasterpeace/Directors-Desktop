/**
 * Dynamic prompt parser — ported 1:1 from Palette's Shot Creator
 * (src/features/shot-creator/helpers/prompt-syntax-feedback.ts +
 * helpers/wildcard/parser.ts). Same grammar, same order, same caps:
 *
 *   1. Wildcards substitute first:  _name_ (random entry) / _name=value_ (locked)
 *   2. Brackets expand:             [a, b, c]  → one prompt per option (ONE group)
 *   3. Pipes chain:                 a | b | c  → sequential stages, each stage's
 *                                     output feeds the next as a reference image
 *   4. Brackets × pipes cross-product, capped at maxTotalImages (50)
 *   5. Slot machine {seed} is DETECTED (AI expansion happens elsewhere)
 *
 * needsConfirmation fires above the soft limit (10) so nobody queues 50 images
 * off a stray comma.
 */

export interface WildCardLike {
  name: string
  /** One entry per line in the library; parser picks or locks one. */
  entries: string[]
}

export interface DynamicPromptConfig {
  maxOptions: number
  maxPreview: number
  maxTotalImages: number
  disablePipeSyntax: boolean
  disableBracketSyntax: boolean
  disableWildcardSyntax: boolean
  disableSlotMachineSyntax: boolean
}

const DEFAULT_CONFIG: DynamicPromptConfig = {
  maxOptions: 50,
  maxPreview: 5,
  maxTotalImages: 50,
  disablePipeSyntax: false,
  disableBracketSyntax: false,
  disableWildcardSyntax: false,
  disableSlotMachineSyntax: false,
}

export interface DynamicPromptResult {
  isValid: boolean
  error?: string
  /** Flat list when there are no pipes; with pipes, the FIRST stage of each chain. */
  expandedPrompts: string[]
  /** Pipe chains: each entry is the full stage list for one generation chain. */
  chains: string[][]
  totalCount: number
  hasBrackets: boolean
  hasPipes: boolean
  hasWildCards: boolean
  hasSlotMachine: boolean
  slotMachineCount: number
  needsConfirmation: boolean
  warnings: string[]
}

// Palette's wildcard token: _name_ or _name=value_, not glued to alphanumerics.
const WILDCARD_RE = /(?<![a-zA-Z0-9])_([a-zA-Z0-9_]+?)(?:=([^_]+))?_(?![a-zA-Z0-9])/g
const BRACKET_RE = /\[([^\[\]]+)\]/
const SLOT_RE = /\{([^{}]+)\}/g
const SOFT_LIMIT = 10

function substituteWildcards(
  prompt: string,
  wildcards: WildCardLike[],
  rand: () => number,
): { text: string; used: boolean; error?: string } {
  let used = false
  let error: string | undefined
  const byName = new Map(wildcards.map((w) => [w.name.toLowerCase(), w]))
  const text = prompt.replace(WILDCARD_RE, (match, name: string, locked: string | undefined) => {
    const wc = byName.get(name.toLowerCase())
    if (!wc || wc.entries.length === 0) {
      error = `Unknown wildcard: _${name}_`
      return match
    }
    used = true
    if (locked !== undefined) {
      // _name=value_ locks a specific entry (case-insensitive match, else literal value).
      const hit = wc.entries.find((e) => e.trim().toLowerCase() === locked.trim().toLowerCase())
      return hit ?? locked
    }
    return wc.entries[Math.floor(rand() * wc.entries.length)]
  })
  return { text, used, error }
}

function expandBrackets(prompt: string, maxOptions: number): { variants: string[]; used: boolean } {
  const m = BRACKET_RE.exec(prompt)
  if (!m) return { variants: [prompt], used: false }
  const options = m[1]
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .slice(0, maxOptions)
  if (options.length <= 1) {
    // A single option (or empty) is just literal text with the brackets removed.
    return { variants: [prompt.replace(m[0], options[0] ?? '')], used: false }
  }
  return { variants: options.map((o) => prompt.replace(m[0], o)), used: true }
}

/**
 * Parse + expand a prompt through the full Palette grammar.
 * Pure and deterministic when `rand` is injected (tests pass () => 0).
 */
export function parseDynamicPrompt(
  prompt: string,
  wildcards: WildCardLike[] = [],
  config: Partial<DynamicPromptConfig> = {},
  rand: () => number = Math.random,
): DynamicPromptResult {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const warnings: string[] = []

  // STEP 1 — wildcards
  let working = prompt
  let hasWildCards = false
  if (!cfg.disableWildcardSyntax) {
    const sub = substituteWildcards(prompt, wildcards, rand)
    if (sub.error) {
      return {
        isValid: false,
        error: sub.error,
        expandedPrompts: [],
        chains: [],
        totalCount: 0,
        hasBrackets: false,
        hasPipes: false,
        hasWildCards: false,
        hasSlotMachine: false,
        slotMachineCount: 0,
        needsConfirmation: false,
        warnings,
      }
    }
    working = sub.text
    hasWildCards = sub.used
  }

  // Slot machine — detect only; expansion is an AI step outside the parser.
  const slotMatches = cfg.disableSlotMachineSyntax ? [] : [...working.matchAll(SLOT_RE)]
  const hasSlotMachine = slotMatches.length > 0

  // STEP 2 — pipes split the prompt into sequential stages.
  const stages = cfg.disablePipeSyntax
    ? [working]
    : working.split('|').map((s) => s.trim()).filter(Boolean)
  const hasPipes = stages.length > 1

  // STEP 3 — brackets expand per stage; chains are the cross-product of stage variants.
  let chains: string[][] = [[]]
  let hasBrackets = false
  for (const stage of stages) {
    const { variants, used } = cfg.disableBracketSyntax
      ? { variants: [stage], used: false }
      : expandBrackets(stage, cfg.maxOptions)
    hasBrackets = hasBrackets || used
    const next: string[][] = []
    for (const chain of chains) {
      for (const v of variants) {
        next.push([...chain, v])
        if (next.length > cfg.maxTotalImages) break
      }
      if (next.length > cfg.maxTotalImages) break
    }
    chains = next
  }
  if (chains.length > cfg.maxTotalImages) {
    chains = chains.slice(0, cfg.maxTotalImages)
    warnings.push(`Capped at ${cfg.maxTotalImages} generations.`)
  }

  const totalCount = chains.length
  return {
    isValid: true,
    expandedPrompts: chains.map((c) => c[0] ?? ''),
    chains,
    totalCount,
    hasBrackets,
    hasPipes,
    hasWildCards,
    hasSlotMachine,
    slotMachineCount: slotMatches.length,
    needsConfirmation: totalCount > SOFT_LIMIT,
    warnings,
  }
}
