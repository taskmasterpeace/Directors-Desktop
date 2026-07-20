import { useEffect, useRef } from 'react'
import type { MarkerColor, TimelineClip, TimelineMarker, Track } from '../../types/project'

/**
 * Agent action applier — the renderer half of the agent bridge.
 *
 * Polls the backend's action queue (1s while the editor is mounted), validates
 * each bounded action against live editor state, applies the batch through ONE
 * undo step, and reports per-action applied/rejected(reason) back. The
 * renderer stays the source of truth: nothing here writes state the user
 * couldn't have produced with the mouse, and Ctrl+Z reverts a whole batch.
 */

type ActionRecord = Record<string, unknown>

interface PendingAction {
  id: string
  action: ActionRecord
}

interface ActionResult {
  id: string
  status: 'applied' | 'rejected'
  reason?: string
}

const MARKER_COLOR_VALUES: MarkerColor[] = ['amber', 'red', 'green', 'blue', 'zinc']

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export function useAgentActions({
  clips,
  tracks,
  markers,
  setClips,
  setMarkers,
  pushUndo,
  makeCaptions,
}: {
  clips: TimelineClip[]
  tracks: Track[]
  markers: TimelineMarker[]
  setClips: React.Dispatch<React.SetStateAction<TimelineClip[]>>
  setMarkers: React.Dispatch<React.SetStateAction<TimelineMarker[]>>
  pushUndo: () => void
  /** Phase 4 captions engine; returns false when the clip has no transcript words. */
  makeCaptions: (clip: TimelineClip) => boolean
}) {
  // Fresh-closure ref: the 1s interval calls whatever the latest render bound.
  const applyRef = useRef<(pending: PendingAction[]) => ActionResult[]>(() => [])

  applyRef.current = (pending: PendingAction[]): ActionResult[] => {
    const results: ActionResult[] = []
    let nextClips = clips
    let nextMarkers = markers
    let clipsMutated = false
    let markersMutated = false
    const captionRuns: { actionId: string; clip: TimelineClip }[] = []

    for (const { id, action } of pending) {
      const kind = str(action.kind)
      const reject = (reason: string) => results.push({ id, status: 'rejected', reason })
      const applied = () => results.push({ id, status: 'applied' })

      switch (kind) {
        case 'move_clip': {
          const clipId = str(action.clipId)
          const trackIndex = num(action.trackIndex)
          const startTime = num(action.startTime)
          const clip = nextClips.find((c) => c.id === clipId)
          if (!clip) { reject(`unknown clipId: ${clipId}`); break }
          if (trackIndex === undefined || trackIndex < 0 || trackIndex >= tracks.length) {
            reject(`trackIndex out of range: ${action.trackIndex}`); break
          }
          if (tracks[trackIndex].type === 'subtitle') { reject('cannot move a clip onto a subtitle track'); break }
          if (startTime === undefined || startTime < 0) { reject(`invalid startTime: ${action.startTime}`); break }
          nextClips = nextClips.map((c) => (c.id === clipId ? { ...c, trackIndex, startTime } : c))
          clipsMutated = true
          applied()
          break
        }
        case 'trim_clip': {
          const clipId = str(action.clipId)
          const clip = nextClips.find((c) => c.id === clipId)
          if (!clip) { reject(`unknown clipId: ${clipId}`); break }
          const speed = clip.speed || 1
          const oldEnd = clip.trimStart + clip.duration * speed
          const trimStart = num(action.trimStart) ?? clip.trimStart
          const trimEnd = num(action.trimEnd) ?? oldEnd
          if (trimStart < 0 || trimEnd <= trimStart) {
            reject(`invalid trim window: [${trimStart}, ${trimEnd}]`); break
          }
          nextClips = nextClips.map((c) =>
            c.id === clipId ? { ...c, trimStart, duration: (trimEnd - trimStart) / speed } : c,
          )
          clipsMutated = true
          applied()
          break
        }
        case 'delete_clip': {
          const clipId = str(action.clipId)
          if (!nextClips.some((c) => c.id === clipId)) { reject(`unknown clipId: ${clipId}`); break }
          nextClips = nextClips.filter((c) => c.id !== clipId)
          clipsMutated = true
          applied()
          break
        }
        case 'add_marker': {
          const marker = (action.marker ?? {}) as ActionRecord
          const time = num(marker.time)
          const title = str(marker.title)
          if (time === undefined || time < 0) { reject(`invalid marker time: ${marker.time}`); break }
          if (!title) { reject('marker title is required'); break }
          const color = MARKER_COLOR_VALUES.includes(marker.color as MarkerColor)
            ? (marker.color as MarkerColor)
            : 'amber'
          const duration = num(marker.duration)
          const created: TimelineMarker = {
            id: `marker-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            time,
            ...(duration !== undefined && duration > 0 ? { duration } : {}),
            title,
            ...(str(marker.note) ? { note: str(marker.note) } : {}),
            color,
            author: 'agent',
            createdAt: Date.now(),
          }
          nextMarkers = [...nextMarkers, created]
          markersMutated = true
          applied()
          break
        }
        case 'update_marker': {
          const markerId = str(action.markerId)
          const target = nextMarkers.find((m) => m.id === markerId)
          if (!target) { reject(`unknown markerId: ${markerId}`); break }
          const patch = (action.patch ?? {}) as ActionRecord
          const updated: TimelineMarker = {
            ...target,
            ...(num(patch.time) !== undefined ? { time: num(patch.time)! } : {}),
            ...(num(patch.duration) !== undefined ? { duration: num(patch.duration) } : {}),
            ...(str(patch.title) ? { title: str(patch.title)! } : {}),
            ...(str(patch.note) !== undefined ? { note: str(patch.note) } : {}),
            ...(MARKER_COLOR_VALUES.includes(patch.color as MarkerColor)
              ? { color: patch.color as MarkerColor }
              : {}),
          }
          nextMarkers = nextMarkers.map((m) => (m.id === markerId ? updated : m))
          markersMutated = true
          applied()
          break
        }
        case 'delete_marker': {
          const markerId = str(action.markerId)
          if (!nextMarkers.some((m) => m.id === markerId)) { reject(`unknown markerId: ${markerId}`); break }
          nextMarkers = nextMarkers.filter((m) => m.id !== markerId)
          markersMutated = true
          applied()
          break
        }
        case 'captions_from_transcript': {
          const clipId = str(action.clipId)
          if (clipId) {
            const clip = nextClips.find((c) => c.id === clipId)
            if (!clip) { reject(`unknown clipId: ${clipId}`); break }
            captionRuns.push({ actionId: id, clip })
            applied()
          } else {
            // No clip named: caption the whole cut in timeline order.
            const ordered = [...nextClips].sort((a, b) => a.startTime - b.startTime)
            if (ordered.length === 0) { reject('timeline has no clips'); break }
            captionRuns.push(...ordered.map((clip) => ({ actionId: id, clip })))
            applied()
          }
          break
        }
        case 'generate_and_place':
          reject('generate_and_place is not available yet (Phase 7)')
          break
        default:
          reject(`unknown action kind: ${String(action.kind)}`)
      }
    }

    const willMutate = clipsMutated || markersMutated || captionRuns.length > 0
    if (willMutate) {
      pushUndo() // one snapshot — the whole agent batch is a single Ctrl+Z
      if (clipsMutated) setClips(nextClips)
      if (markersMutated) setMarkers(nextMarkers)
      // A captions action succeeds if ANY of its clips yielded cues (a cut can
      // legitimately contain clips with no speech).
      const captionOutcomes = new Map<string, boolean>()
      for (const { actionId, clip } of captionRuns) {
        const ok = makeCaptions(clip)
        captionOutcomes.set(actionId, (captionOutcomes.get(actionId) ?? false) || ok)
      }
      for (const [actionId, anySucceeded] of captionOutcomes) {
        if (anySucceeded) continue
        const entry = results.find((r) => r.id === actionId)
        if (entry) {
          entry.status = 'rejected'
          entry.reason = 'no transcript words in the targeted clip(s)'
        }
      }
    }
    return results
  }

  useEffect(() => {
    let cancelled = false
    let inFlight = false
    const tick = async () => {
      if (cancelled || inFlight) return
      inFlight = true
      try {
        const base = await window.electronAPI.getBackendUrl()
        const res = await fetch(`${base}/api/project/actions/pending`)
        if (!res.ok || cancelled) return
        const data = (await res.json()) as { actions?: PendingAction[] }
        const pending = data.actions ?? []
        if (pending.length === 0) return
        const results = applyRef.current(pending)
        await fetch(`${base}/api/project/actions/report`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ results }),
        })
      } catch {
        /* backend down or mid-restart — next tick retries */
      } finally {
        inFlight = false
      }
    }
    const interval = setInterval(tick, 1000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])
}
