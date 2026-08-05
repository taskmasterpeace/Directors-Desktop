import { useMemo, useState } from 'react'
import { Flame, Snowflake, Loader2, ChevronDown } from 'lucide-react'
import {
  MODEL_LOAD_SECONDS,
  formatDuration,
  type ModelWarmth,
} from '../lib/generation-cost'

interface GpuInfo {
  name: string
  vram: number
  vramUsed: number
}

interface ModelWarmthPillProps {
  warmth: ModelWarmth
  activeModel: string | null
  gpuInfo: GpuInfo | null
  /** Estimated render seconds for the CURRENT spec, so "hot" can quote a real next-shot cost. */
  nextShotSeconds?: number
  /** Local ComfyUI engine (H3 / LTX): DD doesn't track ComfyUI's VRAM residency, so
   *  show an honest "local · GPU" state instead of a misleading cold/hot warmth. */
  localEngine?: boolean
  className?: string
}

/**
 * Residency indicator for the local video model.
 *
 * Loading costs ~9 minutes and only one model fits in 24GB, so without this the
 * user cannot tell whether the next click takes 3 minutes or 12. Deliberately
 * separate from ModelStatusDropdown, which reports DOWNLOAD state (disk) — this
 * reports RESIDENCY (VRAM). A model can be fully downloaded and still cold.
 */
export function ModelWarmthPill({
  warmth,
  activeModel,
  gpuInfo,
  nextShotSeconds,
  localEngine = false,
  className = '',
}: ModelWarmthPillProps) {
  const [open, setOpen] = useState(false)

  const tone = useMemo(() => {
    // Local ComfyUI engines run outside DD's own pipeline, so warmth is unknown —
    // present an honest neutral "local" state rather than a misleading cold/hot.
    if (localEngine) {
      return { dot: 'bg-emerald-500', text: 'text-emerald-400', label: 'local' }
    }
    switch (warmth) {
      case 'warm':
        // Semantic green — kept distinct from the app's amber accent so state
        // reads at a glance rather than blending into brand colour.
        return { dot: 'bg-emerald-500', text: 'text-emerald-400', label: 'hot' }
      case 'warming':
        return { dot: 'bg-amber-400', text: 'text-amber-300', label: 'loading' }
      default:
        return { dot: 'bg-zinc-500', text: 'text-zinc-400', label: 'cold' }
    }
  }, [warmth, localEngine])

  const detail = useMemo(() => {
    if (localEngine) return 'runs on your GPU'
    if (warmth === 'warm') {
      return nextShotSeconds && nextShotSeconds > 0
        ? `next shot ${formatDuration(nextShotSeconds)}`
        : 'ready'
    }
    if (warmth === 'warming') return 'loading into VRAM'
    return `~${formatDuration(MODEL_LOAD_SECONDS)} to first shot`
  }, [warmth, nextShotSeconds, localEngine])

  const usedGb = gpuInfo ? gpuInfo.vramUsed / 1024 : 0
  const totalGb = gpuInfo ? gpuInfo.vram / 1024 : 0
  const usedPct = totalGb > 0 ? Math.min(100, (usedGb / totalGb) * 100) : 0

  const Icon = warmth === 'warm' ? Flame : warmth === 'warming' ? Loader2 : Snowflake

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        title={`Video model is ${tone.label} — ${detail}`}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-zinc-800/80 border border-zinc-700/50 hover:border-zinc-600 transition-colors"
      >
        <span className={`w-2 h-2 rounded-full ${tone.dot} ${warmth === 'warming' ? 'animate-pulse' : ''}`} />
        <span className="text-xs text-zinc-300 font-medium">
          {activeModel ? activeModel : 'No model'}
        </span>
        <span className={`text-xs ${tone.text}`}>{tone.label}</span>
        <ChevronDown className={`w-3 h-3 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-72 z-50 rounded-lg bg-zinc-900 border border-zinc-700 shadow-xl p-3 space-y-3">
          <div className="flex items-center gap-2">
            <Icon className={`w-4 h-4 ${tone.text} ${warmth === 'warming' ? 'animate-spin' : ''}`} />
            <div className="min-w-0">
              <div className="text-sm text-zinc-100 font-medium truncate">
                {activeModel ?? 'No model loaded'}
              </div>
              <div className="text-xs text-zinc-400">{detail}</div>
            </div>
          </div>

          {gpuInfo && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span>GPU memory</span>
                <span className="tabular-nums text-zinc-300">
                  {usedGb.toFixed(1)} / {totalGb.toFixed(0)} GB
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className={`h-full rounded-full ${usedPct > 92 ? 'bg-red-500' : 'bg-amber-500'}`}
                  style={{ width: `${usedPct}%` }}
                />
              </div>
            </div>
          )}

          <p className="text-xs text-zinc-500 leading-relaxed">
            Only one video model fits in VRAM at a time — loading another unloads this one.
            Changing resolution, duration or prompt is free.
          </p>
        </div>
      )}
    </div>
  )
}
