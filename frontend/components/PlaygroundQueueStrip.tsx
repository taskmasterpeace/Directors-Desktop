import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowDown, ArrowUp, Copy, Film, FolderOpen, Link2, ListVideo, Loader2, Pencil, X } from 'lucide-react'
import { getEstimatedSeconds, type QueueJob } from '../hooks/use-generation'
import { getPersonalEtaSeconds } from '../lib/model-timing'
import { getVideoModel } from '../lib/video-models'
import { useProjects } from '../contexts/ProjectContext'

interface PlaygroundQueueStripProps {
  /** Load a queued job into the Playground form for edit-before-render. */
  onEditJob?: (job: QueueJob) => void
}

function pathToFileUrl(p: string): string {
  const n = p.replace(/\\/g, '/')
  return n.startsWith('/') ? `file://${n}` : `file:///${n}`
}

function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/** The attachment the job will actually condition on, for the card thumbnail. */
function jobThumbSrc(job: QueueJob): string | null {
  const p = job.params
  const refs = Array.isArray(p.referenceImagePaths) ? (p.referenceImagePaths as string[]) : []
  const img = typeof p.imagePath === 'string' && p.imagePath ? p.imagePath : null
  const chosen = refs[0] ?? img
  return chosen ? pathToFileUrl(chosen) : null
}

/**
 * The Playground's queue as a WORK SURFACE, not a readout: every card carries
 * the image it will condition on, the prompt, model, seed, and a live
 * projected-finish clock — with reorder / edit / duplicate / remove on
 * pending cards and a "finished → View in Gallery" trail so a render is never
 * a mystery again. Self-polling, so fire-and-forget "+ Queue" submissions
 * appear without the result panel being involved.
 */
