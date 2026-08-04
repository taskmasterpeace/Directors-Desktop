import { useEffect, useState } from 'react'
import { Clock, Loader2, ListVideo } from 'lucide-react'
import { getEstimatedSeconds } from '../hooks/use-generation'

interface QueueJobLike {
  id: string
  type: string
  model: string
  params: Record<string, unknown>
  status: string
  progress: number
  phase: string
  created_at: string
}

const MODEL_NAMES: Record<string, string> = {
  'ltx-fast': 'LTX Fast',
  'ltx-pro': 'LTX Pro',
  fast: 'LTX Fast',
  pro: 'LTX Pro',
  'seedance-1.5-pro': 'Seedance 1.5',
  'seedance-2.0': 'Seedance 2.0',
  'seedance-2.0-fast': 'Seedance 2.0 Fast',
  'minimax-h3': 'MiniMax H3',
}

function fmt(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Per-job queue timers, Directors Palette style: every queued/running video job
 * shows its spec, live elapsed time and a countdown against the model estimate.
 * The active job's big timer lives in VideoPlayer; this strip covers the QUEUE
 * so a stack of submitted shots is legible at a glance.
 */
export function QueueTimers({ jobs }: { jobs: QueueJobLike[] }) {
  // Tick once a second so elapsed/remaining stay live between poll updates.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const visible = jobs.filter(
    j => (j.type === 'video' || j.type === 'long_video') && (j.status === 'queued' || j.status === 'running'),
  )
  if (visible.length === 0) return null

  const now = Date.now()

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-zinc-400">
        <ListVideo className="w-3.5 h-3.5" />
        Queue · {visible.length}
      </div>
      {visible.map(job => {
        const est = getEstimatedSeconds(job as never)
        const startedMs = Date.parse(job.created_at)
        const elapsed = Number.isFinite(startedMs) ? (now - startedMs) / 1000 : 0
        const remaining = est != null ? est - elapsed : null
        const res = String(job.params.resolution ?? '')
        const dur = String(job.params.duration ?? '')
        const running = job.status === 'running'
        return (
          <div key={job.id} className="flex items-center gap-2.5 text-xs">
            {running
              ? <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin shrink-0" />
              : <Clock className="w-3.5 h-3.5 text-zinc-500 shrink-0" />}
            <span className="text-zinc-200 font-medium truncate">
              {MODEL_NAMES[job.model] ?? job.model}
            </span>
            <span className="text-zinc-500 shrink-0">{res} · {dur}s</span>
            {running && (
              <span className="text-zinc-500 shrink-0">{job.phase} {job.progress > 0 ? `${job.progress}%` : ''}</span>
            )}
            <span className="ml-auto tabular-nums text-zinc-400 shrink-0">
              {fmt(elapsed)}
              {remaining != null && (
                <span className={remaining > 0 ? 'text-zinc-500' : 'text-amber-400'}>
                  {remaining > 0 ? ` · ~${fmt(remaining)} left` : ' · finishing…'}
                </span>
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}
