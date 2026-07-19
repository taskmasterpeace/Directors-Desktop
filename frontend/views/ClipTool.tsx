import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Scissors,
  FolderOpen,
  Film,
  Play,
  Pause,
  Loader2,
  Check,
  AlertCircle,
  FileVideo,
  Sparkles,
} from 'lucide-react'
import { useProjects } from '@/contexts/ProjectContext'
import { Button } from '@/components/ui/button'
import {
  buildSelection,
  clamp,
  formatClock,
  formatLength,
  maxStart,
  resizeEdge,
  suggestOutputName,
  suggestReferenceName,
  MAX_REFERENCE_LENGTH,
  type ClipSelection,
  type SegmentLength,
} from '@/lib/clip-math'

const SEGMENT_LENGTHS: SegmentLength[] = [15, 30]

// Selections within a frame of the cap still count as ≤15s (drag rounding).
const REFERENCE_EPSILON = 0.05

type DragMode = 'move' | 'start' | 'end'

function pathToFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || p
}

type ExportState =
  | { status: 'idle' }
  | { status: 'exporting' }
  | { status: 'done'; outputPath: string }
  | { status: 'error'; message: string }

type ReferenceState =
  | { status: 'idle' }
  | { status: 'exporting' }
  | { status: 'error'; message: string }

