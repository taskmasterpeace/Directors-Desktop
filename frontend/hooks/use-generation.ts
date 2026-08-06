import { useState, useCallback, useRef, useEffect } from 'react'
import type { GenerationSettings } from '../components/SettingsPanel'
import { useAppSettings } from '../contexts/AppSettingsContext'
import { migrateImageModelId } from '../lib/image-models'
import { recordModelTiming } from '../lib/model-timing'

export interface QueueJob {
  id: string
  type: string
  model: string
  params: Record<string, unknown>
  status: string
  slot: string
  progress: number
  phase: string
  result_paths: string[]
  error: string | null
  created_at: string
  batch_id: string | null
  batch_index: number
  tags: string[]
}

interface GenerationState {
  isGenerating: boolean
  progress: number
  statusMessage: string
  elapsedSeconds: number
  estimatedSeconds: number | null
  videoUrl: string | null
  videoPath: string | null  // Original file path for upscaling
  imageUrl: string | null
  imageUrls: string[]  // For multiple image variations
  error: string | null
  jobs: QueueJob[]
  lastModel: string | null
  /** Model id of the job currently in flight (null when idle). */
  activeModel: string | null
  /** True when this render pays a local-engine cold load (model not resident). */
  coldStart: boolean
}

// Estimated generation times (seconds) based on benchmark data
// LTX local: RTX 4090, FFN chunk=8, TeaCache=0.03, prompt pre-encode (2026-08)
// Cloud rows are seed estimates that should be tuned from real completions.
export const VIDEO_TIME_ESTIMATES: Record<string, Record<string, Record<string, number>>> = {
  'ltx-fast': {
    '480p': { '2': 35, '3': 45, '4': 50, '5': 55, '6': 60, '8': 65, '10': 220 },
    '512p': { '2': 40, '3': 50, '4': 55, '5': 65, '6': 65, '7': 65, '8': 65, '10': 275 },
    '540p': { '2': 40, '3': 50, '4': 55, '5': 65, '6': 65, '7': 65, '8': 65, '10': 275 },
    '720p': { '2': 40, '3': 60, '5': 90 },
  },
  'seedance-1.5-pro': {
    '720p': { '5': 60, '10': 120 },
  },
  'seedance-2.0': {
    '480p': { '5': 60, '10': 110, '15': 160 },
    '720p': { '5': 70, '10': 130, '15': 190 },
    '1080p': { '5': 110, '10': 200, '15': 290 },
  },
  // Local MiniMax H3 on a 4090, WARM (int8), fitted to the 29-run battery. Cold
  // adds ~9 min for the first-of-session model load. 1080p maps to H3's 720p
  // tier under the hood (H3's native-local ceiling here).
  'h3-local': {
    '480p': { '5': 120, '10': 390, '15': 780 },
    '540p': { '5': 180, '10': 570, '15': 1140 },
    '720p': { '5': 480, '10': 1500, '15': 3120 },
    '1080p': { '5': 480, '10': 1500, '15': 3120 },
  },
  // Local LTX-2.3 (ComfyUI, nvfp4, distilled 8-step) on a 4090, WARM.
  // Recalibrated 2026-08-05 from the measured 10s matrix: warm 480p 10s clips
  // ran 90–100s with or without a reference. The first-of-session render pays
  // the cold load instead (see LOCAL_COMFY_ENGINES.coldLoadSeconds).
  'ltx-comfy': {
    '480p': { '2': 60, '5': 80, '10': 100, '15': 140 },
    '720p': { '5': 240, '10': 420, '15': 650 },
    '1080p': { '5': 240, '10': 420, '15': 650 },
  },
}

/**
 * The local ComfyUI engines share one instance on :8188; /health reports which
 * profile is up (comfy_running + comfy_profile). A render on the matching
 * engine is WARM; anything else pays a measured multi-minute cold load that
 * the estimates table deliberately excludes.
 * Cold loads measured 2026-08-05: H3 +~5.5min (661s cold vs 340s warm),
 * LTX +~15min (1012s cold vs 90s warm).
 */
export const LOCAL_COMFY_ENGINES: Record<string, { profile: string; coldLoadSeconds: number }> = {
  'h3-local': { profile: 'h3', coldLoadSeconds: 330 },
  'ltx-comfy': { profile: 'ltx', coldLoadSeconds: 900 },
}

export interface ComfyEngineStatus {
  running: boolean
  profile: string | null
}

