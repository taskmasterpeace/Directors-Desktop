import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Clapperboard, Film, FolderOpen, Image as ImageIcon, Music, Play, RotateCcw, Square, X } from 'lucide-react'
import { useProjects } from '../contexts/ProjectContext'
import { directorRunToAlternateTrack, directorRunToTimeline } from '../lib/director-import'
import { LtxLogo } from '../components/LtxLogo'
import { logger } from '../lib/logger'
import { toImgSrc } from '../lib/path-to-img-src'
import { estimateCloudPoints, formatPoints } from '../lib/palette-points'
import { useCreditBalance } from '../hooks/use-credit-balance'
import { MANNEQUIN_REFERENCE_URL } from '../lib/shot-creator/quick-modes'
import { pluralize } from '../lib/pluralize'

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
  phase: 'analyzing' | 'plan_ready' | 'storyboarding' | 'awaiting_approval' | 'generating' | 'assembling' | 'complete' | 'error' | 'cancelled'
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
  sections: { start: number; end: number; label: string; energy: number }[] | null
  storyboard: boolean
  approval: 'auto' | 'approve'
  treatment: string
  artistName: string
  directorStyle: string
  planReview: boolean
  aspect: string
  beats: number[] | null
  lyricsWordCount: number | null
  shots: DirectorShot[]
}

