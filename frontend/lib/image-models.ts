/**
 * The single source of truth for image-generation models, app-wide.
 *
 * Every surface that generates images (Gen Space, Playground, Video Editor,
 * Batch builder, Settings, Shot Creator) reads this registry instead of
 * hardcoding model ids — so adding or retiring a model is a one-file change.
 *
 * Ids are exactly what gets stored in `appSettings.imageModel` and sent as the
 * queue job's `model`. Director's Palette models carry a `dp-` prefix; the
 * backend strips it and routes them through Palette's live v2 API on the user's
 * credits (see `backend/services/palette_image_client/`).
 */

export type ImageModelProvider = 'palette' | 'local' | 'replicate'

export interface ImageModelConfig {
  /** Stored in appSettings.imageModel / sent as the job model. */
  id: string
  displayName: string
  /** Matches Director's Palette's model glyphs so both apps read the same. */
  icon: string
  provider: ImageModelProvider
  /** One line shown under the picker. */
  description: string
  /** Points per image for Palette models; null for local GPU (free). */
  costPoints: number | null
  /** Palette models whose cost depends on a param (gpt-image-2 quality). */
  costByQuality?: Record<string, number>
  /** How many reference images the model accepts (0 = none). */
  maxReferenceImages: number
  /** Model cannot run without a reference image (Camera Angle). */
  requiresInputImage: boolean
  /** Aspect ratios this model actually supports. */
  aspectRatios: string[]
  /** Exposes a quality control (gpt-image-2: low | medium). */
  qualityOptions?: string[]
  /** Driven by the 3D camera gizmo / presets (qwen multi-angle). */
  supportsCameraAngle?: boolean
  /** Supports LoRA (local flux pipelines). */
  supportsLora?: boolean
  /**
   * img2img edit strength. Only the local pipelines actually apply it — the
   * hosted Palette models ignore it, so showing a Strength slider for them is a lie.
   */
  supportsStrength?: boolean
  badge?: string
  /** Tailwind text colour for the badge/glyph, mirroring Palette's palette. */
  badgeColor?: string
}

const NANO_ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '3:2', '2:3']
const LOCAL_ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']

/**
 * Director's Palette models — run on the user's Palette credits via v2.
 *
 * NB: Palette's v2 `/images/generate` route does not thread nano's
 * resolution/safety/search params (it reads aspect/quality/seed only), so
 * nano runs at 1K and its cost is flat rather than tiered.
 */
export const PALETTE_IMAGE_MODELS: ImageModelConfig[] = [
  {
    id: 'dp-nano-banana-2',
    displayName: 'Nano Banana 2',
    icon: '🍌',
    provider: 'palette',
    description: 'Best all-round quality and text rendering. Up to 14 reference images.',
    costPoints: 10,
    maxReferenceImages: 14,
    requiresInputImage: false,
    aspectRatios: NANO_ASPECTS,
    badge: 'Premium',
    badgeColor: 'text-green-300',
  },
  {
    id: 'dp-nano-banana-2-lite',
    displayName: 'Nano Banana 2 Lite',
    icon: '🍌',
    provider: 'palette',
    description: 'Fastest and cheapest — great for drafts and high-volume batches.',
    costPoints: 5,
    maxReferenceImages: 14,
    requiresInputImage: false,
    aspectRatios: NANO_ASPECTS,
    badge: 'Fast & Cheap',
    badgeColor: 'text-yellow-300',
  },
  {
    id: 'dp-gpt-image-2',
    displayName: 'GPT Image 2',
    icon: '🎨',
    provider: 'palette',
    description: 'Best-in-class text in images and instruction following. Up to 10 references.',
    costPoints: 2,
    costByQuality: { low: 2, medium: 8 },
    qualityOptions: ['low', 'medium'],
    maxReferenceImages: 10,
    requiresInputImage: false,
    // gpt-image-2 only accepts these three — anything else 422s upstream.
    aspectRatios: ['1:1', '3:2', '2:3'],
    badge: 'Text Master',
    badgeColor: 'text-emerald-300',
  },
  {
    id: 'dp-qwen-image-edit',
    displayName: 'Camera Angle',
    icon: '🎥',
    provider: 'palette',
    description: 'Re-shoot a photo from any angle — orbit the camera around your subject.',
    costPoints: 5,
    maxReferenceImages: 1,
    requiresInputImage: true,
    aspectRatios: ['match_input_image', '1:1', '16:9', '9:16', '4:3', '3:4'],
    supportsCameraAngle: true,
    badge: 'Camera',
    badgeColor: 'text-cyan-300',
  },
]

/** Local GPU models — free, no network, need the weights downloaded. */
export const LOCAL_IMAGE_MODELS: ImageModelConfig[] = [
  {
    id: 'z-image-turbo',
    displayName: 'Z-Image Turbo',
    icon: '⚡',
    provider: 'local',
    description: 'Fast single-step local generation. Stays in VRAM for quick back-to-back images.',
    costPoints: null,
    maxReferenceImages: 0,
    requiresInputImage: false,
    aspectRatios: LOCAL_ASPECTS,
    supportsStrength: true,
    badgeColor: 'text-zinc-400',
  },
  {
    id: 'flux-klein-9b',
    displayName: 'FLUX.2 Klein 9B',
    icon: '🖥',
    provider: 'local',
    description: 'High quality local images with LoRA support. Reloads each run (~5s extra).',
    costPoints: null,
    maxReferenceImages: 0,
    requiresInputImage: false,
    aspectRatios: LOCAL_ASPECTS,
    supportsLora: true,
    supportsStrength: true,
    badgeColor: 'text-zinc-400',
  },
  {
    id: 'flux-dev',
    displayName: 'FLUX.1 dev',
    icon: '🖥',
    provider: 'local',
    description: 'Best local quality and the standard LoRA target. ~34s/image.',
    costPoints: null,
    maxReferenceImages: 0,
    requiresInputImage: false,
    aspectRatios: LOCAL_ASPECTS,
    supportsLora: true,
    supportsStrength: true,
    badgeColor: 'text-zinc-400',
  },
]

