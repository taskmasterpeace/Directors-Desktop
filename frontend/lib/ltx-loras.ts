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

export function getLtxLora(id: string | undefined | null): LtxLora | undefined {
  return id ? LTX_LORAS.find(l => l.id === id) : undefined
}
