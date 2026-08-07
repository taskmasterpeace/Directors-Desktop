import { useEffect, useRef } from 'react'
import { generateFromPrompt } from '../../lib/transcript-generate'
import type { MarkerColor, TimelineClip, TimelineMarker, Track } from '../../types/project'

/**
 * Agent action applier — the renderer half of the agent bridge.
 *
 * Polls the backend's action queue (1s while the editor is mounted), validates
 * each bounded action against live editor state, applies the batch through ONE
 * undo step, and reports per-action applied/rejected(reason) back.
 *
 * Commit discipline: validation runs against this render's state, but commits
 * are FUNCTIONAL, id-targeted operations replayed onto whatever React holds at
 * flush time — so a user edit landing in the same second is never clobbered by
 * a stale wholesale array replacement. Linked A/V clips move and delete
 * together, matching what the mouse would do.
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

type ClipOp = (clips: TimelineClip[]) => TimelineClip[]
type MarkerOp = (markers: TimelineMarker[]) => TimelineMarker[]

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
  pushTrackUndo,
  makeCaptions,
  getAssetDuration,
  imageModel,
  placeGenerated,
  regenerateWithReference,
}: {
  clips: TimelineClip[]
  tracks: Track[]
  markers: TimelineMarker[]
  setClips: React.Dispatch<React.SetStateAction<TimelineClip[]>>
  setMarkers: React.Dispatch<React.SetStateAction<TimelineMarker[]>>
  pushUndo: () => void
  /** Full tracks+clips+subtitles+markers snapshot — used when a batch touches captions. */
  pushTrackUndo: () => void
  /** Phase 4 captions engine (batch form — at most ONE subtitle track is created). */
  makeCaptions: (targets: TimelineClip[]) => boolean
  /** Source-media length for a clip's asset, when known (clamps trims). */
  getAssetDuration: (clip: TimelineClip) => number | undefined
  /** Default image model id for the image stage of generate chains. */
  imageModel: string
  /** Import a finished generation into the project and drop a clip at `at`. */
  placeGenerated: (
    result: { imagePath: string; videoPath?: string },
    at: { trackIndex: number; startTime: number },
    prompt: string,
  ) => Promise<boolean>
  /** Re-render an EXISTING clip with image/video references; lands as a new take.
   *  References may be literal file paths OR built from other timeline clips
   *  (a frame, a crop, a clip window). Resolves when the take is on the clip. */
  regenerateWithReference: (
    clipId: string,
    opts: {
      note?: string
      referenceImagePaths?: string[]
      videoReferencePaths?: string[]
      referenceFromClips?: { clipId: string; atSeconds?: number; cropRect?: { x: number; y: number; w: number; h: number }; as?: 'image' | 'video' }[]
    },
  ) => Promise<{ ok: boolean; reason?: string }>
}) {
  // Fresh-closure ref: the 1s interval calls whatever the latest render bound.
  const applyRef = useRef<(pending: PendingAction[]) => ActionResult[]>(() => [])
  const placeGeneratedRef = useRef(placeGenerated)
  placeGeneratedRef.current = placeGenerated
  const regenerateWithReferenceRef = useRef(regenerateWithReference)
  regenerateWithReferenceRef.current = regenerateWithReference
  const imageModelRef = useRef(imageModel)
  imageModelRef.current = imageModel
  // False once the editor unmounts: a generation finishing after that must
  // NOT claim 'applied' — its state setters would be silent no-ops.
  const mountedRef = useRef(true)

  const reportResults = async (results: ActionResult[]) => {
    if (results.length === 0) return
    try {
      const base = await window.electronAPI.getBackendUrl()
      await fetch(`${base}/api/project/actions/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ results }),
      })
    } catch {
      /* bridge unreachable — agent will still see the action as delivered */
    }
  }
  const reportRef = useRef(reportResults)
  reportRef.current = reportResults

  /** Long-running: generate through the queue, then import + place. Reports its own result late. */
  const runGenerateAndPlace = (id: string, action: ActionRecord) => {
    const prompt = str(action.prompt) ?? ''
    const at = (action.at ?? {}) as ActionRecord
    const trackIndex = num(at.trackIndex) ?? 0
    const startTime = num(at.startTime) ?? 0
    const mediaType = str(action.mediaType) === 'image' ? 'image' as const : 'video' as const
    const model = str(action.model)
    const refs = Array.isArray(action.referenceImagePaths)
      ? (action.referenceImagePaths as unknown[]).filter((r): r is string => typeof r === 'string')
      : undefined
    void (async () => {
      try {
        const result = await generateFromPrompt({
          prompt,
          mediaType,
          imageModel: mediaType === 'image' && model ? model : imageModelRef.current,
          videoModel: mediaType === 'video' && model ? model : 'seedance-2.0',
          referenceImagePaths: refs,
        })
        if (!mountedRef.current) {
          await reportRef.current([
            { id, status: 'rejected', reason: 'editor closed during generation — the render is saved in the Gallery' },
          ])
          return
        }
        const placed = await placeGeneratedRef.current(result, { trackIndex, startTime }, prompt)
        await reportRef.current([
          placed
            ? { id, status: 'applied' }
            : { id, status: 'rejected', reason: 'generated, but placing the clip failed' },
        ])
      } catch (e) {
        await reportRef.current([
          { id, status: 'rejected', reason: `generation failed: ${e instanceof Error ? e.message : 'error'}` },
        ])
      }
    })()
  }

  /** Long-running: re-render an existing clip with references; lands as a new
   *  take on that clip. Reports its own result late (after the take is on it). */
  const runRegenerateWithReference = (id: string, action: ActionRecord) => {
    const clipId = str(action.clipId)
    if (!clipId) { void reportRef.current([{ id, status: 'rejected', reason: 'clipId is required' }]); return }
    const toStrs = (v: unknown): string[] =>
      Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string') : []
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
    // Parse "build a reference from an existing clip" specs defensively — the
    // renderer does the real work; here we just coerce the shape.
    const toFromClips = (v: unknown) =>
      Array.isArray(v)
        ? (v as unknown[]).flatMap((raw) => {
            if (typeof raw !== 'object' || raw === null) return []
            const o = raw as Record<string, unknown>
            const clipId = str(o.clipId)
            if (!clipId) return []
            const cr = (typeof o.cropRect === 'object' && o.cropRect !== null) ? (o.cropRect as Record<string, unknown>) : null
            const cropRect = cr && [cr.x, cr.y, cr.w, cr.h].every((n) => typeof n === 'number')
              ? { x: cr.x as number, y: cr.y as number, w: cr.w as number, h: cr.h as number }
              : undefined
            return [{
              clipId,
              ...(num(o.atSeconds) !== undefined ? { atSeconds: num(o.atSeconds) } : {}),
              ...(cropRect ? { cropRect } : {}),
              ...(o.as === 'video' ? { as: 'video' as const } : o.as === 'image' ? { as: 'image' as const } : {}),
            }]
          })
        : []
    const opts = {
      note: str(action.note),
      referenceImagePaths: toStrs(action.referenceImagePaths),
      videoReferencePaths: toStrs(action.videoReferencePaths),
      referenceFromClips: toFromClips(action.referenceFromClips),
    }
    void (async () => {
      try {
        const r = await regenerateWithReferenceRef.current(clipId, opts)
        if (!mountedRef.current) {
          await reportRef.current([{ id, status: 'rejected', reason: 'editor closed during regeneration — the render is saved in the Gallery' }])
          return
        }
        await reportRef.current([
          r.ok ? { id, status: 'applied' } : { id, status: 'rejected', reason: r.reason ?? 'regeneration failed' },
        ])
      } catch (e) {
        await reportRef.current([{ id, status: 'rejected', reason: `regeneration failed: ${e instanceof Error ? e.message : 'error'}` }])
      }
    })()
  }

  applyRef.current = (pending: PendingAction[]): ActionResult[] => {
    const results: ActionResult[] = []
    // Validation view: chained so later actions in the batch see earlier ones.
    let nextClips = clips
    let nextMarkers = markers
    // Commit ops: id-targeted, replayed functionally at flush time.
    const clipOps: ClipOp[] = []
    const markerOps: MarkerOp[] = []
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
          const op: ClipOp = (cs) => {
            const target = cs.find((c) => c.id === clipId)
            if (!target) return cs
            // Linked A/V clips ride along in time (own tracks), like a drag.
            const delta = startTime - target.startTime
            const linked = new Set(target.linkedClipIds ?? [])
            return cs.map((c) =>
              c.id === clipId
                ? { ...c, trackIndex, startTime }
                : linked.has(c.id)
                  ? { ...c, startTime: Math.max(0, c.startTime + delta) }
                  : c,
            )
          }
          clipOps.push(op)
          nextClips = op(nextClips)
          applied()
          break
        }
        case 'trim_clip': {
          // Params are the ABSOLUTE source-media window [trimStart, trimEnd)
          // in seconds — NOT the clip's stored `trimEnd` field (which counts
          // seconds cut off the end). Documented in CLAUDE.md.
          const clipId = str(action.clipId)
          const clip = nextClips.find((c) => c.id === clipId)
          if (!clip) { reject(`unknown clipId: ${clipId}`); break }
          const speed = clip.speed || 1
          const oldEnd = clip.trimStart + clip.duration * speed
          const mediaDuration = getAssetDuration(clip)
          let sourceStart = num(action.trimStart) ?? clip.trimStart
          let sourceEnd = num(action.trimEnd) ?? oldEnd
          if (mediaDuration !== undefined) {
            sourceStart = Math.min(sourceStart, mediaDuration)
            sourceEnd = Math.min(sourceEnd, mediaDuration)
          }
          if (sourceStart < 0 || sourceEnd <= sourceStart) {
            reject(`invalid source window: [${sourceStart}, ${sourceEnd}]`); break
          }
          const op: ClipOp = (cs) =>
            cs.map((c) =>
              c.id === clipId
                ? {
                    ...c,
                    trimStart: sourceStart,
                    duration: (sourceEnd - sourceStart) / speed,
                    // Keep the stored tail-trim field consistent when the
                    // media length is known (it feeds manual trim math).
                    ...(mediaDuration !== undefined
                      ? { trimEnd: Math.max(0, mediaDuration - sourceEnd) }
                      : {}),
                  }
                : c,
            )
          clipOps.push(op)
          nextClips = op(nextClips)
          applied()
          break
        }
        case 'delete_clip': {
          const clipId = str(action.clipId)
          const target = nextClips.find((c) => c.id === clipId)
          if (!target) { reject(`unknown clipId: ${clipId}`); break }
          const op: ClipOp = (cs) => {
            const t = cs.find((c) => c.id === clipId)
            if (!t) return cs
            // The mouse deletes linked A/V together — so does the agent.
            const doomed = new Set([clipId, ...(t.linkedClipIds ?? [])])
            return cs.filter((c) => !doomed.has(c.id))
          }
          clipOps.push(op)
          nextClips = op(nextClips)
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
          const op: MarkerOp = (ms) => [...ms, created]
          markerOps.push(op)
          nextMarkers = op(nextMarkers)
          applied()
          break
        }
        case 'update_marker': {
          const markerId = str(action.markerId)
          const target = nextMarkers.find((m) => m.id === markerId)
          if (!target) { reject(`unknown markerId: ${markerId}`); break }
          const patch = (action.patch ?? {}) as ActionRecord
          const fields: Partial<TimelineMarker> = {
            ...(num(patch.time) !== undefined ? { time: num(patch.time)! } : {}),
            ...(num(patch.duration) !== undefined ? { duration: num(patch.duration) } : {}),
            ...(str(patch.title) ? { title: str(patch.title)! } : {}),
            ...(str(patch.note) !== undefined ? { note: str(patch.note) } : {}),
            ...(MARKER_COLOR_VALUES.includes(patch.color as MarkerColor)
              ? { color: patch.color as MarkerColor }
              : {}),
          }
          const op: MarkerOp = (ms) => ms.map((m) => (m.id === markerId ? { ...m, ...fields } : m))
          markerOps.push(op)
          nextMarkers = op(nextMarkers)
          applied()
          break
        }
        case 'delete_marker': {
          const markerId = str(action.markerId)
          if (!nextMarkers.some((m) => m.id === markerId)) { reject(`unknown markerId: ${markerId}`); break }
          const op: MarkerOp = (ms) => ms.filter((m) => m.id !== markerId)
          markerOps.push(op)
          nextMarkers = op(nextMarkers)
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
        case 'generate_and_place': {
          const prompt = str(action.prompt)
          const at = (action.at ?? {}) as ActionRecord
          const trackIndex = num(at.trackIndex)
          const startTime = num(at.startTime)
          if (!prompt) { reject('prompt is required'); break }
          if (trackIndex === undefined || trackIndex < 0 || trackIndex >= tracks.length) {
            reject(`at.trackIndex out of range: ${at.trackIndex}`); break
          }
          if (tracks[trackIndex].type === 'subtitle') { reject('cannot place onto a subtitle track'); break }
          if (startTime === undefined || startTime < 0) { reject(`invalid at.startTime: ${at.startTime}`); break }
          // Long-running: no immediate result — stays 'delivered' until the
          // generation lands (or fails), then reports on its own.
          runGenerateAndPlace(id, action)
          break
        }
        case 'regenerate_with_reference': {
          const clipId = str(action.clipId)
          if (!clipId) { reject('clipId is required'); break }
          if (!nextClips.some((c) => c.id === clipId)) { reject(`unknown clipId: ${clipId}`); break }
          const hasImg = Array.isArray(action.referenceImagePaths) && (action.referenceImagePaths as unknown[]).length > 0
          const hasVid = Array.isArray(action.videoReferencePaths) && (action.videoReferencePaths as unknown[]).length > 0
          const hasFromClips = Array.isArray(action.referenceFromClips) && (action.referenceFromClips as unknown[]).length > 0
          if (!hasImg && !hasVid && !hasFromClips) { reject('give at least one reference: referenceImagePaths, videoReferencePaths, or referenceFromClips'); break }
          // Long-running: reuses the human recast pipeline; reports late once the
          // new take is on the clip.
          runRegenerateWithReference(id, action)
          break
        }
        default:
          reject(`unknown action kind: ${String(action.kind)}`)
      }
    }

    const willMutate = clipOps.length > 0 || markerOps.length > 0 || captionRuns.length > 0
    if (willMutate) {
      // One snapshot = one Ctrl+Z for the whole batch. Captions can create a
      // subtitle track and shift every trackIndex, so those batches need the
      // full tracks+clips+subtitles+markers snapshot.
      if (captionRuns.length > 0) pushTrackUndo()
      else pushUndo()
      if (clipOps.length > 0) setClips((prev) => clipOps.reduce((acc, op) => op(acc), prev))
      if (markerOps.length > 0) setMarkers((prev) => markerOps.reduce((acc, op) => op(acc), prev))

      // One makeCaptions call PER ACTION (deduped clips): at most one subtitle
      // track is ever created, and an action succeeds if any of its clips
      // yielded cues (a cut can legitimately contain clips with no speech).
      const byAction = new Map<string, TimelineClip[]>()
      for (const { actionId, clip } of captionRuns) {
        const list = byAction.get(actionId) ?? []
        if (!list.some((c) => c.id === clip.id)) list.push(clip)
        byAction.set(actionId, list)
      }
      for (const [actionId, targets] of byAction) {
        const ok = makeCaptions(targets)
        if (!ok) {
          const entry = results.find((r) => r.id === actionId)
          if (entry) {
            entry.status = 'rejected'
            entry.reason = 'no transcript words in the targeted clip(s)'
          }
        }
      }
    }
    return results
  }

  useEffect(() => {
    mountedRef.current = true
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
        if (results.length > 0) {
          await fetch(`${base}/api/project/actions/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ results }),
          })
        }
      } catch {
        /* backend down or mid-restart — next tick retries */
      } finally {
        inFlight = false
      }
    }
    const interval = setInterval(tick, 1000)
    return () => {
      cancelled = true
      mountedRef.current = false
      clearInterval(interval)
    }
  }, [])
}
