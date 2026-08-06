import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft, BookOpenText, Clapperboard, Copy, Check, Drama, ExternalLink,
  FolderSearch, Loader2, MicVocal, RefreshCw, Sparkles, Theater, Wand2,
} from 'lucide-react'
import { useProjects } from '../contexts/ProjectContext'
import { Button } from '../components/ui/button'
import { loadDramatisChapter, type DramatisExport } from '../lib/dramatis-loader'

/* ────────────────────────────────────────────────────────────────────────────
   Story Stage — character-voiced stories, un-mixed, onto the editor timeline.

   Left rail: the Audio Movie Studio bookshelf (per-chapter render state).
   Main: cast (visual descriptions + voice coverage + line counts), chapter
   cards with the money button — "Place on timeline" — and an honest cost card
   (local engines are free; hero lines are the only dollars).
   ──────────────────────────────────────────────────────────────────────────── */

interface ChapterState {
  number: number
  heading: string
  scenes: number
  cueSpecs: number
  musicSpecs: number
  rendered: boolean
  stale: boolean
  lines: number | null
  cues: number | null
  durationSec: number | null
}

interface BookSummary {
  id: string
  dir: string
  title: string
  author: string | null
  entities: number
  characters: number
  chapters: ChapterState[]
}

interface StatusResponse {
  available: boolean
  root: string | null
  configuredRoot: string | null
  books: BookSummary[]
}

interface EntityDetail {
  id: string
  kind: string
  names: string[]
  visual: string | null
  voices: Record<string, Record<string, unknown>>
}

interface BookDetail {
  id: string
  dir: string
  title: string
  author: string | null
  engines: string[]
  entities: EntityDetail[]
  hints: number
  heroLines: number
  cost: { localUsd: number; localPts: number; heroEstUsd: number; note: string }
  chapters: ChapterState[]
}

const STUDIO_URL = 'http://127.0.0.1:4600'

async function api<T>(path: string): Promise<T> {
  const backendUrl = await window.electronAPI.getBackendUrl()
  const res = await fetch(`${backendUrl}${path}`)
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) detail = body.error
    } catch { /* body was not JSON */ }
    throw new Error(detail)
  }
  return res.json() as Promise<T>
}

