import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, X, Send, Loader2, Wrench, Sparkles } from 'lucide-react'
import { runAgent, type ChatMessage, type LLMTurn, type ToolContext, type AgentStep } from '../lib/directors-pal/agent'
import { DIRECTORS_PAL_TOOLS, buildSystemPrompt } from '../lib/directors-pal/tools'
import { helpKnowledgeText } from '../help/help-content'
import { useProjects } from '../contexts/ProjectContext'
import { useAppSettings } from '../contexts/AppSettingsContext'
import { logger } from '../lib/logger'

/**
 * Director's Pal — the always-there chat bubble. Ask it how to use the app (it
 * answers from the Help) or tell it what to make (it drives the queue, the
 * timeline, and can SEE clips). Mounted at the App root so it's reachable from
 * every view. The agent loop + tools are unit-tested separately; this component
 * wires the REAL context: the LLM proxy, backend fetch, and clip perception.
 */

interface DisplayMsg { role: 'user' | 'assistant'; text: string; steps?: AgentStep[] }

const fileUrlToPath = (u: string): string =>
  u.startsWith('file:///') ? decodeURIComponent(u.slice(8))
    : u.startsWith('file://') ? decodeURIComponent(u.slice(7))
    : u

export function DirectorsPal() {
  const { currentView } = useProjects()
  const { settings } = useAppSettings()
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [display, setDisplay] = useState<DisplayMsg[]>([])
  const historyRef = useRef<ChatMessage[]>([]) // full thread minus the system message
  const scrollRef = useRef<HTMLDivElement>(null)
  const currentViewRef = useRef(currentView)
  currentViewRef.current = currentView

  // Open (and optionally seed) from anywhere — e.g. Help's "Ask Director's Pal".
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail
      setOpen(true)
      if (detail?.seed) setInput((prev) => prev || String(detail.seed))
    }
    window.addEventListener('open-directors-pal', onOpen)
    return () => window.removeEventListener('open-directors-pal', onOpen)
  }, [])

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }) }, [display, busy])

  // ── real ToolContext ──────────────────────────────────────────────────────
  const backend = useCallback(async () => window.electronAPI.getBackendUrl(), [])

  const makeCtx = useCallback((): ToolContext => ({
    knowledge: helpKnowledgeText(),
    fetchJson: async (path, init) => {
      const base = await backend()
      const r = await fetch(`${base}${path}`, init)
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error((b as { detail?: string }).detail || `HTTP ${r.status}`) }
      return r.json()
    },
    fetchText: async (path, init) => {
      const base = await backend()
      const r = await fetch(`${base}${path}`, init)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.text()
    },
    openHelp: (sectionId) => window.dispatchEvent(new CustomEvent('open-help', { detail: { sectionId } })),
    // Perception: resolve a clip id → a frame image path (extract a frame for
    // video, use the source for an image), so caption-image can "see" it.
    resolveClipFrame: async (clipId) => {
      try {
        const base = await backend()
        const res = await fetch(`${base}/api/project/current`)
        if (!res.ok) return null
        const data = (await res.json()) as { project?: { activeTimelineId?: string; timelines?: Array<{ id: string; clips?: Array<Record<string, unknown>> }>; assets?: Array<Record<string, unknown>> } }
        const tls = data.project?.timelines ?? []
        const tl = tls.find((t) => t.id === data.project?.activeTimelineId) ?? tls[0]
        const clip = (tl?.clips ?? []).find((c) => c.id === clipId) as Record<string, unknown> | undefined
        if (!clip) return null
        const assets = data.project?.assets ?? []
        const asset = clip.assetId ? assets.find((a) => a.id === clip.assetId) : (clip.asset as Record<string, unknown> | undefined)
        const srcUrl = (clip.importedUrl as string) || (asset?.url as string) || ''
        if (!srcUrl) return null
        if (clip.type !== 'video') return fileUrlToPath(srcUrl)
        const trimStart = typeof clip.trimStart === 'number' ? clip.trimStart : 0
        const duration = typeof clip.duration === 'number' ? clip.duration : 2
        const seek = trimStart + Math.min(1, duration / 2)
        const { path } = await window.electronAPI.extractVideoFrame(srcUrl, seek, 1024, 2)
        return path
      } catch (e) {
        logger.error(`Director's Pal resolveClipFrame failed: ${e}`)
        return null
      }
    },
  }), [backend])

  const callLLM = useCallback((): LLMTurn => async (messages, tools) => {
    const base = await backend()
    const r = await fetch(`${base}/api/assistant/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, tools }),
    })
    if (!r.ok) {
      const b = await r.json().catch(() => ({}))
      throw new Error((b as { detail?: string }).detail || `Assistant error ${r.status}`)
    }
    return r.json()
  }, [backend])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setDisplay((d) => [...d, { role: 'user', text }])
    setBusy(true)
    try {
      const system = buildSystemPrompt({ knowledge: helpKnowledgeText(), context: `Current view: ${currentViewRef.current}` })
      const history: ChatMessage[] = [...historyRef.current, { role: 'user', content: text }]
      const res = await runAgent({ system, history, tools: DIRECTORS_PAL_TOOLS, ctx: makeCtx(), callLLM: callLLM() })
      historyRef.current = res.messages.slice(1) // drop the system message; keep the rest for context
      setDisplay((d) => [...d, { role: 'assistant', text: res.reply || '(no reply)', steps: res.steps }])
    } catch (e) {
      setDisplay((d) => [...d, { role: 'assistant', text: `⚠️ ${e instanceof Error ? e.message : 'Something went wrong.'}` }])
    } finally {
      setBusy(false)
    }
  }, [input, busy, makeCtx, callLLM])

  const noKey = !settings.hasOpenrouterApiKey

  return (
    <>
      {/* Launcher bubble — always visible, every view */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-4 right-4 z-[90] h-12 w-12 rounded-full bg-amber-500 hover:bg-amber-400 text-zinc-950 shadow-lg shadow-amber-900/30 flex items-center justify-center transition-colors"
          title="Ask Director’s Pal"
        >
          <Bot className="h-6 w-6" />
        </button>
      )}

      {open && (
        <div className="fixed bottom-4 right-4 z-[90] w-[380px] h-[min(72vh,560px)] bg-zinc-900 rounded-xl border border-zinc-700/80 shadow-2xl flex flex-col overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2.5 border-b border-zinc-800 bg-zinc-900/95">
            <div className="w-7 h-7 rounded-lg bg-amber-600/20 flex items-center justify-center">
              <Bot className="h-4 w-4 text-amber-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-white leading-none">Director’s Pal</div>
              <div className="text-[10px] text-zinc-500 mt-0.5">Ask, or tell me what to make</div>
            </div>
            <button onClick={() => setOpen(false)} className="text-zinc-500 hover:text-white p-1" title="Close"><X className="h-4 w-4" /></button>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
            {display.length === 0 && (
              <div className="text-center text-zinc-500 pt-6 px-4">
                <Sparkles className="h-6 w-6 mx-auto mb-2 text-amber-500/70" />
                <p className="text-[12px] leading-relaxed">
                  Hi — I’m Director’s Pal. Ask me <span className="text-zinc-300">“how do I add captions?”</span> or tell me
                  <span className="text-zinc-300"> “generate 4 rooftop shots”</span> or <span className="text-zinc-300">“what’s on clip 3?”</span>
                </p>
                {noKey && <p className="mt-3 text-[11px] text-amber-400/90">Add an OpenRouter key in Settings → API Keys to enable me.</p>}
              </div>
            )}
            {display.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                <div className={`max-w-[85%] rounded-lg px-3 py-2 text-[12px] leading-relaxed whitespace-pre-wrap ${
                  m.role === 'user' ? 'bg-amber-600/20 text-amber-50' : 'bg-zinc-800 text-zinc-200'
                }`}>
                  {m.text}
                  {m.steps && m.steps.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-zinc-700/60 space-y-1">
                      {m.steps.map((s, j) => (
                        <div key={j} className="flex items-center gap-1.5 text-[10px] text-zinc-500">
                          <Wrench className={`h-3 w-3 ${s.ok ? 'text-emerald-500' : 'text-red-400'}`} />
                          <span className="font-mono">{s.tool}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {busy && (
              <div className="flex justify-start">
                <div className="rounded-lg px-3 py-2 bg-zinc-800 text-zinc-400 text-[12px] flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Working…
                </div>
              </div>
            )}
          </div>

          <div className="p-2.5 border-t border-zinc-800">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
                rows={1}
                placeholder="Ask or instruct…"
                className="flex-1 resize-none rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:border-amber-500 focus:outline-none max-h-28"
              />
              <button
                onClick={() => void send()}
                disabled={busy || !input.trim()}
                className="h-9 w-9 flex items-center justify-center rounded-md bg-amber-500 hover:bg-amber-400 text-zinc-950 disabled:opacity-40 transition-colors"
                title="Send"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
