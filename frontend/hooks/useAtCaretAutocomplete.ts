/**
 * Inline `@`-mention autocomplete for a textarea (Phase 1b).
 *
 * Headless + element-driven: it reads the live `<textarea>` value/caret rather than a React
 * prop, so it never works off a stale value during fast typing. The host renders the dropdown
 * from the returned state and forwards keydown through `onKeyDown` (which returns true when it
 * consumed the event, so the host can early-return before its own Enter-to-submit).
 */

import { useCallback, useMemo, useState, type KeyboardEvent, type RefObject } from 'react'
import { getCaretCoordinates } from '../lib/caret-coordinates'

export interface AtOption {
  id: string
  /** Display name; inserted as `@Name` with whitespace stripped. */
  label: string
  kind: 'character' | 'reference'
  thumbnail?: string
}

const TOKEN_RE = /@([A-Za-z0-9_-]*)$/

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function useAtCaretAutocomplete(opts: {
  textareaRef: RefObject<HTMLTextAreaElement>
  onChange: (next: string) => void
  options: AtOption[]
}) {
  const { textareaRef, onChange, options } = opts
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [tokenStart, setTokenStart] = useState(0)
  const [caret, setCaret] = useState<{ top: number; left: number } | null>(null)

  const filtered = useMemo(() => {
    const q = normalize(query)
    return options
      .filter((o) => normalize(o.label).includes(q))
      .slice(0, 8)
  }, [options, query])

  /** Recompute open/query from the live element; call on input + selection change. */
  const sync = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    const caretPos = el.selectionStart ?? 0
    const match = TOKEN_RE.exec(el.value.slice(0, caretPos))
    if (match) {
      setTokenStart(caretPos - match[0].length)
      setQuery(match[1])
      setActiveIndex(0)
      setOpen(true)
      try {
        const coords = getCaretCoordinates(el, caretPos - match[0].length)
        setCaret({ top: coords.top + coords.height, left: coords.left })
      } catch {
        setCaret(null) // fall back to the host's edge-anchored placement
      }
    } else {
      setOpen(false)
    }
  }, [textareaRef])

  const accept = useCallback(
    (option: AtOption) => {
      const el = textareaRef.current
      if (!el) return
      const caret = el.selectionStart ?? el.value.length
      const slug = option.label.replace(/\s+/g, '')
      const next = `${el.value.slice(0, tokenStart)}@${slug} ${el.value.slice(caret)}`
      onChange(next)
      setOpen(false)
      const pos = tokenStart + slug.length + 2 // past "@slug "
      requestAnimationFrame(() => {
        el.focus()
        el.setSelectionRange(pos, pos)
      })
    },
    [textareaRef, tokenStart, onChange],
  )

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open || filtered.length === 0) return false
      switch (e.key) {
        case 'ArrowDown':
          setActiveIndex((i) => (i + 1) % filtered.length)
          return true
        case 'ArrowUp':
          setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length)
          return true
        case 'Enter':
        case 'Tab': {
          const option = filtered[activeIndex]
          if (option) accept(option)
          return true
        }
        case 'Escape':
          setOpen(false)
          return true
        default:
          return false
      }
    },
    [open, filtered, activeIndex, accept],
  )

  return {
    isOpen: open && filtered.length > 0,
    options: filtered,
    activeIndex,
    setActiveIndex,
    query,
    /** Caret pixel coords (relative to the textarea) for positioning the dropdown. */
    caret,
    sync,
    accept,
    onKeyDown,
    close: useCallback(() => setOpen(false), []),
  }
}