function fmtDur(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return '—'
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`
}

const displayName = (e: EntityDetail): string =>
  e.names[0] ?? e.id.split(/[_-]+/).map(w => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ')

export function StoryStage() {
  const { goHome, importDramatisChapter } = useProjects()
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [selectedDir, setSelectedDir] = useState<string | null>(null)
  const [book, setBook] = useState<BookDetail | null>(null)
  const [bookLoading, setBookLoading] = useState(false)
  const [studioUp, setStudioUp] = useState<boolean | null>(null)
  const [placing, setPlacing] = useState<number | null>(null)
  const [placeError, setPlaceError] = useState<string | null>(null)
  const [copiedVisual, setCopiedVisual] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const s = await api<StatusResponse>('/api/dramatis/status')
      setStatus(s)
      setStatusError(null)
      if (s.available && s.books.length > 0) {
        setSelectedDir(prev => prev ?? s.books[0].dir)
      }
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : 'Backend unreachable')
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // The Studio owns rendering; we only report whether it's up. A 1.5s budget —
  // this is a liveness probe, not a request.
  useEffect(() => {
    let dead = false
    const probe = async () => {
      try {
        const ctl = new AbortController()
        const t = setTimeout(() => ctl.abort(), 1500)
        const res = await fetch(`${STUDIO_URL}/api/books`, { signal: ctl.signal })
        clearTimeout(t)
        if (!dead) setStudioUp(res.ok)
      } catch {
        if (!dead) setStudioUp(false)
      }
    }
    void probe()
    const iv = setInterval(() => void probe(), 15000)
    return () => { dead = true; clearInterval(iv) }
  }, [])

  useEffect(() => {
    if (!selectedDir) return
    setBookLoading(true)
    setBook(null)
    void (async () => {
      try {
        setBook(await api<BookDetail>(`/api/dramatis/book/${selectedDir}`))
      } catch {
        setBook(null)
      } finally {
        setBookLoading(false)
      }
    })()
  }, [selectedDir])

  const placeChapter = useCallback(async (ch: ChapterState) => {
    if (!book) return
    setPlacing(ch.number)
    setPlaceError(null)
    try {
      const data = await api<DramatisExport>(`/api/dramatis/export/${book.dir}/${ch.number}`)
      const loaded = loadDramatisChapter(data)
      importDramatisChapter(loaded, book.title)
    } catch (e) {
      setPlaceError(e instanceof Error ? e.message : 'Import failed')
    } finally {
      setPlacing(null)
    }
  }, [book, importDramatisChapter])

  const copyVisual = useCallback((id: string, visual: string) => {
    void navigator.clipboard.writeText(visual)
    setCopiedVisual(id)
    setTimeout(() => setCopiedVisual(null), 1500)
  }, [])

  const characters = useMemo(() => (book?.entities ?? []).filter(e => e.kind === 'character'), [book])
  const narrators = useMemo(() => (book?.entities ?? []).filter(e => e.kind !== 'character'), [book])

  return (
    <div className="h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="flex items-center gap-3 px-5 py-3 border-b border-zinc-800">
        <button onClick={goHome} className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors" aria-label="Back to home">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <Theater className="h-5 w-5 text-amber-400" />
        <div>
          <h1 className="text-sm font-semibold text-white leading-tight">Story Stage</h1>
          <p className="text-[11px] text-zinc-500 leading-tight">Character-voiced stories from Audio Movie Studio — placed on your timeline un-mixed</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {/* Studio liveness — the render room */}
          <button
            onClick={() => { if (studioUp) window.open(STUDIO_URL) }}
            disabled={!studioUp}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs transition-colors ${
              studioUp
                ? 'border-emerald-600/50 text-emerald-400 hover:bg-zinc-800'
                : 'border-zinc-700 text-zinc-500'
            }`}
            title={studioUp ? 'Open Audio Movie Studio (renders, auditions, cue approval)' : 'Studio not running — start it with start-studio.cmd in the dramatis folder'}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${studioUp ? 'bg-emerald-500' : 'bg-zinc-600'}`} />
            Studio {studioUp ? 'running' : 'offline'}
            {studioUp && <ExternalLink className="h-3 w-3" />}
          </button>
          <button
            onClick={() => void refresh()}
            className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
            title="Rescan the bookshelf"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {/* No install found — a setup card, never a crash */}
      {status && !status.available && (
        <div className="flex-1 flex items-center justify-center">
          <div className="max-w-md text-center space-y-3 px-6">
            <div className="mx-auto w-14 h-14 rounded-full bg-amber-500/10 flex items-center justify-center">
              <FolderSearch className="h-7 w-7 text-amber-400" />
            </div>
            <h2 className="text-base font-semibold text-white">Audio Movie Studio not found</h2>
            <p className="text-sm text-zinc-400">
              The Story Stage reads books from your Audio Movie Studio (dramatis) install.
              {status.configuredRoot
                ? <> The configured folder <code className="text-amber-300">{status.configuredRoot}</code> doesn't look like one (no <code>books/</code> inside).</>
                : <> None was found at the default location.</>}
            </p>
            <p className="text-xs text-zinc-500">Point Settings → “Dramatis root” at the folder that contains <code>books/</code> and <code>studio/</code>, then rescan.</p>
            <Button variant="outline" className="border-zinc-700" onClick={() => void refresh()}>
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Rescan
            </Button>
          </div>
        </div>
      )}

      {statusError && (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-red-400">{statusError}</p>
        </div>
      )}

      {status?.available && (
        <div className="flex-1 flex min-h-0">
          {/* Bookshelf rail */}
          <aside className="w-72 shrink-0 border-r border-zinc-800 overflow-y-auto p-3 space-y-2">
            <h3 className="px-1 text-[11px] font-semibold text-zinc-500 uppercase tracking-wider flex items-center gap-1.5">
              <BookOpenText className="h-3.5 w-3.5" /> Bookshelf
            </h3>
            {status.books.length === 0 && (
              <p className="px-1 text-xs text-zinc-500">No books yet — create one in the Studio (paste a manuscript, it drafts cast and cues).</p>
            )}
            {status.books.map(b => {
              const rendered = b.chapters.filter(c => c.rendered).length
              const active = b.dir === selectedDir
              return (
                <button
                  key={b.dir}
                  onClick={() => setSelectedDir(b.dir)}
                  className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors ${
                    active ? 'border-amber-500/50 bg-amber-500/5' : 'border-zinc-800 bg-zinc-900 hover:border-zinc-600'
                  }`}
                >
                  <p className="text-sm font-medium text-white truncate">{b.title}</p>
                  {b.author && <p className="text-[11px] text-zinc-500 truncate">{b.author}</p>}
                  <p className="text-[11px] text-zinc-500 mt-1">
                    {b.characters} character{b.characters === 1 ? '' : 's'} · {rendered}/{b.chapters.length} chapter{b.chapters.length === 1 ? '' : 's'} rendered
                  </p>
                </button>
              )
            })}
            <p className="px-1 pt-2 text-[10px] text-zinc-600">Reading from {status.root}</p>
          </aside>

          {/* Book detail */}
          <main className="flex-1 min-w-0 overflow-y-auto p-5 space-y-6">
            {bookLoading && (
              <div className="flex items-center gap-2 text-sm text-zinc-400 py-10 justify-center">
                <Loader2 className="h-4 w-4 animate-spin" /> Opening the book…
              </div>
            )}

            {book && (
              <>
                {/* Title + cost card */}
                <div className="flex flex-wrap items-start gap-4">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-semibold text-white">{book.title}</h2>
                    {book.author && <p className="text-xs text-zinc-500">{book.author}</p>}
                    <p className="text-xs text-zinc-400 mt-1.5 flex items-center gap-1.5">
                      <MicVocal className="h-3.5 w-3.5 text-amber-400" />
                      Voice engines cast: {book.engines.length ? book.engines.join(' · ') : 'none yet'}
                    </p>
                  </div>
                  <div className="shrink-0 rounded-lg border border-zinc-800 bg-zinc-900 px-3.5 py-2.5 w-64">
                    <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">What this costs</p>
                    <p className="text-sm text-emerald-400 font-medium mt-1">Local render — free · 0 pts</p>
                    <p className="text-[11px] text-zinc-400 mt-0.5">
                      {book.heroLines > 0
                        ? <>Hero lines ({book.heroLines}): ~${book.cost.heroEstUsd.toFixed(2)} via ElevenLabs (your key), only on the hybrid profile.</>
                        : <>No hero lines dialed in — the whole book renders on this machine.</>}
                    </p>
                  </div>
                </div>

                {/* Cast */}
                <section>
                  <h3 className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider flex items-center gap-1.5 mb-2">
                    <Drama className="h-3.5 w-3.5" /> Cast — {characters.length} character{characters.length === 1 ? '' : 's'}
                    {narrators.length > 0 && <span className="normal-case font-normal">+ narrator</span>}
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
                    {[...narrators, ...characters].map(e => (
                      <div key={e.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
                        <div className="flex items-center gap-2">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                            e.kind === 'character' ? 'bg-amber-500/15 text-amber-400' : 'bg-zinc-800 text-zinc-400'
                          }`}>
                            {displayName(e).slice(0, 2)}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-white truncate">{displayName(e)}</p>
                            <p className="text-[10px] text-zinc-500">{e.kind === 'character' ? (e.names.slice(1, 3).join(', ') || 'character') : 'narrator'}</p>
                          </div>
                          <div className="ml-auto flex items-center gap-1">
                            {Object.keys(e.voices).map(eng => (
                              <span key={eng} className="text-[9px] uppercase tracking-wide bg-zinc-800 text-zinc-400 rounded px-1 py-0.5" title={`${eng} voice cast`}>
                                {eng === 'elevenlabs' ? '11L' : eng}
                              </span>
                            ))}
                            {Object.keys(e.voices).length === 0 && (
                              <span className="text-[9px] text-zinc-600" title="No voice cast yet — cast one in the Studio">no voice</span>
                            )}
                          </div>
                        </div>
                        {e.visual && (
                          <div className="mt-2 flex items-start gap-1.5">
                            <p className="flex-1 text-[11px] text-zinc-400 leading-snug line-clamp-2" title={e.visual}>{e.visual}</p>
                            <button
                              onClick={() => copyVisual(e.id, e.visual!)}
                              className="shrink-0 p-1 rounded text-zinc-500 hover:text-white hover:bg-zinc-800"
                              title="Copy the visual description (paste it into the Playground to generate this character)"
                            >
                              {copiedVisual === e.id ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] text-zinc-600 mt-1.5 flex items-center gap-1">
                    <Wand2 className="h-3 w-3" /> Visual descriptions are written for image gen — copy one into the Playground (paste button) to put a face on the voice.
                  </p>
                </section>

                {/* Chapters */}
                <section>
                  <h3 className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider flex items-center gap-1.5 mb-2">
                    <Clapperboard className="h-3.5 w-3.5" /> Chapters
                  </h3>
                  {placeError && (
                    <p className="mb-2 text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded-md px-2.5 py-1.5">{placeError}</p>
                  )}
                  <div className="space-y-2">
                    {book.chapters.map(ch => (
                      <div key={ch.number} className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3.5 py-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-white truncate">
                            {ch.heading}
                            {ch.stale && (
                              <span className="ml-2 text-[10px] text-amber-400/90 border border-amber-500/40 rounded px-1 py-0.5" title="The book changed after this render — re-render in the Studio to refresh">
                                stale
                              </span>
                            )}
                          </p>
                          <p className="text-[11px] text-zinc-500">
                            {ch.rendered
                              ? <>{ch.lines} lines · {ch.cues} SFX · {fmtDur(ch.durationSec)}</>
                              : <>{ch.scenes} scenes · {ch.cueSpecs} cues planned — not rendered yet</>}
                          </p>
                        </div>
                        {ch.rendered ? (
                          <Button
                            onClick={() => void placeChapter(ch)}
                            disabled={placing !== null}
                            className="bg-amber-500 hover:bg-amber-400 text-zinc-950 h-8 px-3 text-xs font-semibold"
                            title="New project: dialogue, SFX, ambience and score land as SEPARATE clips — nothing is mixed down"
                          >
                            {placing === ch.number
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <><Sparkles className="h-3.5 w-3.5 mr-1.5" />Place on timeline</>}
                          </Button>
                        ) : (
                          <span
                            className="text-[11px] text-zinc-500"
                            title={studioUp ? 'Render it in the Studio, then place it here' : 'Start the Studio (start-studio.cmd) to render'}
                          >
                            render in {studioUp
                              ? <button onClick={() => window.open(STUDIO_URL)} className="text-amber-400 hover:text-amber-300 underline underline-offset-2">the Studio</button>
                              : 'the Studio'} first
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] text-zinc-600 mt-2">
                    Placing creates a new project: A1 dialogue (one clip per attributed line), A2 SFX at word-aligned onsets, A3 ambience, A4 music — with the read-along script as subtitles. Video tracks stay open for the motion phase.
                  </p>
                </section>
              </>
            )}

            {!bookLoading && !book && selectedDir && (
              <p className="text-sm text-zinc-500">Could not read that book — its book.json may be broken.</p>
            )}
          </main>
        </div>
      )}

      {!status && !statusError && (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
        </div>
      )}
    </div>
  )
}
