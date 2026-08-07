/**
 * "Regenerate with reference" — build the render request for re-generating one
 * timeline clip using reference media (a clip, a frame, or a crop) + an
 * optional note, landing as a NEW TAKE on that clip.
 *
 * Pure + framework-free so the render request is unit-tested: the same inputs
 * always produce the same queue-submit body, and the model caps are enforced
 * HERE (before submit) rather than discovered as a late server 400.
 */

// Model caps (mirror the backend video_generation_handler).
// Seedance 2.0 = fal, omni-reference (image + video refs), 15s.
// Seedance 1.5 Pro = Replicate, first-frame image-to-video (no refs), 10s.
export const SEEDANCE_MAX_SECONDS = 15
export const SEEDANCE_15_MAX_SECONDS = 10
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
  /** Whether a fal key is configured. Seedance 2.0 omni-reference renders on fal;
   *  without it, a still-image reference falls back to Replicate seedance-1.5-pro
   *  (the reference becomes the FIRST FRAME). Video references always need fal. */
  falAvailable?: boolean
}

/** Seedance 2.0 (fal) — true omni-reference: image AND/OR video references. */
export interface RegenRequestFal {
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
/** Seedance 1.5 Pro (Replicate) — the reference image drives the FIRST FRAME. */
export interface RegenRequestReplicate {
  type: 'video'
  model: 'seedance-1.5-pro'
  params: {
    prompt: string
    duration: string
    resolution: string
    aspectRatio: string
    imagePath: string
    seed?: number
  }
}
export type RegenRequest = RegenRequestFal | RegenRequestReplicate

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

/** Clip length → the duration the model will actually render (int seconds, 1..max). */
export function clampRegenDuration(clipDurationSeconds: number, maxSeconds: number = SEEDANCE_MAX_SECONDS): number {
  const rounded = Math.round(clipDurationSeconds)
  return Math.min(maxSeconds, Math.max(1, Number.isFinite(rounded) ? rounded : 1))
}

/**
 * Choose the provider/model. Video references are a Seedance-2.0-only (fal)
 * capability, so they force fal. A still-image reference prefers Seedance 2.0
 * omni-reference when a fal key exists, but falls back to Replicate's
 * seedance-1.5-pro (reference → first frame) when it doesn't — so the feature
 * works on whichever key the user actually has configured.
 */
export function chooseRegenTarget(i: Pick<RegenWithRefInput, 'videoReferencePaths' | 'falAvailable'>): {
  provider: 'fal' | 'replicate'
  model: 'seedance-2.0' | 'seedance-1.5-pro'
} {
  const needsFal = i.videoReferencePaths.length > 0 || !!i.falAvailable
  return needsFal
    ? { provider: 'fal', model: 'seedance-2.0' }
    : { provider: 'replicate', model: 'seedance-1.5-pro' }
}

export function buildRegenWithRefRequest(i: RegenWithRefInput): RegenRequest {
  const prompt = [i.prompt?.trim(), i.note?.trim()].filter(Boolean).join(', ') || 'regenerate this shot'
  const resolution = i.resolution || '720p'
  const aspectRatio = i.aspectRatio || '16:9'
  const { model } = chooseRegenTarget(i)
  if (model === 'seedance-2.0') {
    return {
      type: 'video',
      model: 'seedance-2.0', // omni-reference is a Seedance 2.0 (fal) capability
      params: {
        prompt,
        duration: String(clampRegenDuration(i.clipDurationSeconds, SEEDANCE_MAX_SECONDS)),
        resolution,
        aspectRatio,
        referenceImagePaths: i.referenceImagePaths,
        videoReferencePaths: i.videoReferencePaths,
        ...(i.seed != null ? { seed: i.seed } : {}),
      },
    }
  }
  // Replicate fallback: the reference image becomes the first frame (image-to-video).
  return {
    type: 'video',
    model: 'seedance-1.5-pro',
    params: {
      prompt,
      duration: String(clampRegenDuration(i.clipDurationSeconds, SEEDANCE_15_MAX_SECONDS)),
      resolution,
      aspectRatio,
      imagePath: i.referenceImagePaths[0] || '',
      ...(i.seed != null ? { seed: i.seed } : {}),
    },
  }
}
