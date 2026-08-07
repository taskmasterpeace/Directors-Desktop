import { useEffect, useMemo, useRef, useState } from 'react'
import * as LucideIcons from 'lucide-react'
import { X, Search, HelpCircle, Bot, ChevronRight } from 'lucide-react'
import {
  HELP_SECTIONS,
  helpSectionsByArea,
  searchHelp,
  type HelpSection,
} from '../help/help-content'

/**
 * The Help Center — a table-of-contents on the left, one small "fits a 16:9
 * screen" article on the right. Clicking a TOC row jumps to that section; the
 * search filters the TOC live. Every article can hand its context to Director's
 * Pal ("Ask about this") so docs and the assistant stay one experience.
 *
 * Content is 100% data-driven from help-content.ts — this component never
 * hardcodes copy, so coverage is a data concern, not a UI one.
 */

type IconMap = Record<string, React.ComponentType<{ className?: string }>>
const ICONS = LucideIcons as unknown as IconMap

function Icon({ name, className }: { name: string; className?: string }) {
  const Cmp = ICONS[name] ?? HelpCircle
  return <Cmp className={className} />
}

export function HelpCenter({
  isOpen,
  onClose,
  initialSectionId,
}: {
  isOpen: boolean
  onClose: () => void
  initialSectionId?: string
}) {
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string>(initialSectionId || HELP_SECTIONS[0]?.id || '')
  const articleRef = useRef<HTMLDivElement>(null)

  // Deep-link support: open to a requested section.
  useEffect(() => {
    if (isOpen && initialSectionId) setActiveId(initialSectionId)
  }, [isOpen, initialSectionId])

  // Close on Escape.
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  const matches = useMemo(() => searchHelp(query), [query])
  const matchIds = useMemo(() => new Set(matches.map((s) => s.id)), [matches])
  const groups = useMemo(() => helpSectionsByArea(), [])

  // When a search filters out the active section, jump to the first match.
  useEffect(() => {
    if (query && !matchIds.has(activeId) && matches[0]) setActiveId(matches[0].id)
  }, [query, matchIds, activeId, matches])

  // Reset scroll when switching articles (each is meant to fit anyway).
  useEffect(() => { articleRef.current?.scrollTo({ top: 0 }) }, [activeId])

  const active: HelpSection | undefined = HELP_SECTIONS.find((s) => s.id === activeId)

  const askDirectorsPal = (section: HelpSection) => {
    window.dispatchEvent(new CustomEvent('open-directors-pal', {
      detail: { seed: `About "${section.title}": ` , sectionId: section.id },
    }))
  }

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-[min(94vw,1080px)] h-[min(86vh,680px)] bg-zinc-900 rounded-xl border border-zinc-700/80 shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-zinc-800 bg-zinc-900/95">
          <div className="w-8 h-8 rounded-lg bg-amber-600/20 flex items-center justify-center">
            <HelpCircle className="h-4 w-4 text-amber-400" />
          </div>
          <div className="flex-1">
            <h2 className="text-sm font-semibold text-white">Help Center</h2>
            <p className="text-[11px] text-zinc-500 mt-0.5">Every part of Directors Desktop — pick a topic or search.</p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors p-1" title="Close (Esc)">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* ── TOC ── */}
          <aside className="w-64 border-r border-zinc-800 flex flex-col min-h-0">
            <div className="p-2.5 border-b border-zinc-800/70">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-zinc-600" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search help…"
                  className="w-full pl-8 pr-3 py-1.5 bg-zinc-800 rounded-md text-[11px] text-white placeholder-zinc-600 outline-none border border-zinc-700/40 focus:border-amber-500/50 transition-colors"
                />
              </div>
            </div>
            <nav className="flex-1 overflow-y-auto p-2 space-y-3">
              {groups.map(({ area, sections }) => {
                const visible = sections.filter((s) => matchIds.has(s.id))
                if (visible.length === 0) return null
                return (
                  <div key={area}>
                    <h4 className="px-2 text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-1">{area}</h4>
                    {visible.map((s) => {
                      const isActive = s.id === activeId
                      return (
                        <button
                          key={s.id}
                          onClick={() => setActiveId(s.id)}
                          className={`w-full px-2 py-1.5 rounded-md text-left text-[12px] flex items-center gap-2 transition-colors ${
                            isActive ? 'bg-amber-600/20 text-amber-200' : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'
                          }`}
                        >
                          <Icon name={s.icon} className="h-3.5 w-3.5 flex-shrink-0" />
                          <span className="truncate">{s.title}</span>
                        </button>
                      )
                    })}
                  </div>
                )
              })}
              {matches.length === 0 && (
                <p className="px-2 py-6 text-center text-[11px] text-zinc-600">No topics match “{query}”.</p>
              )}
            </nav>
          </aside>

          {/* ── Article ── */}
          <section ref={articleRef} className="flex-1 min-w-0 overflow-y-auto">
            {active ? (
              <article className="p-5">
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-lg bg-zinc-800 border border-zinc-700/60 flex items-center justify-center flex-shrink-0">
                    <Icon name={active.icon} className="h-4.5 w-4.5 text-amber-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">{active.area}</div>
                    <h3 className="text-base font-semibold text-white leading-tight">{active.title}</h3>
                  </div>
                  <button
                    onClick={() => askDirectorsPal(active)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium text-amber-300 border border-amber-600/40 hover:bg-amber-600/15 transition-colors flex-shrink-0"
                    title="Ask Director’s Pal about this"
                  >
                    <Bot className="h-3.5 w-3.5" /> Ask Director’s Pal
                  </button>
                </div>

                <p className="mt-3 text-[13px] text-zinc-300 leading-relaxed">{active.blurb}</p>

                {active.reach && (
                  <p className="mt-2 text-[11px] text-zinc-500 flex items-center gap-1.5">
                    <ChevronRight className="h-3 w-3 text-zinc-600" /> {active.reach}
                  </p>
                )}

                {active.screenshot && (
                  <img
                    src={active.screenshot}
                    alt={`${active.title} screenshot`}
                    className="mt-3 rounded-lg border border-zinc-700/60 max-h-56 w-auto object-contain bg-zinc-950"
                  />
                )}

                {active.steps && active.steps.length > 0 && (
                  <ol className="mt-4 space-y-1.5">
                    {active.steps.map((step, i) => (
                      <li key={i} className="flex gap-2.5 text-[12px] text-zinc-300">
                        <span className="flex-shrink-0 w-4 h-4 rounded-full bg-amber-600/20 text-amber-300 text-[10px] font-semibold flex items-center justify-center mt-0.5">{i + 1}</span>
                        <span className="leading-snug">{step}</span>
                      </li>
                    ))}
                  </ol>
                )}

                {active.controls && active.controls.length > 0 && (
                  <div className="mt-4">
                    <h4 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-2">Controls</h4>
                    <div className="grid grid-cols-2 gap-1.5">
                      {active.controls.map((c) => (
                        <div key={c.label} className="flex items-start gap-2 rounded-md border border-zinc-800 bg-zinc-800/40 px-2 py-1.5">
                          <Icon name={c.icon} className="h-3.5 w-3.5 text-amber-400 mt-0.5 flex-shrink-0" />
                          <div className="min-w-0">
                            <div className="text-[11px] font-medium text-zinc-200 flex items-center gap-1.5">
                              {c.label}
                              {c.shortcut && <span className="font-mono text-[9px] text-zinc-500 border border-zinc-700 rounded px-1">{c.shortcut}</span>}
                            </div>
                            <div className="text-[10px] text-zinc-500 leading-snug">{c.desc}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {active.related && active.related.length > 0 && (
                  <div className="mt-4 flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] text-zinc-600">See also:</span>
                    {active.related.map((rid) => {
                      const r = HELP_SECTIONS.find((s) => s.id === rid)
                      if (!r) return null
                      return (
                        <button
                          key={rid}
                          onClick={() => setActiveId(rid)}
                          className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] text-zinc-400 border border-zinc-700 hover:border-amber-500/50 hover:text-amber-300 transition-colors"
                        >
                          <Icon name={r.icon} className="h-3 w-3" /> {r.title}
                        </button>
                      )
                    })}
                  </div>
                )}
              </article>
            ) : (
              <div className="h-full flex items-center justify-center text-zinc-600 text-sm">Select a topic.</div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