/** Direct-to-Replicate (needs the user's own Replicate key). */
export const REPLICATE_IMAGE_MODELS: ImageModelConfig[] = [
  {
    id: 'nano-banana-2',
    displayName: 'Nano Banana 2 (Replicate)',
    icon: '🍌',
    provider: 'replicate',
    description: 'Runs in the cloud on your own Replicate key — no GPU needed.',
    costPoints: null,
    maxReferenceImages: 14,
    requiresInputImage: false,
    aspectRatios: NANO_ASPECTS,
    badgeColor: 'text-zinc-400',
  },
]

export const IMAGE_MODELS: ImageModelConfig[] = [
  ...PALETTE_IMAGE_MODELS,
  ...LOCAL_IMAGE_MODELS,
  ...REPLICATE_IMAGE_MODELS,
]

/**
 * Retired ids → their replacement. `dp-flux-2-klein-9b` is the big one: Palette
 * hides it and redirects it server-side, so keeping it selectable was a dead end.
 */
export const DEPRECATED_IMAGE_MODELS: Record<string, string> = {
  'dp-flux-2-klein-9b': 'dp-nano-banana-2',
  'dp-nano-banana': 'dp-nano-banana-2',
  'dp-nano-banana-pro': 'dp-nano-banana-2',
  'dp-seedream-5-lite': 'dp-nano-banana-2',
  'dp-riverflow-2-pro': 'dp-nano-banana-2',
  'flux-2-klein-9b': 'flux-klein-9b',
  'nano-banana': 'nano-banana-2',
}

export const DEFAULT_IMAGE_MODEL_ID = 'dp-nano-banana-2'

/** Resolve a stored id, migrating retired ones. Unknown ids fall back to the default. */
export function migrateImageModelId(id: string | null | undefined): string {
  if (!id) return DEFAULT_IMAGE_MODEL_ID
  const migrated = DEPRECATED_IMAGE_MODELS[id] ?? id
  return IMAGE_MODELS.some((m) => m.id === migrated) ? migrated : DEFAULT_IMAGE_MODEL_ID
}

/** Look up a model, migrating retired ids. Always returns a usable config. */
export function getImageModel(id: string | null | undefined): ImageModelConfig {
  const resolved = migrateImageModelId(id)
  const found = IMAGE_MODELS.find((m) => m.id === resolved)
  // migrateImageModelId guarantees a known id, but stay total for safety.
  return found ?? PALETTE_IMAGE_MODELS[0]
}

export function isPaletteImageModel(id: string | null | undefined): boolean {
  return getImageModel(id).provider === 'palette'
}

/** Points for one image, honoring quality tiers. Returns 0 for free local models. */
export function getImageModelCost(id: string | null | undefined, quality?: string): number {
  const model = getImageModel(id)
  if (model.costByQuality && quality && model.costByQuality[quality] !== undefined) {
    return model.costByQuality[quality]
  }
  return model.costPoints ?? 0
}

/** Snap a requested aspect ratio to one the model actually supports. */
export function coerceAspectRatio(id: string | null | undefined, aspect: string): string {
  const model = getImageModel(id)
  if (model.aspectRatios.includes(aspect)) return aspect
  // gpt-image-2 style narrowing: pick by orientation rather than failing.
  const [w, h] = aspect.split(':').map(Number)
  const ratio = w && h ? w / h : 1
  const landscape = model.aspectRatios.find((a) => a === '3:2') ?? model.aspectRatios.find((a) => a === '16:9')
  const portrait = model.aspectRatios.find((a) => a === '2:3') ?? model.aspectRatios.find((a) => a === '9:16')
  const square = model.aspectRatios.find((a) => a === '1:1')
  if (ratio > 1.1 && landscape) return landscape
  if (ratio < 0.9 && portrait) return portrait
  return square ?? model.aspectRatios[0]
}

/** True when the model can accept at least one reference image. */
export function supportsReferences(id: string | null | undefined): boolean {
  return getImageModel(id).maxReferenceImages > 0
}

/**
 * True when the model actually applies an img2img edit strength. The hosted
 * Palette/Replicate models ignore it, so a Strength slider there is misleading.
 */
export function supportsEditStrength(id: string | null | undefined): boolean {
  return getImageModel(id).supportsStrength === true
}

/** Models grouped for a picker, in display order, with retired ones excluded. */
export function listImageModelGroups(): { label: string; models: ImageModelConfig[] }[] {
  return [
    { label: "Director's Palette · runs on your credits", models: PALETTE_IMAGE_MODELS },
    { label: 'Local GPU · free', models: LOCAL_IMAGE_MODELS },
    { label: 'Replicate · your own key', models: REPLICATE_IMAGE_MODELS },
  ]
}
