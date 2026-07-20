import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Clapperboard, Film, FolderOpen, Image as ImageIcon, Music, Play, RotateCcw, Square, X } from 'lucide-react'
import { useProjects } from '../contexts/ProjectContext'
import { directorRunToAlternateTrack, directorRunToTimeline } from '../lib/director-import'
import { LtxLogo } from '../components/LtxLogo'
import { logger } from '../lib/logger'
import { toImgSrc } from '../lib/path-to-img-src'
import { estimateCloudPoints, formatPoints } from '../lib/palette-points'

/**
 * Director — turn a song into a finished music video.
 *
 * Pick a song + one line of concept; the backend listens (beats, tempo,
 * sections), plans beat-snapped shots, renders each through the queue
 * (Seedance), trims every clip to its exact cut and lays the song under the
 * picture. Crash-safe: an interrupted build resumes where it stopped.
 */

interface DirectorShot {
  index: number
  start: number
  end: number
  sectionLabel: string
  shotType: string
  prompt: string
  generateSeconds: number
  status: 'pending' | 'submitted' | 'complete' | 'error'
  error: string | null
  resultPath: string | null
  phase: string
  progress: number
  keyframePath: string | null
}

interface DirectorRun {
  id: string
  phase: 'analyzing' | 'storyboarding' | 'awaiting_approval' | 'generating' | 'assembling' | 'complete' | 'error' | 'cancelled'
  error: string | null
  audioPath: string
  concept: string
  model: string
  resolution: string
  createdAt: number
  outputPath: string | null
  tempoBpm: number | null
  songSeconds: number | null
  sectionCount: number | null
  sections: { start: number; end: number; label: string }[] | null
  storyboard: boolean
  approval: 'auto' | 'approve'
  treatment: string
  artistName: string
  directorStyle: string
  shots: DirectorShot[]
}

const MODELS = [
  { id: 'ltx-fast', label: 'LTX-2 Local — TRUE lip-sync, free (your GPU)' },
  { id: 'seedance-2.0', label: 'Seedance 2.0 — cloud, approximate lip-sync' },
  { id: 'seedance-2.0-fast', label: 'Seedance 2.0 Fast — cloud, approximate lip-sync' },
]
const KEYFRAME_MODELS = [
  { id: 'dp-nano-banana-2', label: 'Nano Banana 2', pts: 10 },
  { id: 'dp-nano-banana-2-lite', label: 'Nano Banana 2 Lite', pts: 5 },
  { id: 'dp-gpt-image-2', label: 'GPT Image 2', pts: 2 },
]
const LOCAL_MODELS = new Set(['ltx-fast'])
const RESOLUTIONS = ['480p', '720p', '1080p']

const PHASE_STEPS: { key: DirectorRun['phase'] | 'done'; label: string }[] = [
  { key: 'analyzing', label: 'Listen' },
  { key: 'generating', label: 'Generate' },
  { key: 'assembling', label: 'Assemble' },
  { key: 'complete', label: 'Done' },
]

const SHOT_COLOR: Record<DirectorShot['status'], string> = {
  pending: 'bg-zinc-700',
  submitted: 'bg-amber-500 animate-pulse',
  complete: 'bg-emerald-500',
  error: 'bg-red-500',
}

async function backendBase(): Promise<string> {
  return await window.electronAPI.getBackendUrl()
}

