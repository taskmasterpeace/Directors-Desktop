import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Loader2, Sparkles, Wand2, X } from 'lucide-react'

interface DirectionOption {
  id: string
  label: string
  hint: string
}

interface EnhanceDirectorModalProps {
  open: boolean
  prompt: string
  model: string
  /** Conditioning frame path — when set, the enhancer SEES the image (vision
   *  caption grounds the question and all four takes). */
  imagePath?: string | null
  onClose: () => void
  onApply: (text: string) => void
}

/**
 * The director's enhance flow (Robert's spec): click enhance → the model
 * analyzes your draft and asks ONE useful question with four directions →
 * you pick → four full enhanced prompts come back, ALL visible → click the
 * one you want. H3 prompt craft (native audio, spoken quotes, one continuous
 * shot) is baked into the backend prompts.
 */
export function EnhanceDirectorModal({ open, prompt, model, imagePath, onClose, onApply }: EnhanceDirectorModalProps) {
  const [phase, setPhase] = useState<'loading' | 'directions' | 'variants'>('loading')
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState<DirectionOption[]>([])
  const [variants, setVariants] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyDirection, setBusyDirection] = useState<string | null>(null)

  const api = useCallback(async (body: Record<string, unknown>) => {
    const backendUrl = await window.electronAPI.getBackendUrl()
    const res = await fetch(`${backendUrl}/api/enhance-prompt/options`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, ...(imagePath ? { imagePath } : {}) }),
    })
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`)
    return res.json() as Promise<{ question?: string; options?: DirectionOption[]; variants?: string[] }>
  }, [imagePath])

  // Esc closes — same convention as queue editing and the lightbox.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Phase 1: analyze the draft, get the direction question. Extracted so the
  // error strip's "Try again" can re-run it without a close-and-reopen.
  const loadDirections = useCallback(async () => {
    setPhase('loading')
    setError(null)
    setVariants([])
    try {
      const data = await api({ prompt, model })
      setQuestion(data.question ?? 'How do you want this shot to feel?')
      setOptions(data.options ?? [])
      setPhase('directions')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Enhancement unavailable')
      setPhase('directions')
    }
  }, [api, prompt, model])

  useEffect(() => {
    if (!open) return
    void loadDirections()
  }, [open, loadDirections])

  const pickDirection = useCallback(async (id: string) => {
    setBusyDirection(id)
    setError(null)
    try {
      const data = await api({ prompt, model, direction: id })
      setVariants(data.variants ?? [])
      setPhase('variants')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not generate variants')
    } finally {
      setBusyDirection(null)
    }
  }, [api, prompt, model])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-5 py-3.5 border-b border-zinc-800">
          <Wand2 className="h-4 w-4 text-amber-400" />
          <h2 className="text-sm font-semibold text-white">
            {phase === 'variants' ? 'Pick your take' : 'Direct this shot'}
          </h2>
          {phase === 'variants' && (
            <button
              onClick={() => setPhase('directions')}
              className="ml-2 flex items-center gap-1 text-xs text-zinc-400 hover:text-white"
            >
              <ArrowLeft className="h-3 w-3" /> directions
            </button>
          )}
          <button onClick={onClose} aria-label="Close" className="ml-auto p-1.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-800">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto">
          {error && (
            <div className="mb-3 flex items-center gap-2 text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded-md px-2.5 py-1.5">
              <span className="flex-1 min-w-0 truncate" title={error}>{error}</span>
              {phase === 'directions' && options.length === 0 && (
                <button
                  onClick={() => void loadDirections()}
                  className="shrink-0 font-semibold text-amber-400 hover:text-amber-300"
                >
                  Try again
                </button>
              )}
            </div>
          )}

          {phase === 'loading' && (
            <div className="flex items-center gap-2 text-sm text-zinc-400 py-8 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" /> Reading your prompt…
            </div>
          )}

          {phase === 'directions' && (
            <>
              <p className="text-sm text-zinc-300 mb-3">{question}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {options.map(o => (
                  <button
                    key={o.id}
                    onClick={() => void pickDirection(o.id)}
                    disabled={busyDirection !== null}
                    className="text-left rounded-lg border border-zinc-700 bg-zinc-800/60 hover:border-amber-500/50 hover:bg-zinc-800 px-3 py-2.5 transition-colors disabled:opacity-50"
                  >
                    <span className="text-sm font-medium text-white flex items-center gap-2">
                      {busyDirection === o.id && <Loader2 className="h-3 w-3 animate-spin" />}
                      {o.label}
                    </span>
                    {o.hint && <span className="block text-[11px] text-zinc-500 mt-0.5">{o.hint}</span>}
                  </button>
                ))}
              </div>
              {busyDirection && (
                <p className="mt-3 text-[11px] text-zinc-500">Writing four takes — this uses the enhancer and can take ~20 seconds…</p>
              )}
            </>
          )}

          {phase === 'variants' && (
            <div className="space-y-2">
              {variants.map((v, i) => (
                <button
                  key={i}
                  onClick={() => { onApply(v); onClose() }}
                  className="w-full text-left rounded-lg border border-zinc-700 bg-zinc-800/60 hover:border-amber-500/60 hover:bg-zinc-800 px-3 py-2.5 transition-colors group"
                >
                  <span className="text-[10px] uppercase tracking-wider text-amber-400/80 flex items-center gap-1.5">
                    <Sparkles className="h-3 w-3" /> Take {i + 1}
                  </span>
                  <span className="block text-xs text-zinc-200 mt-1 leading-relaxed">{v}</span>
                </button>
              ))}
              {variants.length === 0 && !error && (
                <p className="text-sm text-zinc-500">Nothing came back — try another direction.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
