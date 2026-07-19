/**
 * Frame extraction with hardware decode.
 *
 * `extractVideoFrame` is a drop-in replacement for
 * `window.electronAPI.extractVideoFrame` (same signature, same `{path, url}`
 * file-on-disk contract) that decodes the frame in the renderer using an
 * offscreen `<video>` element. In Electron's Chromium that decode path is
 * hardware-accelerated (NVDEC/D3D11 on NVIDIA), so no ffmpeg process spawn, no
 * demux-from-zero — typically an order of magnitude faster for seeks into
 * large files.
 *
 * Any failure (unsupported codec, decode error, seek timeout) falls back to
 * the existing ffmpeg IPC path, and after repeated hardware failures the
 * module prefers ffmpeg for the rest of the session to avoid paying timeouts.
 *
 * The pure helpers are exported for unit tests.
 */
import { logger } from './logger'

/** Clamp a requested seek to a decodable time inside the media. Callers use
 * huge values (e.g. 9999) to mean "the last frame"; ffmpeg errors past EOF,
 * the hardware path lands on the final frame instead. */
export function clampSeekTime(seekTime: number, duration: number, epsilon = 0.05): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  const max = Math.max(0, duration - epsilon)
  if (!Number.isFinite(seekTime) || seekTime < 0) return 0
  return Math.min(seekTime, max)
}

/** Scaled draw size preserving aspect ratio; `targetWidth` mirrors ffmpeg's
 * `scale=w:-2` behaviour (no upscaling guard — ffmpeg upscales too). */
export function scaledDimensions(
  naturalWidth: number,
  naturalHeight: number,
  targetWidth?: number,
): { width: number; height: number } {
  if (naturalWidth <= 0 || naturalHeight <= 0) return { width: 0, height: 0 }
  if (!targetWidth || targetWidth <= 0) return { width: naturalWidth, height: naturalHeight }
  const height = Math.max(1, Math.round((targetWidth / naturalWidth) * naturalHeight))
  return { width: Math.round(targetWidth), height }
}

/** Map ffmpeg's `-q:v` scale (2 ≈ best jpeg) to canvas JPEG quality [0..1]. */
export function jpegQualityFromFfmpegQ(q?: number): number {
  if (q === undefined || !Number.isFinite(q)) return 0.92
  if (q <= 2) return 0.92
  if (q === 3) return 0.85
  return Math.min(0.92, Math.max(0.7, 1 - q * 0.05))
}

/** Temp filename for an extracted frame; keeps the `ltx_frame_` family used by
 * the ffmpeg path so any cleanup logic treats both alike. */
export function tempFrameName(stamp: number, rand: string): string {
  const safeRand = rand.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'x'
  return `ltx_frame_hw_${Math.abs(Math.floor(stamp))}_${safeRand}.jpg`
}

const SEEK_TIMEOUT_MS = 5000
const LOAD_TIMEOUT_MS = 8000
// After this many consecutive hardware failures, stop trying for the session.
const MAX_HW_FAILURES = 2

let consecutiveHwFailures = 0

function hardwarePathEnabled(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    consecutiveHwFailures < MAX_HW_FAILURES
  )
}

function once<K extends keyof HTMLVideoElementEventMap>(
  video: HTMLVideoElement,
  event: K,
  timeoutMs: number,
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const onEvent = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error(`${label} failed: media error`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      video.removeEventListener(event, onEvent)
      video.removeEventListener('error', onError)
    }
    video.addEventListener(event, onEvent, { once: true })
    video.addEventListener('error', onError, { once: true })
  })
}

async function extractFrameHardware(
  videoUrl: string,
  seekTime: number,
  width?: number,
  quality?: number,
): Promise<{ path: string; url: string }> {
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.crossOrigin = 'anonymous'
  try {
    const loaded = once(video, 'loadedmetadata', LOAD_TIMEOUT_MS, 'metadata load')
    video.src = videoUrl
    await loaded

    const target = clampSeekTime(seekTime, video.duration)
    const seeked = once(video, 'seeked', SEEK_TIMEOUT_MS, 'seek')
    video.currentTime = target
    await seeked

    const { width: w, height: h } = scaledDimensions(video.videoWidth, video.videoHeight, width)
    if (w <= 0 || h <= 0) throw new Error('video has no dimensions')

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(video, 0, 0, w, h)

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob produced no data'))),
        'image/jpeg',
        jpegQualityFromFfmpegQ(quality),
      )
    })

    const tempDir = await window.electronAPI.getTempPath()
    const name = tempFrameName(Date.now(), Math.random().toString(36).slice(2))
    const filePath = `${tempDir}\\${name}`
    const saved = await window.electronAPI.saveBinaryFile(filePath, await blob.arrayBuffer())
    if (!saved.success || !saved.path) throw new Error(saved.error || 'failed to save frame')

    const normalized = saved.path.replace(/\\/g, '/')
    const url = normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
    return { path: saved.path, url }
  } finally {
    // Release the decoder immediately rather than waiting for GC.
    video.removeAttribute('src')
    video.load()
  }
}

/**
 * Extract a single frame as a JPEG file on disk. Hardware decode first,
 * ffmpeg IPC as fallback. Same contract as `electronAPI.extractVideoFrame`.
 */
export async function extractVideoFrame(
  videoUrl: string,
  seekTime: number,
  width?: number,
  quality?: number,
): Promise<{ path: string; url: string }> {
  if (hardwarePathEnabled()) {
    try {
      const result = await extractFrameHardware(videoUrl, seekTime, width, quality)
      consecutiveHwFailures = 0
      return result
    } catch (err) {
      consecutiveHwFailures += 1
      logger.warn(
        `Hardware frame extraction failed (${consecutiveHwFailures}/${MAX_HW_FAILURES}), falling back to ffmpeg: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return window.electronAPI.extractVideoFrame(videoUrl, seekTime, width, quality)
}
