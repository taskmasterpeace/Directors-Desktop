/**
 * LTX-2.3 LoRA registry — single source of truth for the LoRAs selectable on the
 * local `ltx-comfy` engine. Each is STACKED on the always-on distilled speed LoRA
 * (that one is baked into every render and is not user-selectable).
 *
 * LoRA families (per the LTX docs): standard style/effect LoRAs; and IC-LoRAs for
 * structural control from a reference signal (depth / pose / edge / mask), which
 * includes the object-removal adapters. IC-LoRAs are marked `needsControl` — they
 * expect a control source; applied without one they bias the model but do less.
 *
 * `gated` LoRAs live in access-restricted HuggingFace repos: the user must accept
 * the model license and provide an HF token before the file can be downloaded. The
 * engine renders WITHOUT a selected LoRA that isn't on disk (graceful, never a
 * hard error), so a gated pick simply no-ops until the file is present.
 */

export type LtxLoraType = 'ic-lora' | 'style' | 'transition'

export interface LtxLora {
  /** ComfyUI lora_name relative to the loras dir (may include a subfolder). */
  id: string
  label: string
  type: LtxLoraType
  description: string
  /** Sensible starting strength; the user can tune from here. */
  defaultStrength: number
  /** Access-restricted HF repo — needs license acceptance + an HF token to download. */
  gated?: boolean
  /** IC-LoRA that expects a structural control source (depth/pose/edge/mask). */
  needsControl?: boolean
  /** Where to accept the license, for gated LoRAs. */
  licenseUrl?: string
  /** Discovered on disk (drop-a-file), not from the curated registry. */
  local?: boolean
  /** Absolute path to a sidecar thumbnail image, when one exists. */
  thumbnailPath?: string | null
  /** Trigger words from a sidecar .txt/.json — shown and pasteable. */
  trigger?: string | null
}

/** Shape of /api/lora/ltx-local entries (backend server_utils/ltx_local_loras). */
export interface LocalLtxLoraEntry {
  file: string
  name: string
  sizeBytes: number
  thumbnail: string | null
  trigger: string | null
}

/**
 * Curated registry + drop-a-file discoveries, one list. Curated wins on id
 * collision (its metadata is richer); local entries arrive as style LoRAs at
 * full strength — the drop-in convention is "this file IS the look".
 */
export function mergeLtxLoras(
  curated: readonly LtxLora[],
  scanned: readonly LocalLtxLoraEntry[],
): LtxLora[] {
  const known = new Set(curated.map(l => l.id))
  const locals: LtxLora[] = scanned
    .filter(e => !known.has(e.file))
    .map(e => ({
      id: e.file,
      label: e.name,
      type: 'style' as const,
      description: e.trigger ? `Local LoRA — trigger: ${e.trigger}` : 'Local LoRA (dropped into the loras folder).',
      defaultStrength: 1.0,
      local: true,
      thumbnailPath: e.thumbnail,
      trigger: e.trigger,
    }))
  return [...curated, ...locals]
}

export const LTX_LORAS: readonly LtxLora[] = [
  {
    id: 'ltx-2.3-inpaint-remover.safetensors',
    label: 'Inpaint Remover — object removal',
    type: 'ic-lora',
    description: 'Remove objects/people and fill the background. Name what to remove in the prompt; strongest with a mask.',
    defaultStrength: 0.9,
    needsControl: true,
  },
  {
    id: 'ltxv/ltx2/ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors',
    label: 'Union Control',
    type: 'ic-lora',
    description: 'Structural control — follow depth / pose / edge from a reference.',
    defaultStrength: 0.8,
    needsControl: true,
  },
  {
    id: 'ltx-2.3-22b-ic-lora-clean-plate-1.0.safetensors',
    label: 'Clean Plate — object removal',
    type: 'ic-lora',
    description: 'Remove a subject/object and fill the background (VFX clean plate).',
    defaultStrength: 0.9,
    gated: true,
    needsControl: true,
    licenseUrl: 'https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-Clean-Plate',
  },
  {
    id: 'ltx-2.3-22b-ic-lora-in-outpainting-0.9.safetensors',
    label: 'In / Out-painting — mask inpaint',
    type: 'ic-lora',
    description: 'Mask-based inpaint / outpaint — remove or extend regions.',
    defaultStrength: 0.9,
    gated: true,
    needsControl: true,
    licenseUrl: 'https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-In-Outpainting',
  },
]

export function getLtxLora(
  id: string | undefined | null,
  from: readonly LtxLora[] = LTX_LORAS,
): LtxLora | undefined {
  return id ? from.find(l => l.id === id) : undefined
}

/**
 * Prepend a LoRA's trigger words to the prompt — the local-file convention is
 * "the trigger IS part of the look". Skipped when the prompt already carries
 * the first trigger token, so re-generating or hand-typed triggers never double.
 */
export function applyLtxTrigger(prompt: string, trigger: string | null | undefined): string {
  const t = trigger?.trim()
  if (!t) return prompt
  const firstWord = t.split(/[,\s]+/)[0] ?? ''
  if (firstWord && prompt.toLowerCase().includes(firstWord.toLowerCase())) return prompt
  return prompt.trim() ? `${t}, ${prompt}` : t
}
