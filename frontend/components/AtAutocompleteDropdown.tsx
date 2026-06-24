/** Dropdown UI for inline `@`-mention autocomplete. Anchored by the host (position:absolute). */

import { toImgSrc } from '../lib/path-to-img-src'
import type { AtOption } from '../hooks/useAtCaretAutocomplete'

interface AtAutocompleteDropdownProps {
  options: AtOption[]
  activeIndex: number
  onPick: (option: AtOption) => void
  onHover: (index: number) => void
  className?: string
  /** Caret coords (relative to the textarea); when set the dropdown anchors at the caret. */
  caret?: { top: number; left: number } | null
}

export function AtAutocompleteDropdown({
  options,
  activeIndex,
  onPick,
  onHover,
  className,
  caret,
}: AtAutocompleteDropdownProps) {
  // Caret-mirror placement when coords are available; otherwise the host's edge anchoring.
  const caretStyle = caret
    ? { position: 'absolute' as const, top: caret.top, left: caret.left, minWidth: 200, maxWidth: 280 }
    : undefined
  return (
    <div
      role="listbox"
      className={`z-50 max-h-56 overflow-y-auto rounded-md border shadow-lg ${caret ? '' : className ?? ''}`}
      style={{ background: 'var(--dp-popover)', borderColor: 'var(--dp-border)', ...caretStyle }}
    >
      {options.map((option, i) => (
        <button
          key={option.id}
          role="option"
          aria-selected={i === activeIndex}
          // mousedown (not click) + preventDefault so the textarea keeps focus and onBlur doesn't fire first
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(option)
          }}
          onMouseEnter={() => onHover(i)}
          className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm transition-colors"
          style={{
            background:
              i === activeIndex
                ? 'color-mix(in oklch, var(--dp-primary-amber) 22%, transparent)'
                : 'transparent',
          }}
        >
          {option.thumbnail ? (
            <img src={toImgSrc(option.thumbnail)} alt="" className="h-6 w-6 flex-shrink-0 rounded object-cover" />
          ) : (
            <span
              className="grid h-6 w-6 flex-shrink-0 place-items-center rounded text-[11px] font-semibold"
              style={{ background: 'var(--dp-rail-surface)', color: 'var(--dp-accent-teal)' }}
            >
              {option.kind === 'character' ? '@' : '#'}
            </span>
          )}
          <span className="flex-1 truncate text-zinc-200">{option.label}</span>
          <span className="text-[10px] text-zinc-500">{option.kind}</span>
        </button>
      ))}
    </div>
  )
}