export function PlaygroundQueueStrip({ onEditJob }: PlaygroundQueueStripProps) {
  const { openGallery } = useProjects()
  const [jobs, setJobs] = useState<QueueJob[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  // Session-scoped: hides finished-trail rows the user has dismissed.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const jobsRef = useRef<QueueJob[]>([])
  jobsRef.current = jobs

  const refresh = useCallback(async () => {
    try {
      const backendUrl = await window.electronAPI.getBackendUrl()
      const res = await fetch(`${backendUrl}/api/queue/status`)
      if (!res.ok) return
      const data = (await res.json()) as { jobs?: QueueJob[] }
      if (Array.isArray(data.jobs)) setJobs(data.jobs)
    } catch {
      // backend between restarts — keep the last snapshot
    }
  }, [])

  useEffect(() => {
    void refresh()
    const interval = setInterval(() => void refresh(), 2000)
    return () => clearInterval(interval)
  }, [refresh])

  const videoJobs = jobs.filter(j => j.type === 'video' || j.type === 'long_video')
  const running = videoJobs.filter(j => j.status === 'running')
  const queued = videoJobs.filter(j => j.status === 'queued')
  const finished = videoJobs
    .filter(j => j.status === 'complete' && j.result_paths.length > 0 && !dismissed.has(j.id))
    .slice(-3)
    .reverse()
  // A dead render must say so where the user is looking — failed jobs used to
  // vanish from this strip entirely (only running/queued/complete rendered).
  // The backend's terminal literal is "error" (job_queue.py Literal), NOT
  // "failed" — nolc(8) shipped with the wrong string and never fired.
  const failed = videoJobs
    .filter(j => j.status === 'error' && !dismissed.has(j.id))
    .slice(-2)
    .reverse()

  const api = useCallback(async (path: string, init?: RequestInit) => {
    const backendUrl = await window.electronAPI.getBackendUrl()
    return fetch(`${backendUrl}${path}`, init)
  }, [])

  const cancelJob = useCallback(async (id: string) => {
    setBusyId(id)
    try {
      await api(`/api/queue/cancel/${id}`, { method: 'POST' })
      await refresh()
    } finally {
      setBusyId(null)
    }
  }, [api, refresh])

  const duplicateJob = useCallback(async (job: QueueJob) => {
    setBusyId(job.id)
    try {
      // A duplicate is "another take": same shot, FRESH seed.
      const params = { ...job.params, seed: Math.floor(Math.random() * 2_147_483_647) }
      await api('/api/queue/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: job.type, model: job.model, params, tags: job.tags ?? [] }),
      })
      await refresh()
    } finally {
      setBusyId(null)
    }
  }, [api, refresh])

  const moveJob = useCallback(async (id: string, dir: -1 | 1) => {
    const ids = jobsRef.current
      .filter(j => (j.type === 'video' || j.type === 'long_video') && j.status === 'queued')
      .map(j => j.id)
    const idx = ids.indexOf(id)
    const target = idx + dir
    if (idx < 0 || target < 0 || target >= ids.length) return
    const next = [...ids]
    next.splice(idx, 1)
    next.splice(target, 0, id)
    setBusyId(id)
    try {
      await api('/api/queue/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ordered_ids: next }),
      })
      await refresh()
    } finally {
      setBusyId(null)
    }
  }, [api, refresh])

  if (running.length === 0 && queued.length === 0 && finished.length === 0 && failed.length === 0) return null

  // Projected finish clocks: running job's remainder, then queued jobs stacked
  // in order (personal average first, table estimate as fallback).
  const now = Date.now()
  let cursorSec = 0
  for (const j of running) {
    const est = getPersonalEtaSeconds(j.model, false) ?? getEstimatedSeconds(j) ?? 120
    const elapsed = (now - Date.parse(j.created_at)) / 1000
    cursorSec += Math.max(10, est - elapsed)
  }
  const finishAt = new Map<string, number>()
  for (const j of queued) {
    const est = getPersonalEtaSeconds(j.model, false) ?? getEstimatedSeconds(j) ?? 120
    cursorSec += est
    finishAt.set(j.id, cursorSec)
  }

  const modelLabel = (id: string) => getVideoModel(id)?.displayName ?? id

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-2 overflow-hidden">
      <div className="flex items-center gap-2 text-xs font-medium text-zinc-400">
        <ListVideo className="w-3.5 h-3.5" />
        {running.length + queued.length > 0 ? `Queue · ${running.length + queued.length}` : 'Recent renders'}
        <span className="ml-auto text-[10px] text-zinc-600">finished renders land in the Gallery</span>
      </div>

      {[...running, ...queued].map(job => {
        const thumb = jobThumbSrc(job)
        const isRunning = job.status === 'running'
        const prompt = typeof job.params.prompt === 'string' ? job.params.prompt : ''
        const seed = typeof job.params.seed === 'number' ? job.params.seed : null
        const eta = finishAt.get(job.id)
        const chained = !!job.batch_id?.startsWith('chain-')
        return (
          <div
            key={job.id}
            className={`flex items-center gap-2.5 rounded-md border px-2 py-1.5 ${
              isRunning ? 'border-amber-500/40 bg-amber-500/5' : 'border-zinc-800 bg-zinc-900'
            }`}
          >
            {/* Conditioning thumbnail — "whatever image the queue is gonna use" */}
            <div className="w-14 h-9 rounded overflow-hidden bg-zinc-800 shrink-0 flex items-center justify-center">
              {thumb ? (
                <img src={thumb} alt="" className="w-full h-full object-cover" />
              ) : (
                <Film className="w-4 h-4 text-zinc-600" />
              )}
            </div>

            <div className="min-w-0 flex-1">
              <p className="text-xs text-zinc-200 truncate" title={prompt}>{prompt || '(no prompt)'}</p>
              <p className="text-[10px] text-zinc-500 truncate">
                {modelLabel(job.model)}
                {' · '}{String(job.params.duration ?? '?')}s · {String(job.params.resolution ?? '')}
                {seed !== null && <> · seed {seed}</>}
                {chained && <span className="text-amber-400/80"> · <Link2 className="inline w-2.5 h-2.5" /> waits on image</span>}
              </p>
            </div>

            <div className="shrink-0 text-right">
              {isRunning ? (
                <span className="text-[10px] text-amber-300 tabular-nums flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {job.phase} {job.progress > 0 ? `${job.progress}%` : ''}
                </span>
              ) : (
                <span className="text-[10px] text-zinc-500 tabular-nums" title="Projected finish (stacked estimates)">
                  ~{eta !== undefined ? fmtClock(eta) : '—'}
                </span>
              )}
            </div>

            {/* Actions */}
            <div className="shrink-0 flex items-center gap-0.5">
              {!isRunning && (
                <>
                  <button aria-label="Run earlier" title="Run earlier" disabled={busyId === job.id}
                    onClick={() => void moveJob(job.id, -1)}
                    className="p-1 rounded text-zinc-500 hover:text-white hover:bg-zinc-800 disabled:opacity-40">
                    <ArrowUp className="w-3 h-3" />
                  </button>
                  <button aria-label="Run later" title="Run later" disabled={busyId === job.id}
                    onClick={() => void moveJob(job.id, 1)}
                    className="p-1 rounded text-zinc-500 hover:text-white hover:bg-zinc-800 disabled:opacity-40">
                    <ArrowDown className="w-3 h-3" />
                  </button>
                  {onEditJob && (
                    <button aria-label="Edit this shot" title="Edit this shot (loads into the form)"
                      onClick={() => onEditJob(job)}
                      className="p-1 rounded text-zinc-500 hover:text-amber-300 hover:bg-zinc-800">
                      <Pencil className="w-3 h-3" />
                    </button>
                  )}
                </>
              )}
              <button aria-label="Duplicate as a new take" title="Duplicate as a new take (fresh seed)"
                disabled={busyId === job.id}
                onClick={() => void duplicateJob(job)}
                className="p-1 rounded text-zinc-500 hover:text-white hover:bg-zinc-800 disabled:opacity-40">
                <Copy className="w-3 h-3" />
              </button>
              <button aria-label="Remove" title={isRunning ? 'Cancel this render' : 'Remove from queue'}
                disabled={busyId === job.id}
                onClick={() => void cancelJob(job.id)}
                className="p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-zinc-800 disabled:opacity-40">
                <X className="w-3 h-3" />
              </button>
            </div>
          </div>
        )
      })}

      {/* Failed — a dead render says so here instead of silently vanishing */}
      {failed.length > 0 && (
        <div className="pt-1 border-t border-zinc-800/70 space-y-1">
          {failed.map(job => (
            <div key={job.id} className="flex items-center gap-2.5 px-2 py-1">
              <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[11px] text-zinc-400 truncate">
                  {typeof job.params.prompt === 'string' ? job.params.prompt : job.id}
                </p>
                <p className="text-[10px] text-red-400/90 truncate" title={job.error ?? undefined}>
                  {job.error ?? 'render failed'}
                </p>
              </div>
              <button
                onClick={() => void duplicateJob(job)}
                disabled={busyId === job.id}
                className="shrink-0 text-[10px] text-amber-400 hover:text-amber-300 px-1.5 py-0.5 rounded hover:bg-zinc-800 disabled:opacity-50"
                title="Resubmit this shot with a fresh seed"
              >
                Retry
              </button>
              <button
                onClick={() => setDismissed(prev => new Set([...prev, job.id]))}
                className="shrink-0 p-0.5 rounded text-zinc-600 hover:text-zinc-300"
                title="Dismiss"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Recently finished — the "where do I actually get it" trail */}
      {finished.length > 0 && (
        <div className="pt-1 border-t border-zinc-800/70 space-y-1">
          <div className="flex justify-end px-2">
            <button
              onClick={() => setDismissed(prev => new Set([...prev, ...finished.map(j => j.id)]))}
              className="text-[10px] text-zinc-600 hover:text-zinc-400"
              title="Hide these finished rows (they stay in the Gallery)"
            >
              clear finished
            </button>
          </div>
          {finished.map(job => (
            <div key={job.id} className="flex items-center gap-2.5 px-2 py-1">
              <div className="w-14 h-9 rounded overflow-hidden bg-zinc-800 shrink-0">
                <video src={pathToFileUrl(job.result_paths[0])} muted preload="metadata" className="w-full h-full object-cover" />
              </div>
              <p className="text-[11px] text-zinc-500 truncate flex-1 min-w-0">
                {typeof job.params.prompt === 'string' ? job.params.prompt : job.id}
              </p>
              <button
                onClick={openGallery}
                className="shrink-0 flex items-center gap-1 text-[10px] text-amber-400 hover:text-amber-300 px-1.5 py-0.5 rounded hover:bg-zinc-800"
              >
                <FolderOpen className="w-3 h-3" />
                View in Gallery
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
