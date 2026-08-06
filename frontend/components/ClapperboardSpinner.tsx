import { useEffect, useRef, useState } from 'react'
import { getModelAvgSeconds } from '../lib/model-timing'

interface ClapperboardSpinnerProps {
  /** Total estimated seconds for THIS generation (cold-load included by the caller). */
  estimatedSeconds: number
  /** Epoch ms when generation started — survives remounts so progress doesn't reset on navigation. */
  startedAt?: number
  /** Display name shown under the board (model / engine). */
  displayName: string
  /** Timing-memory key — the model id completions were recorded under. */
  model?: string
  /** Which timing bucket applies to THIS render (cold pays the model load). */
  cold?: boolean
  /** Prompt preview under the board. */
  prompt?: string
  /** Backend phase text ("loading model", "inference"…) shown as the status line. */
  statusMessage?: string
  /** Extra note (e.g. "first render loads the model"). */
  note?: string
}

function formatAvg(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return s === 0 ? `${m}m` : `${m}m ${s.toString().padStart(2, '0')}s`
}

/**
 * The Directors Palette clapperboard, ported for Desktop — the same board,
 * animated clapper, progress bar, countdown, and personal-average ▾ marker,
 * replacing the generic spinning-arrows placeholder on every gen surface.
 *
 * Personal-average marker: `lib/model-timing.ts` records the user's own
 * completion times per model; after at least one completion a small ▾ tick
 * marks "you usually finish here" on the bar.
 */
