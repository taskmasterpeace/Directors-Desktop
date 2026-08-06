/**
 * VIDEO model registry — single source of truth for what each model DOES,
 * mirroring the house rule image-models.ts already enforces for images.
 *
 * The load-bearing field is `conditioning`: local engines accept exactly ONE
 * conditioning image (backend job_executors: `refs[0] if refs else image_path`
 * — references silently beat the first-frame slot), while Seedance 2.0 uses
 * BOTH with distinct roles. Before this registry the UI let users attach a
 * combination the engine would half-ignore without a word. Surfaces read this
 * to compensate: warn, and say exactly which image wins and what it will do.
 */

export interface VideoModelConfig {
  id: string
  displayName: string
  kind: 'local' | 'cloud'
  /**
   * 'dual'   — first-frame image AND reference images are both used, in
   *            different roles (Seedance 2.0 omni-reference).
   * 'single' — the engine takes ONE conditioning image; when both are
   *            attached, references win and the image slot is ignored.
   */
  conditioning: 'single' | 'dual'
  /** What the winning image does on a 'single' model. */
  singleImageRole?: 'first-frame' | 'character-lock'
  /** Whether reference images do anything at all on this model. */
  supportsReferences: boolean
  supportsAudioInput: boolean
  supportsLastFrame: boolean
  supportsVideoReferences: boolean
  maxDurationSeconds: number
}

export const VIDEO_MODELS: Record<string, VideoModelConfig> = {
  'h3-local': {
    id: 'h3-local',
    displayName: 'MiniMax H3 · local',
    kind: 'local',
    conditioning: 'single',
    // H3's omni-reference re-poses the person; it does NOT start on the image.
    singleImageRole: 'character-lock',
    supportsReferences: true,
    supportsAudioInput: false,
    supportsLastFrame: false,
    supportsVideoReferences: false,
    maxDurationSeconds: 15,
  },
  'ltx-comfy': {
    id: 'ltx-comfy',
    displayName: 'LTX-2.3 · local',
    kind: 'local',
    conditioning: 'single',
    // LTX i2v: the winning image literally becomes frame one.
    singleImageRole: 'first-frame',
    supportsReferences: true,
    supportsAudioInput: false,
    supportsLastFrame: false,
    supportsVideoReferences: false,
    maxDurationSeconds: 15,
  },
  'ltx-fast': {
    id: 'ltx-fast',
    displayName: 'LTX-2 Fast · local',
    kind: 'local',
    conditioning: 'single',
    singleImageRole: 'first-frame',
    supportsReferences: false,
    supportsAudioInput: true,
    supportsLastFrame: true,
    supportsVideoReferences: false,
    maxDurationSeconds: 15,
  },
  // Legacy id for the same local pipeline.
  'fast': {
    id: 'fast',
    displayName: 'LTX-2 Fast · local',
    kind: 'local',
    conditioning: 'single',
    singleImageRole: 'first-frame',
    supportsReferences: false,
    supportsAudioInput: true,
    supportsLastFrame: true,
    supportsVideoReferences: false,
    maxDurationSeconds: 15,
  },
  'pro': {
    id: 'pro',
    displayName: 'LTX-2 Pro · local',
    kind: 'local',
    conditioning: 'single',
    singleImageRole: 'first-frame',
    supportsReferences: false,
    supportsAudioInput: true,
    supportsLastFrame: true,
    supportsVideoReferences: false,
    maxDurationSeconds: 15,
  },
  'seedance-2.0': {
    id: 'seedance-2.0',
    displayName: 'Seedance 2.0',
    kind: 'cloud',
    conditioning: 'dual',
    supportsReferences: true,
    supportsAudioInput: true,
    supportsLastFrame: true,
    supportsVideoReferences: true,
    maxDurationSeconds: 15,
  },
  'seedance-2.0-fast': {
    id: 'seedance-2.0-fast',
    displayName: 'Seedance 2.0 Fast',
    kind: 'cloud',
    conditioning: 'dual',
    supportsReferences: true,
    supportsAudioInput: true,
    supportsLastFrame: true,
    supportsVideoReferences: true,
    maxDurationSeconds: 15,
  },
  'seedance-1.5-pro': {
    id: 'seedance-1.5-pro',
    displayName: 'Seedance 1.5 Pro',
    kind: 'cloud',
    conditioning: 'single',
    singleImageRole: 'first-frame',
    supportsReferences: false,
    supportsAudioInput: false,
    supportsLastFrame: true,
    supportsVideoReferences: false,
    maxDurationSeconds: 10,
  },
}

export function getVideoModel(id: string): VideoModelConfig | null {
  return VIDEO_MODELS[id] ?? null
}

/**
 * The compensation message for attaching BOTH a first-frame image and
 * reference images. Empty string = nothing will be ignored (dual models).
 */
export function conditioningConflictMessage(modelId: string): string {
  const m = getVideoModel(modelId)
  if (!m || m.conditioning === 'dual') return ''
  if (!m.supportsReferences) {
    return `${m.displayName} doesn't use reference images — only your first-frame image counts here.`
  }
  return m.singleImageRole === 'character-lock'
    ? `${m.displayName} takes one image: your reference drives the character, and the first-frame image will be ignored.`
    : `${m.displayName} takes one image: your reference becomes the first frame, and the image slot will be ignored.`
}
