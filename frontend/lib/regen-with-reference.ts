/**
 * "Regenerate with reference" — build the render request for re-generating one
 * timeline clip using reference media (a clip, a frame, or a crop) + an
 * optional note, landing as a NEW TAKE on that clip.
 *
 * Pure + framework-free so the render request is unit-tested: the same inputs
 * always produce the same queue-submit body, and the model caps are enforced
 * HERE (before submit) rather than discovered as a late server 400.
 */

// Seedance 2.0 omni-reference caps (mirrors the backend video_generation_handler).
export const SEEDANCE_MAX_SECONDS = 15
export const REF_CAPS = { image: 9, video: 3 } as const

export interface RegenWithRefInput {
  /** The clip's own length in seconds (clip.duration * speed) — the take must drop back in cleanly. */
  clipDurationSeconds: number
  /** Base prompt for the shot (from the asset/clip); the note is appended. */
  prompt: string
  /** Optional free-text direction ("more rain, keep the camera move"). */
  note?: string
  referenceImagePaths: string[]
  videoReferencePaths: string[]
  resolution?: string
  aspectRatio?: string
  seed?: number
}

export interface RegenRequest {
  type: 'video'
  model: 'seedance-2.0'
  params: {
    prompt: string
    duration: string
    resolution: string
    aspectRatio: string
    referenceImagePaths: string[]
    videoReferencePaths: string[]
    seed?: number
  }
}

/** Errors that should block submission — empty array means good to render. */
export function validateRegenWithRef(i: Pick<RegenWithRefInput, 'referenceImagePaths' | 'videoReferencePaths'>): string[] {
  const errors: string[] = []
  const imgs = i.referenceImagePaths.length
  const vids = i.videoReferencePaths.length
  if (imgs === 0 && vids === 0) {
    errors.push('Add at least one reference (a frame, a crop, or a clip) — that is what the regeneration follows.')
  }
  if (imgs > REF_CAPS.image) errors.push(`Too many image references (${imgs}/${REF_CAPS.image}).`)
  if (vids > REF_CAPS.video) errors.push(`Too many clip references (${vids}/${REF_CAPS.video}).`)
  return errors
}

/** Clip length → the duration the model will actually render (int seconds, 1..15). */
export function clampRegenDuration(clipDurationSeconds: number): number {
  const rounded = Math.round(clipDurationSeconds)
  return Math.min(SEEDANCE_MAX_SECONDS, Math.max(1, Number.isFinite(rounded) ? rounded : 1))
}

export function buildRegenWithRefRequest(i: RegenWithRefInput): RegenRequest {
  const duration = clampRegenDuration(i.clipDurationSeconds)
  const prompt = [i.prompt?.trim(), i.note?.trim()].filter(Boolean).join(', ') || 'regenerate this shot'
  return {
    type: 'video',
    model: 'seedance-2.0', // omni-reference is a Seedance 2.0 capability
    params: {
      prompt,
      duration: String(duration),
      resolution: i.resolution || '720p',
      aspectRatio: i.aspectRatio || '16:9',
      referenceImagePaths: i.referenceImagePaths,
      videoReferencePaths: i.videoReferencePaths,
      ...(i.seed != null ? { seed: i.seed } : {}),
    },
  }
}