export function ClapperboardSpinner({
  estimatedSeconds,
  startedAt,
  displayName,
  model,
  cold = false,
  prompt,
  statusMessage,
  note,
}: ClapperboardSpinnerProps) {
  const safeEstimate = Number.isFinite(estimatedSeconds) && estimatedSeconds > 0 ? estimatedSeconds : 60

  // Personal per-model rolling average (matching warm/cold bucket) — read once
  // per mount; completions recorded elsewhere (use-generation) between mounts.
  const personalAvgSecRef = useRef<number | null>(model ? getModelAvgSeconds(model, cold) : null)
  const personalAvgSec = personalAvgSecRef.current

  // Use the passed-in start time so progress survives remounts.
  const origin = startedAt ?? Date.now()
  const originRef = useRef(origin)

  const [elapsed, setElapsed] = useState(() => (Date.now() - originRef.current) / 1000)

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed((Date.now() - originRef.current) / 1000)
    }, 500)
    return () => clearInterval(interval)
  }, [])

  const progress = elapsed / safeEstimate
  const overtime = progress > 1
  const clamped = Math.min(1, progress)
  const remaining = Math.max(0, safeEstimate - elapsed)
  const overBy = Math.max(0, elapsed - safeEstimate)
  const pct = Math.round(clamped * 100)

  const markerFrac = personalAvgSec !== null ? Math.min(1, personalAvgSec / safeEstimate) : null
  const passedMarker = personalAvgSec !== null && elapsed >= personalAvgSec

  let timeColorState: 'normal' | 'approaching' | 'over'
  if (overtime) timeColorState = 'over'
  else if (personalAvgSec !== null && elapsed >= personalAvgSec) timeColorState = 'approaching'
  else timeColorState = 'normal'

  let timeText: string
  if (overtime) {
    const oMin = Math.floor(overBy / 60)
    const oSec = Math.floor(overBy % 60)
    timeText = `+${oMin}:${oSec.toString().padStart(2, '0')} over`
  } else {
    const rMin = Math.floor(remaining / 60)
    const rSec = Math.floor(remaining % 60)
    timeText = `${rMin}:${rSec.toString().padStart(2, '0')}`
  }

  const overtimeMessages = ['Still working...', 'Almost there...', 'Hang tight...', 'Processing...']
  const overtimeMsg = overtimeMessages[Math.floor(Date.now() / 2500) % overtimeMessages.length]

  // Electric Amber theme — the same values as Palette's clapperboard, so the
  // two apps read as siblings.
  const primary = 'oklch(0.75 0.16 75)'
  const accent = 'oklch(0.65 0.12 195)'
  const amber = 'oklch(0.78 0.18 60)'
  const bg = 'oklch(0.12 0.015 250)'
  const surface = 'oklch(0.20 0.015 250)'
  const trackLight = 'oklch(0.30 0.025 250)'
  const text = 'oklch(0.93 0.01 80)'
  const textMuted = 'oklch(0.60 0.02 80)'
  const strokeColor = overtime ? accent : primary

  const timeColor =
    timeColorState === 'over' ? accent : timeColorState === 'approaching' ? amber : text
  const barFillColor =
    timeColorState === 'over' ? accent : timeColorState === 'approaching' ? amber : primary
  const markerX = markerFrac !== null ? 16 + 68 * markerFrac : null

  return (
    <div className="flex flex-col items-center gap-2 px-3">
      <svg width="100" height="90" viewBox="0 0 100 92" className="drop-shadow-lg">
        {/* Board body */}
        <rect x="10" y="35" width="80" height="52" rx="3"
          fill={surface} stroke={strokeColor} strokeWidth="2" />

        {/* Progress bar inside board */}
        <rect x="16" y="76" width="68" height="5" rx="2.5" fill={trackLight} />
        <rect x="16" y="76" width={68 * clamped} height="5" rx="2.5" fill={barFillColor} />

        {/* Personal-average ▾ marker */}
        {markerX !== null && (
          <g className={passedMarker ? 'animate-pulse' : undefined}>
            <polygon
              points={`${markerX - 3.5},71 ${markerX + 3.5},71 ${markerX},75`}
              fill={amber}
              stroke={bg}
              strokeWidth="0.5"
            >
              <title>Your average: {Math.round(personalAvgSec ?? 0)}s</title>
            </polygon>
            <line x1={markerX} y1="74" x2={markerX} y2="82"
              stroke={bg} strokeWidth="1.5" opacity="0.85" />
          </g>
        )}

        {/* Percentage */}
        <text x="50" y="58" textAnchor="middle" fill={text}
          fontSize="16" fontWeight="700" fontFamily="system-ui">
          {pct}%
        </text>

        {overtime && (
          <text x="50" y="70" textAnchor="middle" fill={accent}
            fontSize="8" fontFamily="system-ui">
            {overtimeMsg}
          </text>
        )}

        {/* Clapper top — a real animation loop (SMIL), not progress-scaled:
            the original tied the clap to progress, which on a 6-minute video
            estimate crept invisibly. Now it claps twice then rests, every few
            seconds; overtime remounts it into a frantic fast cycle. */}
        <g key={overtime ? 'clap-fast' : 'clap-slow'}>
          <animateTransform
            attributeName="transform"
            type="rotate"
            values="0 10 35; -30 10 35; -4 10 35; -26 10 35; 0 10 35; 0 10 35"
            keyTimes="0; 0.08; 0.14; 0.2; 0.28; 1"
            dur={overtime ? '1.4s' : '4.5s'}
            repeatCount="indefinite"
          />
          <rect x="10" y="20" width="80" height="16" rx="2"
            fill={trackLight} stroke={strokeColor} strokeWidth="1.5" />
          {[0, 1, 2, 3, 4].map(i => (
            <rect key={i} x={14 + i * 16} y="20" width="8" height="16"
              fill={i % 2 === 0 ? bg : trackLight} rx="1" />
          ))}
        </g>
      </svg>

      {/* Countdown */}
      <span
        className="text-xs font-bold tabular-nums transition-colors duration-300"
        style={{ color: timeColor }}
      >
        {timeText}
      </span>

      {/* Model name + the user's own measured average for this model/bucket */}
      <span className="text-[10px] font-medium" style={{ color: primary }}>
        {displayName}
        {personalAvgSec !== null && (
          <span style={{ color: textMuted }}>
            {' '}· your avg {formatAvg(personalAvgSec)}{cold ? ' (cold)' : ''}
          </span>
        )}
      </span>

      {/* Backend phase / status line */}
      {statusMessage && (
        <span className="text-[10px]" style={{ color: textMuted }}>
          {statusMessage}
        </span>
      )}

      {/* Cold-load or other honesty note */}
      {note && (
        <span className="text-[10px] text-center max-w-[200px]" style={{ color: amber }}>
          {note}
        </span>
      )}

      {/* Prompt preview */}
      {prompt && (
        <p
          className="text-[10px] text-center line-clamp-2 max-w-[180px] leading-tight"
          style={{ color: textMuted }}
        >
          {prompt.length > 70 ? prompt.slice(0, 70) + '...' : prompt}
        </p>
      )}
    </div>
  )
}
