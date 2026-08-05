/**
 * Plain-English explanations for the LTX-2.3 model files a user sees in the
 * Models tab, plus an honest "does this fit my GPU?" assessment.
 *
 * The Settings → Models dropdown lists raw filenames (ltx-2.3-22b-dev,
 * -distilled, -distilled-lora-384, -spatial-upscaler-x2) with no hint of what
 * they are or whether they'll even load on the user's card. This module turns
 * each filename + size + the GPU's VRAM into something a human can act on.
 */

export type LtxModelKind = 'dev' | 'distilled' | 'speed-lora' | 'upscaler' | 'encoder' | 'unknown'

export interface LtxModelExplanation {
  kind: LtxModelKind
  /** Short human label, e.g. "Full model (Pro)". */
  label: string
  /** One-sentence plain-English description. */
  blurb: string
  /** False for add-ons (upscaler, speed LoRA) that aren't a base model you pick alone. */
  isGenerator: boolean
}

/** Classify an LTX model file by its name. Order matters: check add-ons first. */
export function explainLtxModel(filename: string): LtxModelExplanation {
  const f = filename.toLowerCase()
  if (f.includes('upscaler') || f.includes('upscale')) {
    return {
      kind: 'upscaler',
      label: 'Upscaler (add-on)',
      blurb: 'Sharpens and enlarges finished video (2×). Not a generator — it runs after a base model, so don\'t pick it on its own.',
      isGenerator: false,
    }
  }
  if (f.includes('lora')) {
    return {
      kind: 'speed-lora',
      label: 'Speed Boost LoRA (add-on)',
      blurb: 'A small add-on that makes compressed (GGUF/NF4) models generate fast. Pair it with a base model — it is not a generator by itself.',
      isGenerator: false,
    }
  }
  if (f.includes('gemma') || f.includes('text_encoder') || f.includes('text-encoder')) {
    return {
      kind: 'encoder',
      label: 'Text encoder',
      blurb: 'Turns your prompt into something the model understands. Loaded automatically — not something you select here.',
      isGenerator: false,
    }
  }
  if (f.includes('distilled')) {
    return {
      kind: 'distilled',
      label: 'Fast model (distilled)',
      blurb: 'The speed build: far fewer steps, much faster, quality very close to the full model. This is what "LTX 2.3 Fast" uses.',
      isGenerator: true,
    }
  }
  if (f.includes('dev')) {
    return {
      kind: 'dev',
      label: 'Full model (Pro)',
      blurb: 'Highest quality, but slow — it needs many denoising steps. Use it for hero shots when you have the time and VRAM.',
      isGenerator: true,
    }
  }
  return {
    kind: 'unknown',
    label: 'Video model',
    blurb: 'A local LTX video model file.',
    isGenerator: true,
  }
}

export type GpuFitLevel = 'fits' | 'tight' | 'too-big' | 'addon'

export interface GpuFit {
  level: GpuFitLevel
  note: string
}

/**
 * Honest fit check. A base model's weights must sit in VRAM alongside the ~12 GB
 * Gemma text encoder, so on a 24 GB card only ~16 GB (GGUF) models are
 * comfortable, fp8 (~22 GB) is tight, and the 43 GB BF16 build simply won't fit.
 */
export function assessGpuFit(
  sizeGb: number,
  vramGb: number | null,
  isGenerator: boolean,
): GpuFit {
  if (!isGenerator) {
    return { level: 'addon', note: 'Add-on — no VRAM check needed.' }
  }
  if (vramGb === null) {
    return { level: 'tight', note: 'No GPU detected.' }
  }
  if (sizeGb > vramGb) {
    return {
      level: 'too-big',
      note: `Too big for your ${vramGb} GB card — the weights alone exceed your VRAM. Use an fp8 (~22 GB) or GGUF (≤16 GB) build instead.`,
    }
  }
  if (sizeGb > vramGb * 0.7) {
    return {
      level: 'tight',
      note: `Tight on ${vramGb} GB — it fits, but leaves little room for the text encoder. Expect slow first loads; a GGUF build is safer.`,
    }
  }
  return { level: 'fits', note: `Fits your ${vramGb} GB card comfortably.` }
}