export interface GenerateOptions {
  /** Ownership labels stored on the queue job, e.g. ["project:<id>"] from
   *  Gen Space or ["playground"] — lets surfaces adopt completed renders
   *  after navigation and lets the Gallery group by owner. */
  tags?: string[]
}

/** True when the job's engine will render warm given the current comfy state. */
export function isComfyWarmFor(model: string, comfy: ComfyEngineStatus | null | undefined): boolean {
  const engine = LOCAL_COMFY_ENGINES[model]
  if (!engine) return true // not a local comfy engine — no cold-load concept here
  return !!comfy && comfy.running && comfy.profile === engine.profile
}

export function getEstimatedSeconds(job: QueueJob, comfy?: ComfyEngineStatus | null): number | null {
  const params = job.params
  const resolution = (params.resolution as string) || '512p'
  const duration = String(params.duration || '2')
  const model = (params.model as string) || job.model || 'ltx-fast'
  // A cold local comfy engine pays the model load on top of the warm estimate.
  const engine = LOCAL_COMFY_ENGINES[model]
  const coldExtra = engine && comfy !== undefined && !isComfyWarmFor(model, comfy)
    ? engine.coldLoadSeconds
    : 0

  // Try model-specific estimates first, then fall back to ltx-fast
  const modelEstimates = VIDEO_TIME_ESTIMATES[model] || VIDEO_TIME_ESTIMATES['ltx-fast']
  if (!modelEstimates) return null
  const byDuration = modelEstimates[resolution]
  if (!byDuration) return null

  // Find exact match or interpolate from nearest lower
  if (byDuration[duration]) return byDuration[duration] + coldExtra
  const durations = Object.keys(byDuration).map(Number).sort((a, b) => a - b)
  const dur = Number(duration)
  // Find bracketing values for simple interpolation
  let lower = durations[0], upper = durations[durations.length - 1]
  for (const d of durations) {
    if (d <= dur) lower = d
    if (d >= dur && upper === durations[durations.length - 1]) upper = d
  }
  if (dur <= lower) return byDuration[String(lower)] + coldExtra
  if (dur >= upper) return byDuration[String(upper)] + coldExtra
  // Linear interpolation
  const ratio = (dur - lower) / (upper - lower)
  return Math.round(byDuration[String(lower)] + ratio * (byDuration[String(upper)] - byDuration[String(lower)])) + coldExtra
}

interface UseGenerationReturn extends GenerationState {
  generate: (prompt: string, imagePath: string | null, settings: GenerationSettings, audioPath?: string | null, lastFramePath?: string | null, opts?: GenerateOptions) => Promise<void>
  generateImage: (prompt: string, settings: GenerationSettings, opts?: GenerateOptions) => Promise<void>
  editImage: (prompt: string, sourceImagePath: string, settings: GenerationSettings, strength?: number, opts?: GenerateOptions) => Promise<void>
  cancel: () => void
  reset: () => void
  clearQueue: () => void
}

const IMAGE_SHORT_SIDE_BY_RESOLUTION: Record<string, number> = {
  '1080p': 1080,
  '1440p': 1440,
  '2048p': 2048,
}

const IMAGE_ASPECT_RATIO_VALUE: Record<string, number> = {
  '1:1': 1,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '4:3': 4 / 3,
  '3:4': 3 / 4,
  '4:5': 4 / 5,
  '21:9': 21 / 9,
  // gpt-image-2's ratios (the wardrobe/character quick modes run at 3:2) —
  // missing entries here threw "Unsupported image aspect ratio mapping" mid-submit.
  '3:2': 3 / 2,
  '2:3': 2 / 3,
  // Camera Angle's "match_input_image": dimensions are only used to snap an
  // aspect for the hosted call, and the camera route gets its real aspect via
  // modelParams — square is a safe neutral here.
  match_input_image: 1,
}

/**
 * Which image model a job runs on: a per-surface override wins, otherwise the
 * global app setting. Retired ids are migrated so a stale stored model can never
 * strand generation (see lib/image-models.ts).
 */
function resolveImageModelId(settings: GenerationSettings, globalModel: string | undefined): string {
  return migrateImageModelId(settings.imageModel || globalModel)
}