export function Director() {
  const { goHome, createProject, updateTimeline, openProject, setCurrentTab, projects } = useProjects()
  const [audioPath, setAudioPath] = useState<string | null>(null)
  const [concept, setConcept] = useState('')
  const [model, setModel] = useState('ltx-fast')
  const [treatment, setTreatment] = useState('')
  const [artistName, setArtistName] = useState('')
  const [directorStyle, setDirectorStyle] = useState('')
  const [directorStyles, setDirectorStyles] = useState<{ id: string; name: string; description: string }[]>([])
  const [artists, setArtists] = useState<{ id: string; name: string; reference_image_paths: string[] }[]>([])
  const [storyboard, setStoryboard] = useState(false)
  const [approval, setApproval] = useState<'auto' | 'approve'>('approve')
  const [imageModel, setImageModel] = useState('dp-nano-banana-2')
  const [redoSelection, setRedoSelection] = useState<Set<number>>(new Set())
  const [resolution, setResolution] = useState('720p')
  const [referencePaths, setReferencePaths] = useState<string[]>([])
  const [run, setRun] = useState<DirectorRun | null>(null)
  const [gpu, setGpu] = useState<{ name: string; vramGb: number } | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const runIdRef = useRef<string | null>(null)

  // Vision sources: director styles + the Characters library as artists.
  useEffect(() => {
    ;(async () => {
      try {
        const base = await backendBase()
        const [stylesRes, charsRes] = await Promise.all([
          fetch(`${base}/api/director/styles`),
          fetch(`${base}/api/library/characters`),
        ])
        if (stylesRes.ok) {
          const data = (await stylesRes.json()) as { styles?: { id: string; name: string; description: string }[] }
          setDirectorStyles(data.styles ?? [])
        }
        if (charsRes.ok) {
          const data = (await charsRes.json()) as { characters?: { id: string; name: string; reference_image_paths: string[] }[] }
          setArtists((data.characters ?? []).filter((c) => c.reference_image_paths?.length))
        }
      } catch {
        /* backend warming up */
      }
    })()
  }, [])

  // System check for the local path: what GPU + how much VRAM.
  useEffect(() => {
    ;(async () => {
      try {
        const base = await backendBase()
        const res = await fetch(`${base}/health`)
        if (!res.ok) return
        const data = (await res.json()) as { gpu_info?: { name?: string; vram?: number } }
        if (data.gpu_info?.name && data.gpu_info.vram) {
          setGpu({ name: data.gpu_info.name, vramGb: Math.round(data.gpu_info.vram / (1024 ** 3)) })
        }
      } catch {
        /* backend warming up */
      }
    })()
  }, [])

  // Adopt the latest run on mount so a restarted app shows the in-flight build.
  useEffect(() => {
    ;(async () => {
      try {
        const base = await backendBase()
        const res = await fetch(`${base}/api/director/status`)
        if (!res.ok) return
        const data = (await res.json()) as { run: DirectorRun | null }
        if (data.run) {
          setRun(data.run)
          runIdRef.current = data.run.id
        }
      } catch {
        /* backend warming up */
      }
    })()
  }, [])

  // Poll while a run is active.
  useEffect(() => {
    const active = run && !['complete', 'error', 'cancelled'].includes(run.phase)
    if (!active) return
    const interval = setInterval(async () => {
      try {
        const base = await backendBase()
        const res = await fetch(`${base}/api/director/status?runId=${runIdRef.current}`)
        if (!res.ok) return
        const data = (await res.json()) as { run: DirectorRun | null }
        if (data.run && data.run.id === runIdRef.current) setRun(data.run)
      } catch {
        /* transient */
      }
    }, 1500)
    return () => clearInterval(interval)
  }, [run])

  const pickSong = useCallback(async () => {
    const files = await window.electronAPI.showOpenFileDialog({
      title: 'Pick the song',
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg'] }],
      properties: ['openFile'],
    })
    if (files && files[0]) setAudioPath(files[0])
  }, [])

  const pickReferences = useCallback(async () => {
    const files = await window.electronAPI.showOpenFileDialog({
      title: 'Reference images (character / style)',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile', 'multiSelections'],
    })
    if (files && files.length) setReferencePaths((prev) => [...prev, ...files].slice(0, 4))
  }, [])

  const start = useCallback(async () => {
    if (!audioPath || !concept.trim() || starting) return
    setStarting(true)
    setStartError(null)
    try {
      const base = await backendBase()
      const res = await fetch(`${base}/api/director/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioPath,
          concept: concept.trim(),
          model,
          resolution,
          referenceImagePaths: referencePaths,
          treatment: treatment.trim(),
          artistName: artistName.trim(),
          storyboard,
          approval,
          imageModel,
          directorStyle,
        }),
      })
      const data = (await res.json()) as { run?: DirectorRun; error?: string }
      if (!res.ok || !data.run) throw new Error(data.error || `Start failed (${res.status})`)
      runIdRef.current = data.run.id
      setRun(data.run)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not start'
      setStartError(msg)
      logger.error(`Director start failed: ${msg}`)
    } finally {
      setStarting(false)
    }
  }, [audioPath, concept, model, resolution, referencePaths, treatment, artistName, storyboard, approval, imageModel, directorStyle, starting])

  const post = useCallback(async (endpoint: 'cancel' | 'resume') => {
    if (!runIdRef.current) return
    try {
      const base = await backendBase()
      const res = await fetch(`${base}/api/director/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: runIdRef.current }),
      })
      const data = (await res.json()) as { run: DirectorRun | null }
      if (data.run) setRun(data.run)
    } catch (e) {
      logger.error(`Director ${endpoint} failed: ${e}`)
    }
  }, [])

  // A prior Director project built from THIS song (its timeline carries the
  // dsong- audio clip with the same file name) — the stack-alternates target.
  const altTarget = (() => {
    if (!run) return null
    const songName = run.audioPath.split(/[\\/]/).pop() || ''
    for (const project of projects) {
      for (const timeline of project.timelines || []) {
        const songClip = (timeline.clips || []).find(
          (c) => c.id.startsWith('dsong-') && (c.importedUrl || '').endsWith(encodeURIComponent(songName).replace(/%20/g, ' ')),
        ) || (timeline.clips || []).find(
          (c) => c.id.startsWith('dsong-') && (c.importedUrl || '').split('/').pop() === songName,
        )
        if (songClip) return { project, timeline }
      }
    }
    return null
  })()

  // Stack this run onto the existing project as a new muted video lane —
  // same beat grid, alternate shots. Run it three times, get three lanes.
  const addAsAlternateTrack = useCallback(() => {
    if (!run || !altTarget) return
    const { project, timeline } = altTarget
    const alt = directorRunToAlternateTrack(run, timeline)
    if (alt.clips.length === 0) return
    updateTimeline(project.id, timeline.id, {
      tracks: [...timeline.tracks, alt.track],
      clips: [...timeline.clips, ...alt.clips],
    })
    openProject(project.id)
    setCurrentTab('video-editor')
  }, [run, altTarget, updateTimeline, openProject, setCurrentTab])

  // Rebuild the run as an editable project: shots at their beat positions on
  // V1 (muted), the song on A1, sections as range markers. Works for partial
  // runs too — whatever rendered gets placed.
  const openInEditor = useCallback(() => {
    if (!run) return
    const timeline = directorRunToTimeline(run)
    const songName = run.audioPath.split(/[\\/]/).pop() || 'song'
    const project = createProject(`Director — ${songName.replace(/\.[^.]+$/, '')}`)
    // Use the RETURNED project's default timeline id — getActiveTimeline reads
    // the projects array from the previous render and can't see this project
    // yet (stale closure), which would silently open an empty editor.
    const timelineId = project.activeTimelineId ?? project.timelines[0]?.id
    if (timelineId) {
      updateTimeline(project.id, timelineId, {
        clips: timeline.clips,
        tracks: timeline.tracks,
        markers: timeline.markers,
      })
    }
    openProject(project.id)
    setCurrentTab('video-editor')
  }, [run, createProject, updateTimeline, openProject, setCurrentTab])

  const approveStoryboard = useCallback(async (regenerate: number[]) => {
    if (!runIdRef.current) return
    try {
      const base = await backendBase()
      const res = await fetch(`${base}/api/director/storyboard/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: runIdRef.current, regenerate }),
      })
      const data = (await res.json()) as { run: DirectorRun | null }
      if (data.run) setRun(data.run)
      setRedoSelection(new Set())
    } catch (e) {
      logger.error(`Storyboard approve failed: ${e}`)
    }
  }, [])

  const isActive = run != null && !['complete', 'error', 'cancelled'].includes(run.phase)
  const shotsDone = run?.shots.filter((s) => s.status === 'complete').length ?? 0
  const steps = run && run.storyboard
    ? [
        { key: 'analyzing', label: 'Listen' },
        { key: 'storyboarding', label: 'Frames' },
        ...(run.approval === 'approve' ? [{ key: 'awaiting_approval', label: 'Approve' }] : []),
        { key: 'generating', label: 'Generate' },
        { key: 'assembling', label: 'Assemble' },
        { key: 'complete', label: 'Done' },
      ]
    : PHASE_STEPS
  const phaseIndex = run
    ? run.phase === 'error' || run.phase === 'cancelled'
      ? run.outputPath
        ? steps.findIndex((st) => st.key === 'assembling')
        : run.shots.some((sh) => sh.status !== 'pending')
          ? steps.findIndex((st) => st.key === 'generating')
          : run.shots.some((sh) => sh.keyframePath)
            ? Math.max(1, steps.findIndex((st) => st.key === 'storyboarding'))
            : 0
      : steps.findIndex((st) => st.key === run.phase)
    : -1

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-white">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-zinc-800/70">
        <button onClick={goHome} className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <LtxLogo className="h-5" />
        <div className="flex items-center gap-2">
          <Clapperboard className="h-4 w-4 text-amber-400" />
          <h1 className="text-sm font-semibold tracking-tight">Director</h1>
          <span className="text-[11px] text-zinc-500">song in → music video out</span>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* ── Setup column ── */}
        <div className="w-[340px] shrink-0 border-r border-zinc-800/70 p-4 space-y-4 overflow-y-auto">
          <div>
            <label className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Song</label>
            <button
              onClick={pickSong}
              disabled={isActive}
              className="mt-1.5 w-full flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 px-3 py-2.5 text-sm text-left transition-colors disabled:opacity-50"
            >
              <Music className="h-4 w-4 text-amber-400 shrink-0" />
              <span className="truncate text-zinc-300">
                {audioPath ? audioPath.split(/[\\/]/).pop() : 'Choose an audio file…'}
              </span>
            </button>
          </div>

          <div>
            <label className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Concept</label>
            <textarea
              value={concept}
              onChange={(e) => setConcept(e.target.value)}
              disabled={isActive}
              placeholder="One line about the video's world — e.g. 'neon-soaked rooftop chase at midnight, chrome and rain'"
              className="mt-1.5 w-full h-24 rounded-lg border border-zinc-700 bg-zinc-900 p-2.5 text-sm text-zinc-200 resize-y disabled:opacity-50"
            />
          </div>

          <div>
            <label className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Story / Treatment</label>
            <textarea
              value={treatment}
              onChange={(e) => setTreatment(e.target.value)}
              disabled={isActive}
              placeholder={"Optional — the story the video tells, sentence by sentence. Verses carry the story in order; choruses stay performance. e.g. 'A drifter finds a buried radio. It leads her to a hidden city. She frees its music.'"}
              className="mt-1.5 w-full h-20 rounded-lg border border-zinc-700 bg-zinc-900 p-2.5 text-xs text-zinc-200 resize-y disabled:opacity-50"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Artist</label>
              <select
                value={artistName}
                onChange={(e) => {
                  const name = e.target.value
                  setArtistName(name)
                  const artist = artists.find((a) => a.name === name)
                  if (artist) setReferencePaths(artist.reference_image_paths.slice(0, 4))
                }}
                disabled={isActive}
                className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-2 text-xs text-zinc-200 disabled:opacity-50"
              >
                <option value="">— none —</option>
                {artists.map((a) => (
                  <option key={a.id} value={a.name}>{a.name}</option>
                ))}
              </select>
              <p className="text-[10px] text-zinc-600 mt-1">From your Characters library — their look rides every shot.</p>
            </div>
            <div>
              <label className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Director</label>
              <select
                value={directorStyle}
                onChange={(e) => setDirectorStyle(e.target.value)}
                disabled={isActive}
                className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-2 text-xs text-zinc-200 disabled:opacity-50"
              >
                <option value="">— no director —</option>
                {directorStyles.map((d) => (
                  <option key={d.id} value={d.id} title={d.description}>{d.name}</option>
                ))}
              </select>
              <p className="text-[10px] text-zinc-600 mt-1">Their visual voice flavors every shot.</p>
            </div>
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={storyboard}
                onChange={(e) => setStoryboard(e.target.checked)}
                disabled={isActive}
              />
              <span className="text-xs text-zinc-200 font-medium">Storyboard first — a keyframe image per shot</span>
            </label>
            {storyboard && (
              <div className="space-y-2 pl-6">
                <div className="flex items-center gap-3 text-[11px] text-zinc-400">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" checked={approval === 'approve'} onChange={() => setApproval('approve')} disabled={isActive} />
                    Pause for my approval
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" checked={approval === 'auto'} onChange={() => setApproval('auto')} disabled={isActive} />
                    Full auto
                  </label>
                </div>
                <select
                  value={imageModel}
                  onChange={(e) => setImageModel(e.target.value)}
                  disabled={isActive}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-200 disabled:opacity-50"
                >
                  {KEYFRAME_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>{m.label} — {m.pts} pts/frame</option>
                  ))}
                </select>
                <p className="text-[10px] text-zinc-600">
                  Keyframes bill Directors Palette points (~{(KEYFRAME_MODELS.find((m) => m.id === imageModel)?.pts ?? 10)} pts x ~25-40 shots); the video stage then animates each approved frame.
                </p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Model</label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={isActive}
                className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-2 text-xs text-zinc-200 disabled:opacity-50"
              >
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Resolution</label>
              <select
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                disabled={isActive}
                className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-2 text-xs text-zinc-200 disabled:opacity-50"
              >
                {RESOLUTIONS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Reference images</label>
              <button
                onClick={pickReferences}
                disabled={isActive || referencePaths.length >= 4}
                className="text-[11px] text-zinc-300 hover:text-white px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 transition-colors disabled:opacity-40"
              >
                <ImageIcon className="h-3 w-3 inline mr-1" />Add
              </button>
            </div>
            <p className="text-[10px] text-zinc-600 mt-1">Optional — your artist / style refs ride every shot.</p>
            {referencePaths.length > 0 && (
              <div className="mt-2 flex gap-2 flex-wrap">
                {referencePaths.map((p, i) => (
                  <div key={i} className="relative group">
                    <img src={toImgSrc(p)} alt="" className="h-14 w-14 object-cover rounded-md border border-zinc-700" />
                    <button
                      onClick={() => setReferencePaths((prev) => prev.filter((_, j) => j !== i))}
                      className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-zinc-800 border border-zinc-600 text-zinc-300 hover:text-white hidden group-hover:flex items-center justify-center"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={start}
            disabled={!audioPath || !concept.trim() || starting || isActive}
            className="w-full flex items-center justify-center gap-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold py-2.5 text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Play className="h-4 w-4" />
            {starting ? 'Starting…' : 'Make the video'}
          </button>
          {startError && <p className="text-xs text-red-400">{startError}</p>}
          {LOCAL_MODELS.has(model) ? (
            <div className="space-y-1">
              <p className="text-[10px] text-zinc-600">
                Renders free on your GPU with true lip-sync — each shot hears its bars of the song.
                Expect ~1-2 min per shot; shots queue one at a time. Needs the local models downloaded (Model Status, top bar).
              </p>
              <p className="text-[10px] text-amber-400/80">
                System intensive: local LTX-2 wants ~18GB+ of free VRAM.
                {gpu ? ` Your GPU: ${gpu.name} (${gpu.vramGb}GB).` : ''}
                {gpu && gpu.vramGb < 18 ? ' This GPU is below the comfortable minimum — expect slow or failed renders.' : ''}
              </p>
            </div>
          ) : (
            <p className="text-[10px] text-zinc-600">
              Cloud renders bill Directors Palette points
              {(() => {
                const est = estimateCloudPoints(model, resolution, 180 * 1.15)
                return est ? ` — a 3-minute song ≈ ${formatPoints(est.points)}${est.approx ? ' (estimate)' : ''}` : ''
              })()}
              . A 3-minute song is roughly 25-40 shots; reference images ride every shot.
            </p>
          )}
        </div>

        {/* ── Run column ── */}
        <div className="flex-1 p-6 overflow-y-auto">
          {!run ? (
            <div className="h-full flex flex-col items-center justify-center text-center">
              <div className="h-16 w-16 rounded-full bg-amber-500/10 flex items-center justify-center mb-4">
                <Clapperboard className="h-8 w-8 text-amber-400" />
              </div>
              <p className="text-sm text-zinc-400 max-w-sm">
                Pick a song and a concept. Director listens for the beat and structure, plans the cut,
                renders every shot, and delivers a finished video synced to the music.
              </p>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto space-y-6">
              {/* Phase stepper */}
              <div className="flex items-center gap-2">
                {steps.map((step, i) => {
                  const reached = phaseIndex >= i || run.phase === 'complete'
                  const current = run.phase === step.key
                  return (
                    <div key={step.key} className="flex items-center gap-2">
                      <div
                        className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                          current
                            ? 'bg-amber-500 text-zinc-950 border-amber-400'
                            : reached
                              ? 'bg-zinc-800 text-zinc-200 border-zinc-700'
                              : 'bg-zinc-900 text-zinc-600 border-zinc-800'
                        }`}
                      >
                        {step.label}
                      </div>
                      {i < steps.length - 1 && <div className="w-6 h-px bg-zinc-700" />}
                    </div>
                  )
                })}
                <div className="ml-auto flex items-center gap-2">
                  {isActive && (
                    <button
                      onClick={() => post('cancel')}
                      className="flex items-center gap-1.5 text-xs text-zinc-300 hover:text-white px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition-colors"
                    >
                      <Square className="h-3 w-3" /> Cancel
                    </button>
                  )}
                  {(run.phase === 'error' || run.phase === 'cancelled') && (
                    <button
                      onClick={() => post('resume')}
                      className="flex items-center gap-1.5 text-xs text-zinc-950 font-medium px-2.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 transition-colors"
                    >
                      <RotateCcw className="h-3 w-3" /> Resume
                    </button>
                  )}
                </div>
              </div>

              {/* Analysis chips */}
              {run.tempoBpm != null && (
                <div className="flex gap-2 flex-wrap text-[11px]">
                  <span className="px-2 py-1 rounded-md bg-zinc-800 text-zinc-300">{Math.round(run.tempoBpm)} BPM</span>
                  {run.songSeconds != null && (
                    <span className="px-2 py-1 rounded-md bg-zinc-800 text-zinc-300">
                      {Math.floor(Math.round(run.songSeconds) / 60)}:{String(Math.round(run.songSeconds) % 60).padStart(2, '0')}
                    </span>
                  )}
                  {run.sectionCount != null && (
                    <span className="px-2 py-1 rounded-md bg-zinc-800 text-zinc-300">{run.sectionCount} sections</span>
                  )}
                  <span className="px-2 py-1 rounded-md bg-zinc-800 text-zinc-300">{run.shots.length} shots</span>
                </div>
              )}

              {/* Error banner */}
              {run.phase === 'error' && run.error && (
                <div className="rounded-lg border border-red-900/60 bg-red-950/40 p-3 text-xs text-red-300">
                  {run.error}
                </div>
              )}

              {/* Partial salvage: rendered shots are still an editable cut. */}
              {(run.phase === 'error' || run.phase === 'cancelled') && shotsDone > 0 && (
                <button
                  onClick={openInEditor}
                  className="flex items-center gap-1.5 text-xs text-zinc-300 hover:text-white px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition-colors"
                  title="Place the shots that DID render on a timeline"
                >
                  <Film className="h-3 w-3" /> Open partial cut in editor ({shotsDone} shots)
                </button>
              )}

              {/* Keyframe storyboard grid */}
              {run.storyboard && ['storyboarding', 'awaiting_approval'].includes(run.phase) && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-zinc-400">
                      Keyframes: {run.shots.filter((sh) => sh.keyframePath).length}/{run.shots.length}
                      {run.phase === 'awaiting_approval' && ' — click frames to mark for regeneration'}
                    </span>
                    {run.phase === 'awaiting_approval' && (
                      <div className="flex items-center gap-2">
                        {redoSelection.size > 0 && (
                          <button
                            onClick={() => approveStoryboard([...redoSelection])}
                            className="text-[11px] text-zinc-950 font-medium px-2.5 py-1 rounded-lg bg-red-400 hover:bg-red-300 transition-colors"
                          >
                            Regenerate {redoSelection.size} frame{redoSelection.size === 1 ? '' : 's'}
                          </button>
                        )}
                        <button
                          onClick={() => approveStoryboard([])}
                          className="text-[11px] text-zinc-950 font-semibold px-2.5 py-1 rounded-lg bg-emerald-400 hover:bg-emerald-300 transition-colors"
                        >
                          Approve — make the video
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-6 gap-1.5">
                    {run.shots.map((sh) => (
                      <button
                        key={sh.index}
                        onClick={() => {
                          if (run.phase !== 'awaiting_approval') return
                          setRedoSelection((prev) => {
                            const next = new Set(prev)
                            if (next.has(sh.index)) next.delete(sh.index)
                            else next.add(sh.index)
                            return next
                          })
                        }}
                        title={`#${sh.index + 1} · ${sh.sectionLabel} · ${sh.shotType}\n${sh.prompt}`}
                        className={`relative aspect-video rounded-md overflow-hidden border transition-colors ${
                          redoSelection.has(sh.index)
                            ? 'border-red-400 ring-1 ring-red-400'
                            : 'border-zinc-700 hover:border-zinc-500'
                        }`}
                      >
                        {sh.keyframePath ? (
                          <img src={toImgSrc(sh.keyframePath)} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <div className="h-full w-full bg-zinc-800 animate-pulse" />
                        )}
                        <span className="absolute bottom-0 left-0 px-1 text-[9px] bg-black/60 text-zinc-200">{sh.index + 1}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Shot progress */}
              {run.shots.length > 0 && run.phase !== 'complete' && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-zinc-400">
                      Shots: {shotsDone}/{run.shots.length} rendered
                    </span>
                    {(() => {
                      const active = run.shots.find((sh) => sh.status === 'submitted')
                      if (!active) return null
                      const phaseLabel = active.phase
                        ? active.phase.replace(/_/g, ' ')
                        : 'waiting in queue'
                      return (
                        <span className="text-[11px] text-amber-300/90">
                          Shot {active.index + 1}: {phaseLabel}
                          {active.progress > 0 ? ` — ${active.progress}%` : ''}
                        </span>
                      )
                    })()}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {run.shots.map((s) => (
                      <div
                        key={s.index}
                        title={`#${s.index + 1} · ${s.sectionLabel} · ${s.shotType} · ${s.status}${s.error ? ` — ${s.error}` : ''}\n${s.prompt}`}
                        className={`h-5 rounded-sm ${SHOT_COLOR[s.status]} transition-colors`}
                        style={{ width: `${Math.max(14, Math.min(56, (s.end - s.start) * 6))}px` }}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Result */}
              {run.phase === 'complete' && run.outputPath && (
                <div className="space-y-3">
                  <video
                    src={toImgSrc(run.outputPath)}
                    controls
                    className="w-full rounded-xl border border-zinc-800 bg-black"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      onClick={openInEditor}
                      className="flex items-center gap-1.5 text-xs text-zinc-950 font-medium px-2.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 transition-colors"
                      title="New project: every shot as a clip at its beat position, the song on the audio track, sections as markers"
                    >
                      <Film className="h-3 w-3" /> Open in editor
                    </button>
                    {altTarget && (
                      <button
                        onClick={addAsAlternateTrack}
                        className="flex items-center gap-1.5 text-xs text-zinc-300 hover:text-white px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition-colors"
                        title="Stack this pass onto the existing project as a new muted video lane — same beat grid, alternate shots to compare and mix"
                      >
                        <Film className="h-3 w-3" /> Add as alt track to "{altTarget.project.name.slice(0, 24)}"
                      </button>
                    )}
                    <button
                      onClick={() => run.outputPath && window.electronAPI.showItemInFolder(run.outputPath)}
                      className="flex items-center gap-1.5 text-xs text-zinc-300 hover:text-white px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition-colors"
                    >
                      <FolderOpen className="h-3 w-3" /> Show in folder
                    </button>
                    <span className="text-[11px] text-zinc-500">Also in your Gallery.</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default Director