export default function ClipTool() {
  const { goHome, openPlayground, setPendingClipReference } = useProjects()

  const [sourcePath, setSourcePath] = useState<string | null>(null)
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [duration, setDuration] = useState(0)
  const [desiredLength, setDesiredLength] = useState<SegmentLength>(15)
  const [selection, setSelection] = useState<ClipSelection>({ start: 0, end: 0, length: 0 })
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [exportState, setExportState] = useState<ExportState>({ status: 'idle' })
  const [referenceState, setReferenceState] = useState<ReferenceState>({ status: 'idle' })

  const videoRef = useRef<HTMLVideoElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef<DragMode | null>(null)

  // Recompute the selection window whenever the source or the desired length changes.
  useEffect(() => {
    setSelection((prev) => buildSelection(duration, desiredLength, prev.start))
  }, [duration, desiredLength])

  const pickVideo = useCallback(async () => {
    setLoadError(null)
    setExportState({ status: 'idle' })
    setReferenceState({ status: 'idle' })
    const paths = await window.electronAPI.showOpenFileDialog({
      title: 'Choose a video',
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'] }],
      properties: ['openFile'],
    })
    if (!paths || paths.length === 0) return
    const p = paths[0]
    setSourcePath(p)
    setSourceUrl(pathToFileUrl(p))
    setDuration(0)
    setCurrentTime(0)
    setIsPlaying(false)
    setSelection({ start: 0, end: 0, length: 0 })
  }, [])

  // Keep playback confined to the selected window and loop it.
  const onTimeUpdate = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    const t = v.currentTime
    setCurrentTime(t)
    if (selection.length > 0 && t >= selection.end - 0.03) {
      v.currentTime = selection.start
      if (!isPlaying) v.pause()
    }
  }, [selection.start, selection.end, selection.length, isPlaying])

  const onLoadedMetadata = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (!Number.isFinite(v.duration) || v.duration <= 0) {
      setLoadError('Could not read this video’s duration. Try a different file or format.')
      return
    }
    setDuration(v.duration)
  }, [])

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      // Start from the selection start if playhead is outside the window.
      if (v.currentTime < selection.start || v.currentTime >= selection.end) {
        v.currentTime = selection.start
      }
      void v.play()
      setIsPlaying(true)
    } else {
      v.pause()
      setIsPlaying(false)
    }
  }, [selection.start, selection.end])

  // Dragging the selection window along the track.
  const seekPreviewTo = useCallback((start: number) => {
    const v = videoRef.current
    if (v) v.currentTime = start
  }, [])

  const timeFromClientX = useCallback(
    (clientX: number): number | null => {
      const track = trackRef.current
      if (!track || duration <= 0) return null
      const rect = track.getBoundingClientRect()
      return clamp((clientX - rect.left) / rect.width, 0, 1) * duration
    },
    [duration],
  )

  const updateStartFromClientX = useCallback(
    (clientX: number) => {
      const t = timeFromClientX(clientX)
      if (t === null) return
      // Center the window on the cursor, keep the current length, clamp to bounds.
      setSelection((prev) => {
        const len = prev.length || desiredLength
        const next = buildSelection(duration, len, t - len / 2)
        seekPreviewTo(next.start)
        return next
      })
    },
    [duration, desiredLength, timeFromClientX, seekPreviewTo],
  )

  const resizeEdgeFromClientX = useCallback(
    (edge: 'start' | 'end', clientX: number) => {
      const t = timeFromClientX(clientX)
      if (t === null) return
      setSelection((prev) => {
        const next = resizeEdge(prev, duration, edge, t)
        // Preview the edge being adjusted so the cut point is visible.
        seekPreviewTo(edge === 'start' ? next.start : Math.max(next.start, next.end - 0.05))
        return next
      })
    },
    [duration, timeFromClientX, seekPreviewTo],
  )

  const onTrackPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (duration <= 0) return
      draggingRef.current = 'move'
      ;(e.target as Element).setPointerCapture?.(e.pointerId)
      updateStartFromClientX(e.clientX)
    },
    [duration, updateStartFromClientX],
  )

  // Edge handles set their own drag mode and stop the track's move-drag.
  const onHandlePointerDown = useCallback(
    (edge: 'start' | 'end') => (e: React.PointerEvent) => {
      if (duration <= 0) return
      e.stopPropagation()
      draggingRef.current = edge
      ;(e.target as Element).setPointerCapture?.(e.pointerId)
    },
    [duration],
  )

  const onTrackPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const mode = draggingRef.current
      if (!mode) return
      if (mode === 'move') updateStartFromClientX(e.clientX)
      else resizeEdgeFromClientX(mode, e.clientX)
    },
    [updateStartFromClientX, resizeEdgeFromClientX],
  )

  const onTrackPointerUp = useCallback((e: React.PointerEvent) => {
    draggingRef.current = null
    ;(e.target as Element).releasePointerCapture?.(e.pointerId)
  }, [])

  // Arrow keys nudge the window; Alt+arrows resize the end edge.
  const onTrackKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (duration <= 0) return
      const step = e.shiftKey ? 1 : 0.1
      const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
      if (dir === 0) return
      e.preventDefault()
      setSelection((prev) => {
        const next = e.altKey
          ? resizeEdge(prev, duration, 'end', prev.end + dir * step)
          : buildSelection(duration, prev.length || desiredLength, prev.start + dir * step)
        seekPreviewTo(e.altKey ? Math.max(next.start, next.end - 0.05) : next.start)
        return next
      })
    },
    [duration, desiredLength, seekPreviewTo],
  )

  const handleExport = useCallback(async () => {
    if (!sourcePath || selection.length <= 0) return
    setExportState({ status: 'exporting' })
    try {
      const defaultName = suggestOutputName(basename(sourcePath), selection)
      const outputPath = await window.electronAPI.showSaveDialog({
        title: 'Save clip as',
        defaultPath: defaultName,
        filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
      })
      if (!outputPath) {
        setExportState({ status: 'idle' })
        return
      }
      const result = await window.electronAPI.clipTrim({
        inputUrl: sourceUrl!,
        startSeconds: selection.start,
        lengthSeconds: selection.length,
        outputPath,
      })
      if (result.success && result.outputPath) {
        setExportState({ status: 'done', outputPath: result.outputPath })
      } else {
        setExportState({ status: 'error', message: result.error || 'Export failed' })
      }
    } catch (err) {
      setExportState({ status: 'error', message: String(err) })
    }
  }, [sourcePath, sourceUrl, selection])

  // Auto-splice the selection (no save dialog) and hand it to the Playground as
  // a Seedance 2.0 video reference, ready for a "changes I want" prompt.
  const handleUseAsReference = useCallback(async () => {
    if (!sourcePath || !sourceUrl || selection.length <= 0) return
    setReferenceState({ status: 'exporting' })
    try {
      const downloads = await window.electronAPI.getDownloadsPath()
      const dir = `${downloads}/DirectorsDesktop/clips`
      const ensured = await window.electronAPI.ensureDirectory(dir)
      if (!ensured.success) throw new Error(ensured.error || 'Could not create the clips folder')
      const name = suggestReferenceName(basename(sourcePath), selection, Date.now())
      const result = await window.electronAPI.clipTrim({
        inputUrl: sourceUrl,
        startSeconds: selection.start,
        lengthSeconds: selection.length,
        outputPath: `${dir}/${name}`,
      })
      if (!result.success || !result.outputPath) throw new Error(result.error || 'Trim failed')
      setPendingClipReference({ path: result.outputPath, label: name })
      setReferenceState({ status: 'idle' })
      openPlayground()
    } catch (err) {
      setReferenceState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }, [sourcePath, sourceUrl, selection, setPendingClipReference, openPlayground])

  const revealOutput = useCallback((outputPath: string) => {
    void window.electronAPI.showItemInFolder(outputPath)
  }, [])

  const selectionPct = useMemo(() => {
    if (duration <= 0) return { left: 0, width: 0 }
    return {
      left: (selection.start / duration) * 100,
      width: (selection.length / duration) * 100,
    }
  }, [duration, selection])

  const playheadPct = duration > 0 ? (currentTime / duration) * 100 : 0
  const shortSource = duration > 0 && duration < desiredLength
  const withinReferenceCap = selection.length > 0 && selection.length <= MAX_REFERENCE_LENGTH + REFERENCE_EPSILON
  const busy = exportState.status === 'exporting' || referenceState.status === 'exporting'

  return (
    <div className="h-screen bg-background text-white flex flex-col">
      {/* Header */}
      <header className="h-14 border-b border-zinc-800 flex items-center px-4 gap-3 flex-shrink-0">
        <button
          onClick={goHome}
          aria-label="Back to home"
          className="h-8 w-8 flex items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="flex items-center gap-2">
          <Scissors className="h-4 w-4 text-blue-400" />
          <h1 className="text-sm font-semibold tracking-tight">Clip Tool</h1>
        </div>
        <span className="text-xs text-zinc-500">
          Pull a segment out of any video — export it, or send it into generation as a reference
        </span>
      </header>

      {!sourcePath ? (
        /* Empty state */
        <div className="flex-1 flex flex-col items-center justify-center gap-5 px-6">
          <div className="h-20 w-20 rounded-full bg-blue-500/10 flex items-center justify-center">
            <FileVideo className="h-9 w-9 text-blue-400" />
          </div>
          <div className="text-center">
            <h2 className="text-lg font-semibold tracking-tight">Load a video to get started</h2>
            <p className="text-sm text-zinc-400 mt-1 max-w-md">
              Choose any video file (YouTube downloads work great), pick up to 15 seconds, and
              send it straight into generation as a reference — or export it as a clip.
            </p>
          </div>
          <Button onClick={pickVideo} size="lg" className="gap-2">
            <FolderOpen className="h-4 w-4" />
            Choose video
          </Button>
          {loadError && (
            <p className="text-sm text-red-400 flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              {loadError}
            </p>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-6 py-6 flex flex-col gap-5">
            {/* Source name + replace */}
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <Film className="h-4 w-4 text-zinc-500 flex-shrink-0" />
                <span className="text-sm text-zinc-300 truncate">{basename(sourcePath)}</span>
              </div>
              <Button onClick={pickVideo} variant="outline" size="sm" className="gap-2 flex-shrink-0">
                <FolderOpen className="h-3.5 w-3.5" />
                Replace
              </Button>
            </div>

            {/* Video preview */}
            <div className="rounded-lg overflow-hidden border border-zinc-800 bg-black relative">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video
                ref={videoRef}
                src={sourceUrl ?? undefined}
                className="w-full max-h-[46vh] mx-auto bg-black"
                onLoadedMetadata={onLoadedMetadata}
                onTimeUpdate={onTimeUpdate}
                onEnded={() => setIsPlaying(false)}
                onError={() =>
                  setLoadError('This video could not be played. The format may be unsupported.')
                }
                playsInline
              />
              {loadError && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-sm text-red-300 gap-2 px-4 text-center">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  {loadError}
                </div>
              )}
            </div>

            {/* Transport */}
            <div className="flex items-center gap-3">
              <button
                onClick={togglePlay}
                aria-label={isPlaying ? 'Pause preview' : 'Play selected segment'}
                className="h-9 w-9 flex items-center justify-center rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white transition-colors"
              >
                {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              </button>
              <span className="text-xs tabular-nums text-zinc-400">
                {formatClock(currentTime)} <span className="text-zinc-600">/</span>{' '}
                {formatClock(duration)}
              </span>
            </div>

            {/* Selection track */}
            <div className="flex flex-col gap-2">
              <div
                ref={trackRef}
                role="slider"
                tabIndex={0}
                aria-label="Segment position"
                aria-valuemin={0}
                aria-valuemax={Math.round(maxStart(duration, desiredLength))}
                aria-valuenow={Math.round(selection.start)}
                aria-valuetext={`Starts at ${formatClock(selection.start)}, ${formatLength(selection.length)} long`}
                onPointerDown={onTrackPointerDown}
                onPointerMove={onTrackPointerMove}
                onPointerUp={onTrackPointerUp}
                onKeyDown={onTrackKeyDown}
                className="relative h-12 rounded-lg bg-zinc-800/70 cursor-pointer select-none outline-none focus-visible:ring-1 focus-visible:ring-blue-500 touch-none"
              >
                {/* Selected window with resizable edges */}
                <div
                  className="absolute top-0 bottom-0 rounded-lg bg-blue-500/25 border border-blue-500"
                  style={{ left: `${selectionPct.left}%`, width: `${selectionPct.width}%` }}
                >
                  <div
                    onPointerDown={onHandlePointerDown('start')}
                    className="absolute -left-1.5 top-0 bottom-0 w-3 cursor-ew-resize"
                    title="Drag to move the start of the clip"
                  >
                    <div className="absolute inset-y-2 left-1 w-1 rounded-full bg-blue-400" />
                  </div>
                  <div
                    onPointerDown={onHandlePointerDown('end')}
                    className="absolute -right-1.5 top-0 bottom-0 w-3 cursor-ew-resize"
                    title="Drag to move the end of the clip"
                  >
                    <div className="absolute inset-y-2 right-1 w-1 rounded-full bg-blue-400" />
                  </div>
                </div>
                {/* Playhead */}
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-white/90 pointer-events-none"
                  style={{ left: `${playheadPct}%` }}
                />
              </div>
              <div className="flex justify-between text-[11px] text-zinc-500">
                <span>Starts {formatClock(selection.start)}</span>
                <span className={withinReferenceCap ? 'text-blue-400' : 'text-amber-400'}>
                  Length {formatLength(selection.length)}
                </span>
                <span>Ends {formatClock(selection.end)}</span>
              </div>
              <p className="text-[11px] text-zinc-600">
                Drag the bar to position the segment, or drag its edges to resize. Arrow keys nudge
                (Shift = 1s steps, Alt = adjust the end).
              </p>
            </div>

            {/* Length presets — snap the selection; edges allow any length in between */}
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium text-zinc-400">Clip length</span>
              <div className="flex gap-2">
                {SEGMENT_LENGTHS.map((len) => {
                  const active = Math.abs(selection.length - len) < 0.05
                  return (
                    <button
                      key={len}
                      onClick={() => {
                        setDesiredLength(len)
                        setSelection((prev) => buildSelection(duration, len, prev.start))
                      }}
                      aria-pressed={active}
                      className={`px-4 h-9 rounded-lg text-sm font-medium transition-colors border ${
                        active
                          ? 'bg-blue-500 border-blue-500 text-white'
                          : 'bg-zinc-800/70 border-zinc-700 text-zinc-300 hover:bg-zinc-800'
                      }`}
                    >
                      {len}s
                    </button>
                  )
                })}
              </div>
              {shortSource && (
                <p className="text-[11px] text-amber-400 flex items-center gap-1.5">
                  <AlertCircle className="h-3.5 w-3.5" />
                  This video is only {formatClock(duration)} long — the clip will be the whole video.
                </p>
              )}
            </div>

            {/* Actions */}
            <div className="border-t border-zinc-800 pt-5 flex flex-col gap-3">
              <div className="flex items-center gap-3 flex-wrap">
                <Button
                  onClick={() => void handleUseAsReference()}
                  disabled={selection.length <= 0 || !withinReferenceCap || busy}
                  className="gap-2"
                  title="Splice this selection and attach it to a new generation as a video reference"
                >
                  {referenceState.status === 'exporting' ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Splicing clip…
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-4 w-4" />
                      Use as reference
                    </>
                  )}
                </Button>
                <Button
                  onClick={handleExport}
                  variant="outline"
                  disabled={selection.length <= 0 || busy}
                  className="gap-2"
                >
                  {exportState.status === 'exporting' ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Exporting clip…
                    </>
                  ) : (
                    <>
                      <Scissors className="h-4 w-4" />
                      Export {formatLength(selection.length)} clip
                    </>
                  )}
                </Button>
                {exportState.status === 'done' && (
                  <button
                    onClick={() => revealOutput(exportState.outputPath)}
                    className="text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1.5 transition-colors"
                  >
                    <Check className="h-4 w-4" />
                    Saved — show in folder
                  </button>
                )}
              </div>
              {!withinReferenceCap && selection.length > 0 && (
                <p className="text-[11px] text-amber-400 flex items-center gap-1.5">
                  <AlertCircle className="h-3.5 w-3.5" />
                  References are capped at 15s — drag an edge to tighten the selection, or export
                  instead.
                </p>
              )}
              <p className="text-[11px] text-zinc-600">
                “Use as reference” splices the selection automatically and opens it in the
                Playground as @Video1, ready for the changes you want to make.
              </p>
              {referenceState.status === 'error' && (
                <p className="text-sm text-red-400 flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  {referenceState.message}
                </p>
              )}
              {exportState.status === 'error' && (
                <p className="text-sm text-red-400 flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  {exportState.message}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