function getImageDimensions(settings: GenerationSettings): { width: number; height: number } {
  // Unknown labels degrade to sane defaults instead of throwing — killing the
  // whole generation over a display-label mapping is worse than a slightly-off
  // aspect (the backend re-snaps to what the model supports anyway).
  const shortSide = IMAGE_SHORT_SIDE_BY_RESOLUTION[settings.imageResolution] ?? 1080
  const ratio = IMAGE_ASPECT_RATIO_VALUE[settings.imageAspectRatio] ?? 16 / 9

  if (ratio >= 1) {
    return { width: Math.round(shortSide * ratio), height: shortSide }
  }
  return { width: shortSide, height: Math.round(shortSide / ratio) }
}

// Map phase to user-friendly message
function getPhaseMessage(phase: string): string {
  switch (phase) {
    case 'queued':
      return 'Queued — waiting...'
    case 'starting':
      return 'Starting up...'
    case 'validating_request':
      return 'Validating request...'
    case 'uploading_image':
      return 'Uploading image...'
    case 'uploading_audio':
      return 'Uploading audio...'
    case 'preparing_gpu':
      return 'Preparing GPU...'
    case 'unloading_video_model':
      return 'Unloading video model...'
    case 'unloading_image_model':
      return 'Swapping image model — clearing the old one...'
    case 'cleaning_gpu':
      return 'Freeing up video memory...'
    case 'loading_model':
      return 'Loading model...'
    case 'loading_image_model':
      return 'Loading image model (this can take a moment)...'
    case 'loading_video_model':
      return 'Loading video model...'
    case 'loading_lora':
      return 'Loading LoRA weights...'
    case 'encoding_text':
      return 'Encoding prompt...'
    case 'encoding_image':
      return 'Encoding source image...'
    case 'inference':
      return 'Generating...'
    case 'downloading_output':
      return 'Downloading output...'
    case 'decoding':
      return 'Decoding video...'
    case 'generating_segment':
      return 'Generating segment...'
    case 'extracting_frame':
      return 'Extracting last frame...'
    case 'concatenating':
      return 'Joining segments...'
    case 'conforming_duration':
      return 'Trimming to exact length...'
    case 'complete':
      return 'Complete!'
    default:
      return 'Processing...'
  }
}

const POLL_INTERVAL_MS = 500
const POLL_TIMEOUT_MS = 8000
// ~5s of consecutive failures before we declare the backend dead.
const MAX_POLL_FAILURES = 10

// Convert a file system path to a file:// URL
function pathToFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
}