const MODELS = [
  { id: 'ltx-fast', label: 'LTX-2.3 Local — audio-conditioned TRUE lip-sync, free' },
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
  const { goHome, createProject, updateTimeline, openProject, setCurrentTab, projects, pendingDirectorAudio, setPendingDirectorAudio } = useProjects()
  const [audioPath, setAudioPath] = useState<string | null>(null)
  const [concept, setConcept] = useState('')
  const [model, setModel] = useState('ltx-fast')
  const [treatment, setTreatment] = useState('')
  const [artistName, setArtistName] = useState('')
  const [directorStyle, setDirectorStyle] = useState('')
  const [directorStyles, setDirectorStyles] = useState<{ id: string; name: string; description: string; wardrobe: string[] }[]>([])
  const [artists, setArtists] = useState<{ id: string; name: string; reference_image_paths: string[] }[]>([])
  const [storyboard, setStoryboard] = useState(false)
  const [planReview, setPlanReview] = useState(true)
  const [approval, setApproval] = useState<'auto' | 'approve'>('approve')
  const [imageModel, setImageModel] = useState('dp-nano-banana-2')
  const [wardrobe, setWardrobe] = useState<[string, string, string]>(['', '', ''])
  const [mannequins, setMannequins] = useState<[{ path?: string; jobId?: string }, { path?: string; jobId?: string }, { path?: string; jobId?: string }]>([{}, {}, {}])
  const [redoSelection, setRedoSelection] = useState<Set<number>>(new Set())
  const [previewShot, setPreviewShot] = useState<DirectorShot | null>(null)
  // #69: which section of the song is being auditioned (click a block to hear it)
  const [audition, setAudition] = useState<{ start: number; end: number; index: number } | null>(null)
  const auditionRef = useRef<HTMLAudioElement | null>(null)
  const [planEdits, setPlanEdits] = useState<Record<number, string>>({})
  const [rerollSelection, setRerollSelection] = useState<Set<number>>(new Set())
  const [resolution, setResolution] = useState('720p')
  const [aspect, setAspect] = useState('16:9')
  const [referencePaths, setReferencePaths] = useState<string[]>([])
  const [run, setRun] = useState<DirectorRun | null>(null)
  const [gpu, setGpu] = useState<{ name: string; vramGb: number } | null>(null)
  const balance = useCreditBalance()
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const runIdRef = useRef<string | null>(null)

  // #76: Home's "Make your first music video" hands the bundled sample here.
  useEffect(() => {
    if (!pendingDirectorAudio) return
    setAudioPath(pendingDirectorAudio)
    setPendingDirectorAudio(null)
  }, [pendingDirectorAudio, setPendingDirectorAudio])

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
          const data = (await stylesRes.json()) as { styles?: { id: string; name: string; description: string; wardrobe: string[] }[] }
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
    if (!audioPath || starting) return
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
          aspect,
          referenceImagePaths: [
            ...referencePaths,
            ...mannequins.map((m) => m.path).filter((p): p is string => Boolean(p)),
          ].slice(0, 6),
          treatment: treatment.trim(),
          artistName: artistName.trim(),
          storyboard,
          approval,
          imageModel,
          directorStyle,
          wardrobe: wardrobe.filter(Boolean),
          planReview,
        }),
      })
      const data = (await res.json()) as { run?: DirectorRun; error?: string }
      if (!res.ok || !data.run) throw new Error(data.error || `Start failed (${res.status})`)
      runIdRef.current = data.run.id
      setRun(data.run)
      setPlanEdits({})
      setRerollSelection(new Set())
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not start'
      setStartError(msg)
      logger.error(`Director start failed: ${msg}`)
    } finally {
      setStarting(false)
    }
  }, [audioPath, concept, model, resolution, aspect, referencePaths, mannequins, treatment, artistName, storyboard, approval, imageModel, directorStyle, wardrobe, planReview, starting])

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

  // Wardrobe -> mannequin: render the described look on the neutral three-view
  // mannequin sheet (Palette points) so you can SEE it, swap it, approve it.
  const visualizeLook = useCallback(async (index: number) => {
    const description = wardrobe[index]?.trim()
    if (!description) return
    try {
      const base = await backendBase()
      const res = await fetch(`${base}/api/queue/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'image',
          model: imageModel,
          params: {
            prompt:
              'Reference image 1 is a neutral gray articulated mannequin shown in three orthographic views — FRONT, SIDE, BACK — on a clean off-white studio background. ' +
              `Redraw this exact three-view mannequin sheet with the mannequin DRESSED in the following outfit: ${description}. ` +
              'Render the garments with realistic fabric, fit and detail on all three views. Keep the neutral gray mannequin, the same poses and views, and the clean off-white studio background. No human model, no text, no labels.',
            referenceImagePaths: [MANNEQUIN_REFERENCE_URL],
            numImages: 1,
          },
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `Submit failed (${res.status})`)
      }
      const data = (await res.json()) as { id: string }
      setMannequins((prev) => {
        const next = [...prev] as typeof prev
        next[index] = { jobId: data.id }
        return next
      })
    } catch (e) {
      setStartError(e instanceof Error ? e.message : 'Mannequin render failed')
      logger.error(`Mannequin visualize failed: ${e}`)
    }
  }, [wardrobe, imageModel])

  // Poll pending mannequin jobs.
  useEffect(() => {
    if (!mannequins.some((m) => m.jobId)) return
    const interval = setInterval(async () => {
      try {
        const base = await backendBase()
        const res = await fetch(`${base}/api/queue/status`)
        if (!res.ok) return
        const data = (await res.json()) as { jobs: { id: string; status: string; result_paths: string[]; error?: string | null }[] }
        setMannequins((prev) => {
          let changed = false
          const next = [...prev] as typeof prev
          prev.forEach((m, i) => {
            if (!m.jobId) return
            const job = data.jobs.find((j) => j.id === m.jobId)
            if (!job || job.status === 'queued' || job.status === 'running') return
            changed = true
            next[i] = job.status === 'complete' && job.result_paths[0] ? { path: job.result_paths[0] } : {}
            if (job.status !== 'complete') setStartError(`Look ${i + 1} render failed: ${job.error || job.status}`)
          })
          return changed ? next : prev
        })
      } catch {
        /* transient */
      }
    }, 2000)
    return () => clearInterval(interval)
  }, [mannequins])

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

  // #62: leave the free waiting room — apply prompt edits, start spending.
  const approvePlan = useCallback(async () => {
    if (!runIdRef.current) return
    try {
      const base = await backendBase()
      const res = await fetch(`${base}/api/director/plan/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: runIdRef.current, prompts: planEdits }),
      })
      const data = (await res.json()) as { run: DirectorRun | null }
      if (data.run) setRun(data.run)
    } catch (e) {
      logger.error(`Plan approve failed: ${e}`)
    }
  }, [planEdits])

  // #63: re-render the marked shots of a finished video, then reassemble.
  const rerollShots = useCallback(async () => {
    if (!runIdRef.current || rerollSelection.size === 0) return
    try {
      const base = await backendBase()
      const res = await fetch(`${base}/api/director/reroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: runIdRef.current, indices: [...rerollSelection] }),
      })
      const data = (await res.json()) as { run: DirectorRun | null }
      if (data.run) setRun(data.run)
      setRerollSelection(new Set())
    } catch (e) {
      logger.error(`Director reroll failed: ${e}`)
    }
  }, [rerollSelection])

  const isActive = run != null && !['complete', 'error', 'cancelled'].includes(run.phase)
  const shotsDone = run?.shots.filter((s) => s.status === 'complete').length ?? 0
  const steps = run
    ? [
        { key: 'analyzing', label: 'Listen' },
        ...(run.planReview ? [{ key: 'plan_ready', label: 'Plan' }] : []),
        ...(run.storyboard ? [{ key: 'storyboarding', label: 'Frames' }] : []),
        ...(run.storyboard && run.approval === 'approve' ? [{ key: 'awaiting_approval', label: 'Approve' }] : []),
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
          <h1 className="text-sm font-semibold tracking-tight">Music Video</h1>
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
            <label className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Concept — optional</label>
            <textarea
              value={concept}
              onChange={(e) => setConcept(e.target.value)}
              disabled={isActive}
              placeholder="One line about the video's world — or leave blank and the Director drafts one from the song itself"
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

          <div>
            <div className="flex items-center justify-between">
              <label className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Wardrobe</label>
              {(() => {
                const chosen = directorStyles.find((d) => d.id === directorStyle)
                if (!chosen || chosen.wardrobe.length < 3) return null
                return (
                  <button
                    onClick={() => setWardrobe([chosen.wardrobe[0], chosen.wardrobe[1], chosen.wardrobe[2]])}
                    disabled={isActive}
                    className="text-[11px] text-amber-300 hover:text-amber-200 px-2 py-0.5 rounded bg-amber-500/10 hover:bg-amber-500/20 transition-colors disabled:opacity-40"
                  >
                    Use {chosen.name}'s looks
                  </button>
                )
              })()}
            </div>
            <div className="mt-1.5 space-y-1.5">
              {(['Story look (verses)', 'Chorus look', 'Bridge look'] as const).map((label, i) => (
                <div key={label} className="flex items-center gap-1.5">
                  {mannequins[i].path ? (
                    <img
                      src={toImgSrc(mannequins[i].path)}
                      alt=""
                      title="Wardrobe on the mannequin — rides the run as a reference"
                      className="h-12 w-12 object-cover rounded-md border border-emerald-500/50 shrink-0"
                    />
                  ) : mannequins[i].jobId ? (
                    <div className="h-12 w-12 rounded-md bg-zinc-800 animate-pulse shrink-0" title="Rendering on the mannequin…" />
                  ) : null}
                  <input
                    value={wardrobe[i]}
                    onChange={(e) =>
                      setWardrobe((prev) => {
                        const next: [string, string, string] = [...prev]
                        next[i] = e.target.value
                        return next
                      })
                    }
                    disabled={isActive}
                    placeholder={label + " — e.g. 'all-white fur coat over chrome accents'"}
                    className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-[11px] text-zinc-200 disabled:opacity-50"
                  />
                  <button
                    onClick={() => visualizeLook(i)}
                    disabled={isActive || !wardrobe[i].trim() || Boolean(mannequins[i].jobId)}
                    title={`Render this look on the mannequin (${KEYFRAME_MODELS.find((m) => m.id === imageModel)?.pts ?? 10} pts)`}
                    className="text-[10px] text-zinc-300 hover:text-white px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 transition-colors disabled:opacity-40 shrink-0"
                  >
                    {mannequins[i].path ? 'Redo' : 'Try on'}
                  </button>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-zinc-600 mt-1">Optional — describes what the artist wears; verses carry look A, choruses B, bridge C. Attach wardrobe photos via Reference images.</p>
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={planReview}
                onChange={(e) => setPlanReview(e.target.checked)}
                disabled={isActive}
              />
              <span className="text-xs text-zinc-200 font-medium">Review the plan first — see and edit every shot before anything renders (free)</span>
            </label>
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
            <div>
              <label className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Format</label>
              <select
                value={aspect}
                onChange={(e) => setAspect(e.target.value)}
                disabled={isActive}
                className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-2 text-xs text-zinc-200 disabled:opacity-50"
              >
                <option value="16:9">16:9 — YouTube / screens</option>
                <option value="9:16">9:16 — TikTok / Reels / Shorts</option>
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
            disabled={!audioPath || starting || isActive}
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
              {balance !== null ? ` Balance: ${formatPoints(balance)}.` : ''}
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
                    <span className="px-2 py-1 rounded-md bg-zinc-800 text-zinc-300">{pluralize(run.sectionCount, 'section')}</span>
                  )}
                  <span className="px-2 py-1 rounded-md bg-zinc-800 text-zinc-300">
                    {run.lyricsWordCount != null ? `lyrics: ${pluralize(run.lyricsWordCount, 'word')}` : 'no lyrics detected'}
                  </span>
                  <span className="px-2 py-1 rounded-md bg-zinc-800 text-zinc-300">{pluralize(run.shots.length, 'shot')}</span>
                </div>
              )}

              {/* #69: the song map — sections colored + labeled, energy as height,
                  click a block to HEAR that part; shots aligned beneath on the
                  same time scale. The musician finally sees their song. */}
              {run.sections && run.sections.length > 0 && run.songSeconds != null && run.songSeconds > 0 && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] text-zinc-400 font-medium">Song map — click a section to hear it</span>
                    {audition && (
                      <button
                        onClick={() => { auditionRef.current?.pause(); setAudition(null) }}
                        className="text-[10px] text-amber-300 hover:text-amber-200"
                      >
                        ■ stop
                      </button>
                    )}
                  </div>
                  <div className="relative h-12 flex items-end gap-px">
                    {run.sections.map((sec, i) => {
                      const width = ((sec.end - sec.start) / run.songSeconds!) * 100
                      const isChorus = sec.label.toLowerCase().includes('chorus')
                      const active = audition?.index === i
                      return (
                        <button
                          key={i}
                          title={`${sec.label} · ${sec.start.toFixed(0)}–${sec.end.toFixed(0)}s — click to audition`}
                          onClick={() => {
                            const el = auditionRef.current
                            if (!el) return
                            if (active) { el.pause(); setAudition(null); return }
                            el.currentTime = sec.start
                            void el.play()
                            setAudition({ start: sec.start, end: sec.end, index: i })
                          }}
                          className={`relative rounded-t-sm transition-colors ${
                            active
                              ? 'bg-amber-400'
                              : isChorus
                                ? 'bg-amber-500/70 hover:bg-amber-400/80'
                                : 'bg-zinc-600/80 hover:bg-zinc-500'
                          } ${active ? 'animate-pulse' : ''}`}
                          style={{ width: `${width}%`, height: `${Math.max(20, Math.round(sec.energy * 100))}%` }}
                        >
                          {width > 6 && (
                            <span className="absolute inset-x-0 -bottom-0.5 text-center text-[8px] leading-none text-zinc-950/90 font-semibold truncate px-0.5">
                              {sec.label}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                  {run.shots.length > 0 && (
                    <div className="relative h-2 mt-1.5 rounded-sm bg-zinc-800/60 overflow-hidden">
                      {run.shots.map((sh) => (
                        <div
                          key={sh.index}
                          className={`absolute top-0 h-full ${SHOT_COLOR[sh.status].split(' ')[0]}`}
                          style={{
                            left: `${(sh.start / run.songSeconds!) * 100}%`,
                            width: `${Math.max(0.4, ((sh.end - sh.start) / run.songSeconds!) * 100 - 0.15)}%`,
                          }}
                          title={`#${sh.index + 1} · ${sh.sectionLabel}`}
                        />
                      ))}
                    </div>
                  )}
                  <audio
                    ref={auditionRef}
                    src={toImgSrc(run.audioPath)}
                    onTimeUpdate={(e) => {
                      const el = e.currentTarget
                      if (audition && el.currentTime >= audition.end) {
                        el.pause()
                        setAudition(null)
                      }
                    }}
                    onEnded={() => setAudition(null)}
                    className="hidden"
                  />
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
                  <Film className="h-3 w-3" /> Open partial cut in editor ({pluralize(shotsDone, 'shot')})
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

              {/* #62: the plan — reviewable + editable BEFORE anything renders or bills */}
              {run.phase === 'plan_ready' && (
                <div className="rounded-xl border border-amber-500/40 bg-zinc-900/70 overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between gap-3">
                    <div className="text-xs text-zinc-300">
                      <span className="font-semibold text-amber-300">The plan</span> — {pluralize(run.shots.length, 'shot')}
                      {(() => {
                        const secs = run.shots.reduce((t, sh) => t + sh.generateSeconds, 0)
                        const est = estimateCloudPoints(run.model, run.resolution, secs)
                        if (est) {
                          const kfPts = run.storyboard ? (KEYFRAME_MODELS.find((k) => k.id === imageModel)?.pts ?? 0) * run.shots.length : 0
                          return ` · ≈ ${formatPoints(est.points + kfPts)} when you start${est.approx ? ' (estimate)' : ''}`
                        }
                        return ' · free on your GPU'
                      })()}
                      <span className="block text-[10px] text-zinc-500 mt-0.5">Nothing renders or bills until you press Start. Edit any prompt below.</span>
                    </div>
                    <button
                      onClick={approvePlan}
                      className="shrink-0 text-xs text-zinc-950 font-semibold px-3 py-1.5 rounded-lg bg-emerald-400 hover:bg-emerald-300 transition-colors"
                    >
                      Start {run.storyboard ? 'frames' : 'generating'} →
                    </button>
                  </div>
                  <div className="max-h-80 overflow-y-auto divide-y divide-zinc-800/70">
                    {run.shots.map((sh) => (
                      <div key={sh.index} className="px-4 py-2 flex gap-3 items-start">
                        <div className="w-24 shrink-0 pt-1">
                          <div className="text-[11px] text-zinc-300 font-medium">#{sh.index + 1} · {sh.shotType}</div>
                          <div className="text-[10px] text-zinc-500">{sh.sectionLabel}</div>
                          <div className="text-[10px] text-zinc-600 tabular-nums">{sh.start.toFixed(1)}–{sh.end.toFixed(1)}s · {sh.generateSeconds}s gen</div>
                        </div>
                        <textarea
                          value={planEdits[sh.index] ?? sh.prompt}
                          onChange={(e) => setPlanEdits((prev) => ({ ...prev, [sh.index]: e.target.value }))}
                          rows={2}
                          className="flex-1 bg-zinc-950/70 border border-zinc-800 rounded-md px-2 py-1 text-[11px] text-zinc-200 resize-y focus:outline-none focus:border-amber-500/60"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Clapper slate: how long this is going to take */}
              {['generating', 'storyboarding'].includes(run.phase) && (() => {
                const perShot = LOCAL_MODELS.has(run.model)
                  ? (resolution === '1080p' ? 150 : 90)
                  : 50
                const remainingShots = run.shots.filter((sh) => sh.status !== 'complete').length
                const keyframesLeft = run.phase === 'storyboarding'
                  ? run.shots.filter((sh) => !sh.keyframePath).length
                  : 0
                const secondsLeft = run.phase === 'storyboarding'
                  ? keyframesLeft * 20
                  : remainingShots * perShot
                const mins = Math.max(1, Math.round(secondsLeft / 60))
                return (
                  <div className="rounded-xl border border-zinc-700 overflow-hidden">
                    <div
                      className="h-4"
                      style={{
                        background:
                          'repeating-linear-gradient(-45deg, #18181b 0 14px, #e4e4e7 14px 28px)',
                      }}
                    />
                    <div className="bg-zinc-900 px-4 py-2.5 flex items-center justify-between">
                      <div className="text-[11px] text-zinc-400 uppercase tracking-widest font-semibold">
                        {run.phase === 'storyboarding' ? 'Frames' : 'Rolling'} — {run.phase === 'storyboarding' ? keyframesLeft : remainingShots} to go
                      </div>
                      <div className="text-sm text-amber-300 font-semibold tabular-nums">
                        ≈ {mins} min left
                      </div>
                    </div>
                    <div className="bg-zinc-900 px-4 pb-2 text-[10px] text-zinc-600">
                      {LOCAL_MODELS.has(run.model)
                        ? `~${perShot}s per shot on your GPU, one at a time`
                        : `~${perShot}s per shot on fal (parallel-queued)`}
                    </div>
                  </div>
                )
              })()}

              {/* Shot strip. Mid-run: live status + click-to-watch. On a
                  finished video: click shots to mark them for a reroll (#63). */}
              {run.shots.length > 0 && run.phase !== 'plan_ready' && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-zinc-400">
                      {run.phase === 'complete'
                        ? 'Shots — click any to mark for a reroll; new takes re-assemble the video'
                        : `Shots: ${shotsDone}/${run.shots.length} rendered`}
                    </span>
                    {run.phase === 'complete' ? (
                      rerollSelection.size > 0 && (
                        <div className="flex items-center gap-2">
                          <button onClick={() => setRerollSelection(new Set())} className="text-[11px] text-zinc-500 hover:text-white">
                            Clear
                          </button>
                          <button
                            onClick={rerollShots}
                            className="text-[11px] text-zinc-950 font-medium px-2.5 py-1 rounded-lg bg-amber-500 hover:bg-amber-400 transition-colors"
                          >
                            Reroll {rerollSelection.size} shot{rerollSelection.size === 1 ? '' : 's'}
                            {(() => {
                              const secs = run.shots.filter((sh) => rerollSelection.has(sh.index)).reduce((t, sh) => t + sh.generateSeconds, 0)
                              const est = estimateCloudPoints(run.model, run.resolution, secs)
                              return est ? ` · ≈ ${formatPoints(est.points)}` : ' · free'
                            })()}
                          </button>
                        </div>
                      )
                    ) : (
                      (() => {
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
                      })()
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {run.shots.map((s) => (
                      <button
                        key={s.index}
                        onClick={() => {
                          if (run.phase === 'complete') {
                            setRerollSelection((prev) => {
                              const next = new Set(prev)
                              if (next.has(s.index)) next.delete(s.index)
                              else next.add(s.index)
                              return next
                            })
                          } else if (s.resultPath) {
                            setPreviewShot(s)
                          }
                        }}
                        title={`#${s.index + 1} · ${s.sectionLabel} · ${s.shotType} · ${s.status}${s.error ? ` — ${s.error}` : ''}${run.phase === 'complete' ? ' — click to mark for reroll' : s.resultPath ? ' — click to watch' : ''}\n${s.prompt}`}
                        className={`h-5 rounded-sm ${SHOT_COLOR[s.status]} transition-colors ${
                          rerollSelection.has(s.index) && run.phase === 'complete'
                            ? 'ring-1 ring-red-400'
                            : run.phase === 'complete' || s.resultPath
                              ? 'cursor-pointer hover:ring-1 hover:ring-white/60'
                              : 'cursor-default'
                        }`}
                        style={{ width: `${Math.max(14, Math.min(56, (s.end - s.start) * 6))}px` }}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Mid-render shot preview: catch a doomed concept 5 minutes in,
                  not after an hour of assembly (#56) */}
              {previewShot?.resultPath && (
                <div className="fixed inset-0 z-[120] bg-black/80 flex items-center justify-center p-8" onClick={() => setPreviewShot(null)}>
                  <div className="max-w-2xl w-full" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-zinc-300">
                        Shot {previewShot.index + 1} · {previewShot.sectionLabel} · {previewShot.shotType}
                      </span>
                      <button onClick={() => setPreviewShot(null)} className="text-xs text-zinc-400 hover:text-white">Close</button>
                    </div>
                    <video src={toImgSrc(previewShot.resultPath)} controls autoPlay className="w-full rounded-xl border border-zinc-700 bg-black" />
                    <p className="mt-2 text-[11px] text-zinc-500 line-clamp-2">{previewShot.prompt}</p>
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