export function useGeneration(): UseGenerationReturn {
  const { settings: appSettings, forceApiGenerations, refreshSettings } = useAppSettings()
  const [state, setState] = useState<GenerationState>({
    isGenerating: false,
    progress: 0,
    statusMessage: '',
    elapsedSeconds: 0,
    estimatedSeconds: null,
    videoUrl: null,
    videoPath: null,
    imageUrl: null,
    imageUrls: [],
    error: null,
    jobs: [],
    lastModel: null,
    activeModel: null,
    coldStart: false,
  })

  // Track the most recently submitted job ID for cancel
  const activeJobIdRef = useRef<string | null>(null)
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startedAtRef = useRef<number | null>(null)
  // Last-known local ComfyUI engine state (from /health) — drives cold-load
  // honesty in the ETA and the "first render loads the model" note.
  const comfyRef = useRef<ComfyEngineStatus | null>(null)

  const refreshComfyState = useCallback(async () => {
    try {
      const backendUrl = await window.electronAPI.getBackendUrl()
      const res = await fetch(`${backendUrl}/health`)
      if (!res.ok) return
      const h = (await res.json()) as { comfy_running?: boolean; comfy_profile?: string | null }
      comfyRef.current = { running: !!h.comfy_running, profile: h.comfy_profile ?? null }
    } catch {
      // keep the previous reading — comfy state is a UX nicety, never fatal
    }
  }, [])
  // Consecutive poll failures — used to detect a dead backend instead of
  // spinning forever in "Generating…".
  const pollFailuresRef = useRef(0)

  const stopPolling = useCallback(() => {
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current)
      pollTimeoutRef.current = null
    }
  }, [])

  // Poll the queue status with a self-scheduling loop (no overlapping requests)
  // and a per-request timeout. Stops when our job finishes, when the user
  // cancels, or when the backend has been unreachable for too long.
  const startPolling = useCallback(() => {
    if (pollTimeoutRef.current) return // already polling
    pollFailuresRef.current = 0

    const scheduleNext = () => {
      pollTimeoutRef.current = setTimeout(() => void runPoll(), POLL_INTERVAL_MS)
    }

    const runPoll = async () => {
      pollTimeoutRef.current = null

      let jobs: QueueJob[]
      try {
        const backendUrl = await window.electronAPI.getBackendUrl()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS)
        let res: Response
        try {
          res = await fetch(`${backendUrl}/api/queue/status`, { signal: controller.signal })
        } finally {
          clearTimeout(timer)
        }
        if (!res.ok) throw new Error(`status ${res.status}`)
        const data: unknown = await res.json()
        if (!data || !Array.isArray((data as { jobs?: unknown }).jobs)) {
          throw new Error('malformed queue status response')
        }
        jobs = (data as { jobs: QueueJob[] }).jobs
      } catch {
        pollFailuresRef.current += 1
        // Only treat repeated failures as fatal while we actually have a job in
        // flight; otherwise just stop quietly.
        if (activeJobIdRef.current && pollFailuresRef.current >= MAX_POLL_FAILURES) {
          activeJobIdRef.current = null
          startedAtRef.current = null
          setState(prev => ({
            ...prev,
            isGenerating: false,
            statusMessage: '',
            error: 'Lost connection to the generation backend. It may have crashed — check the logs.',
          }))
          return // stop polling
        }
        if (activeJobIdRef.current) scheduleNext()
        return
      }

      pollFailuresRef.current = 0

      // Derive progress from the most-recently active job
      const activeId = activeJobIdRef.current
      const activeJob = activeId ? jobs.find(j => j.id === activeId) : null

      // Only consider *our* active job as running — stale/other jobs shouldn't block the UI
      const hasRunning = activeJob
        ? (activeJob.status === 'queued' || activeJob.status === 'running')
        : false

      setState(prev => {
        const next = { ...prev, jobs }

        if (activeJob) {
          next.progress = activeJob.progress
          next.statusMessage = getPhaseMessage(activeJob.phase)

          // Track elapsed time from when the job started running
          if (activeJob.status === 'running' && !startedAtRef.current) {
            startedAtRef.current = Date.now()
          }
          if (startedAtRef.current) {
            next.elapsedSeconds = Math.floor((Date.now() - startedAtRef.current) / 1000)
          }

          // Compute estimated total time for video jobs
          if ((activeJob.type === 'video' || activeJob.type === 'long_video') && next.estimatedSeconds === null) {
            next.estimatedSeconds = getEstimatedSeconds(activeJob, comfyRef.current)
          }

          if (activeJob.status === 'complete') {
            // Feed the personal-average marker: how long this model ACTUALLY took.
            if (startedAtRef.current) {
              recordModelTiming(activeJob.model, Date.now() - startedAtRef.current)
            }
            next.isGenerating = hasRunning
            next.progress = 100
            next.statusMessage = 'Complete!'

            next.lastModel = activeJob.model

            if ((activeJob.type === 'video' || activeJob.type === 'long_video') && activeJob.result_paths.length > 0) {
              const rawPath = activeJob.result_paths[0]
              next.videoUrl = pathToFileUrl(rawPath)
              next.videoPath = rawPath
            } else if (activeJob.type === 'image' && activeJob.result_paths.length > 0) {
              const fileUrls = activeJob.result_paths.map(pathToFileUrl)
              next.imageUrl = fileUrls[0]
              next.imageUrls = fileUrls
            }

            // Clear active job so we don't keep overwriting state
            activeJobIdRef.current = null
            startedAtRef.current = null
          } else if (activeJob.status === 'error') {
            next.isGenerating = hasRunning
            next.error = activeJob.error || 'Generation failed'
            activeJobIdRef.current = null
            startedAtRef.current = null
          } else if (activeJob.status === 'cancelled') {
            next.isGenerating = hasRunning
            next.statusMessage = 'Cancelled'
            activeJobIdRef.current = null
            startedAtRef.current = null
          }
        } else {
          next.isGenerating = hasRunning
        }

        return next
      })

      // Keep polling only while our job is still active.
      if (hasRunning) scheduleNext()
    }

    void runPoll()
  }, [])

  // Clean up polling on unmount
  useEffect(() => {
    return () => stopPolling()
  }, [stopPolling])

  // Re-attach to a still-running job after navigation/remount. Without this,
  // leaving the view orphaned the render: the backend kept going but the UI
  // forgot it, and the user couldn't tell whether anything was still running.
  const reattachTriedRef = useRef(false)
  useEffect(() => {
    if (reattachTriedRef.current) return
    reattachTriedRef.current = true
    void (async () => {
      try {
        const backendUrl = await window.electronAPI.getBackendUrl()
        const res = await fetch(`${backendUrl}/api/queue/status`)
        if (!res.ok) return
        const data = (await res.json()) as { jobs?: QueueJob[] }
        const jobs = Array.isArray(data.jobs) ? data.jobs : []
        const active = jobs
          .filter(j => j.status === 'queued' || j.status === 'running')
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0]
        if (!active || activeJobIdRef.current) return
        await refreshComfyState()
        activeJobIdRef.current = active.id
        const startedMs = Date.parse(active.created_at)
        startedAtRef.current = Number.isFinite(startedMs) ? startedMs : Date.now()
        setState(prev => ({
          ...prev,
          isGenerating: true,
          activeModel: active.model,
          coldStart: !isComfyWarmFor(active.model, comfyRef.current),
          statusMessage: getPhaseMessage(active.phase),
          estimatedSeconds: getEstimatedSeconds(active, comfyRef.current),
          error: null,
        }))
        startPolling()
      } catch {
        // backend not up yet — normal during app boot
      }
    })()
  }, [startPolling, refreshComfyState])

  const generate = useCallback(async (
    prompt: string,
    imagePath: string | null,
    settings: GenerationSettings,
    audioPath?: string | null,
    lastFramePath?: string | null,
    opts?: GenerateOptions,
  ) => {
    // Seedance 1.5 Pro requires a Replicate API key
    if (settings.model === 'seedance-1.5-pro' && !appSettings.hasReplicateApiKey) {
      window.dispatchEvent(new CustomEvent('open-api-gateway', {
        detail: {
          requiredKeys: ['replicate'],
          title: 'Connect Replicate',
          description: 'A Replicate API key is required to use Seedance 1.5 Pro.',
          blocking: false,
        },
      }))
      return
    }

    // Seedance 2.0 runs on fal and requires a fal API key
    const isSeedance2 = settings.model === 'seedance-2.0' || settings.model === 'seedance-2.0-fast'
    if (isSeedance2 && !appSettings.hasFalApiKey) {
      window.dispatchEvent(new CustomEvent('open-api-gateway', {
        detail: {
          requiredKeys: ['fal'],
          title: 'Connect fal',
          description: 'A fal API key is required to use Seedance 2.0.',
          blocking: false,
        },
      }))
      return
    }

    const isSeedance = settings.model === 'seedance-1.5-pro' || isSeedance2

    const statusMsg = settings.model === 'pro'
      ? 'Loading Pro model & generating...'
      : isSeedance
        ? 'Generating video with Seedance...'
        : 'Generating video...'

    startedAtRef.current = null
    // Fresh comfy-engine reading so the ETA and cold-start note are honest for
    // THIS render, not a stale idea of what was loaded earlier.
    await refreshComfyState()
    const coldStart = !isComfyWarmFor(settings.model, comfyRef.current)
    setState(prev => ({
      ...prev,
      isGenerating: true,
      progress: 0,
      statusMessage: statusMsg,
      elapsedSeconds: 0,
      estimatedSeconds: null,
      videoUrl: null,
      videoPath: null,
      imageUrl: null,
      imageUrls: [],
      error: null,
      activeModel: settings.model,
      coldStart,
    }))

    try {
      const backendUrl = await window.electronAPI.getBackendUrl()

      // Use the local long_video pipeline for durations > 8s with a source image.
      // Cloud Seedance models handle long durations themselves, so never route them here.
      const useLongVideo = !isSeedance && settings.duration > 8 && imagePath && !audioPath && !lastFramePath

      const params: Record<string, unknown> = useLongVideo
        ? {
            prompt,
            imagePath,
            targetDuration: settings.duration,
            segmentDuration: 4,
            resolution: settings.videoResolution,
            aspectRatio: settings.aspectRatio || '16:9',
            fps: settings.fps,
            cameraMotion: settings.cameraMotion,
            ...(settings.loraPath ? { loraPath: settings.loraPath, loraWeight: settings.loraWeight ?? 1.0 } : {}),
            ...(settings.exactDuration ? { exactDuration: true } : {}),
          }
        : {
            prompt,
            duration: String(settings.duration),
            resolution: settings.videoResolution,
            fps: String(settings.fps),
            audio: String(settings.audio),
            cameraMotion: settings.cameraMotion,
            aspectRatio: settings.aspectRatio || '16:9',
            ...(imagePath ? { imagePath } : {}),
            ...(audioPath ? { audioPath } : {}),
            ...(lastFramePath ? { lastFramePath } : {}),
            ...(settings.referenceImagePaths?.length ? { referenceImagePaths: settings.referenceImagePaths } : {}),
            ...(isSeedance2 && settings.audioReferencePaths?.length ? { audioReferencePaths: settings.audioReferencePaths } : {}),
            ...(isSeedance2 && settings.videoReferencePaths?.length ? { videoReferencePaths: settings.videoReferencePaths } : {}),
            ...(settings.exactDuration ? { exactDuration: true } : {}),
            ...(settings.loraPath ? { loraPath: settings.loraPath, loraWeight: settings.loraWeight ?? 1.0 } : {}),
            // Local LTX-2.3 (ComfyUI) LoRA: stacked on the always-on distilled LoRA.
            ...(settings.model === 'ltx-comfy' && settings.ltxLora
              ? { modelParams: { ltxLora: settings.ltxLora, ltxLoraStrength: settings.ltxLoraStrength ?? 1.0 } }
              : {}),
          }

      const response = await fetch(`${backendUrl}/api/queue/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: useLongVideo ? 'long_video' : 'video',
          model: settings.model,
          params,
          ...(opts?.tags?.length ? { tags: opts.tags } : {}),
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(errorText || 'Failed to submit video generation job')
      }

      const result: { id: string; status: string } = await response.json()
      activeJobIdRef.current = result.id
      startPolling()
    } catch (error) {
      setState(prev => ({
        ...prev,
        isGenerating: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }))
    }
  }, [appSettings.hasReplicateApiKey, appSettings.hasFalApiKey, startPolling, refreshComfyState])

  const cancel = useCallback(async () => {
    const jobId = activeJobIdRef.current
    if (!jobId) return

    // Make cancel authoritative: clear our active job and stop the poll loop up
    // front so an in-flight tick can't flip the UI back to "Generating…".
    activeJobIdRef.current = null
    startedAtRef.current = null
    stopPolling()
    setState(prev => ({
      ...prev,
      isGenerating: false,
      statusMessage: 'Cancelled',
    }))

    try {
      const backendUrl = await window.electronAPI.getBackendUrl()
      await fetch(`${backendUrl}/api/queue/cancel/${jobId}`, {
        method: 'POST',
      })
    } catch {
      // Ignore errors from cancel request — the UI is already in a terminal state.
    }
  }, [stopPolling])

  const generateImage = useCallback(async (
    prompt: string,
    settings: GenerationSettings,
    opts?: GenerateOptions,
  ) => {
    if (forceApiGenerations) {
      try {
        const backendUrl = await window.electronAPI.getBackendUrl()
        const response = await fetch(`${backendUrl}/api/settings`)
        if (response.ok) {
          const payload = await response.json()
          if (!payload?.hasReplicateApiKey) {
            void refreshSettings()
            window.dispatchEvent(new CustomEvent('open-api-gateway', {
              detail: {
                requiredKeys: ['replicate'],
                title: 'Connect Replicate',
                description: 'Replicate is required for generating images when API generations are enabled.',
                blocking: false,
              },
            }))
            return
          }
        }
      } catch {
        if (!appSettings.hasReplicateApiKey) {
          window.dispatchEvent(new CustomEvent('open-api-gateway', {
            detail: {
              requiredKeys: ['replicate'],
              title: 'Connect Replicate',
              description: 'Replicate is required for generating images when API generations are enabled.',
              blocking: false,
            },
          }))
          return
        }
      }
    }

    const numImages = settings.variations || 1

    startedAtRef.current = null
    setState(prev => ({
      ...prev,
      isGenerating: true,
      progress: 0,
      statusMessage: numImages > 1 ? `Generating ${numImages} images...` : 'Generating image...',
      elapsedSeconds: 0,
      estimatedSeconds: null,
      videoUrl: null,
      videoPath: null,
      imageUrl: null,
      imageUrls: [],
      error: null,
      activeModel: settings.imageModel ?? null,
      coldStart: false,
    }))

    try {
      const backendUrl = await window.electronAPI.getBackendUrl()

      const dims = getImageDimensions(settings)
      const numSteps = settings.imageSteps || 4

      const response = await fetch(`${backendUrl}/api/queue/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'image',
          model: resolveImageModelId(settings, appSettings.imageModel),
          params: {
            prompt: settings.loraTriggerPhrase && settings.loraTriggerMode !== 'off'
              ? settings.loraTriggerMode === 'append'
                ? `${prompt}, ${settings.loraTriggerPhrase}`
                : `${settings.loraTriggerPhrase}, ${prompt}`
              : prompt,
            width: dims.width,
            height: dims.height,
            numSteps,
            numImages,
            ...(settings.referenceImagePaths?.length ? { referenceImagePaths: settings.referenceImagePaths } : {}),
            ...(settings.imageModelParams ? { modelParams: settings.imageModelParams } : {}),
            ...(settings.loraPath ? { loraPath: settings.loraPath, loraWeight: settings.loraWeight ?? 1.0 } : {}),
          },
          ...(opts?.tags?.length ? { tags: opts.tags } : {}),
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(errorText || 'Failed to submit image generation job')
      }

      const result: { id: string; status: string } = await response.json()
      activeJobIdRef.current = result.id
      startPolling()
    } catch (error) {
      setState(prev => ({
        ...prev,
        isGenerating: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }))
    }
  }, [appSettings.hasReplicateApiKey, appSettings.imageModel, forceApiGenerations, refreshSettings, startPolling])

  const editImage = useCallback(async (
    prompt: string,
    sourceImagePath: string,
    settings: GenerationSettings,
    strength: number = 0.65,
    opts?: GenerateOptions,
  ) => {
    startedAtRef.current = null
    setState(prev => ({
      ...prev,
      isGenerating: true,
      progress: 0,
      statusMessage: 'Editing image...',
      elapsedSeconds: 0,
      estimatedSeconds: null,
      videoUrl: null,
      videoPath: null,
      imageUrl: null,
      imageUrls: [],
      error: null,
      activeModel: settings.imageModel ?? null,
      coldStart: false,
    }))

    try {
      const backendUrl = await window.electronAPI.getBackendUrl()

      const response = await fetch(`${backendUrl}/api/queue/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'image',
          model: resolveImageModelId(settings, appSettings.imageModel),
          params: {
            prompt: settings.loraTriggerPhrase && settings.loraTriggerMode !== 'off'
              ? settings.loraTriggerMode === 'append'
                ? `${prompt}, ${settings.loraTriggerPhrase}`
                : `${settings.loraTriggerPhrase}, ${prompt}`
              : prompt,
            sourceImagePath,
            strength,
            width: 0,
            height: 0,
            numSteps: settings.imageSteps || 4,
            numImages: 1,
            // The edit source doubles as the reference for Palette models (Camera
            // Angle requires exactly one), so hosted models get an input image too.
            referenceImagePaths: settings.referenceImagePaths?.length
              ? settings.referenceImagePaths
              : [sourceImagePath],
            ...(settings.imageModelParams ? { modelParams: settings.imageModelParams } : {}),
            ...(settings.loraPath ? { loraPath: settings.loraPath, loraWeight: settings.loraWeight ?? 1.0 } : {}),
          },
          ...(opts?.tags?.length ? { tags: opts.tags } : {}),
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(errorText || 'Failed to submit image edit job')
      }

      const result: { id: string; status: string } = await response.json()
      activeJobIdRef.current = result.id
      startPolling()
    } catch (error) {
      setState(prev => ({
        ...prev,
        isGenerating: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }))
    }
  }, [appSettings.imageModel, startPolling])

  const clearQueue = useCallback(async () => {
    try {
      const backendUrl = await window.electronAPI.getBackendUrl()
      const res = await fetch(`${backendUrl}/api/queue/clear`, { method: 'POST' })
      if (res.ok) {
        const data: { jobs: QueueJob[] } = await res.json()
        setState(prev => ({ ...prev, jobs: data.jobs }))
      }
    } catch {
      // Ignore errors
    }
  }, [])

  const reset = useCallback(() => {
    startedAtRef.current = null
    setState({
      isGenerating: false,
      progress: 0,
      statusMessage: '',
      elapsedSeconds: 0,
      estimatedSeconds: null,
      videoUrl: null,
      videoPath: null,
      imageUrl: null,
      imageUrls: [],
      error: null,
      jobs: [],
      lastModel: null,
      activeModel: null,
      coldStart: false,
    })
  }, [])

  return {
    ...state,
    generate,
    generateImage,
    editImage,
    cancel,
    reset,
    clearQueue,
  }
}
