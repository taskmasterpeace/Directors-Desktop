"""Protocol for LOCAL LTX-2.3 video generation on the user's GPU via ComfyUI.

LTX-2.3 is an open-weight video model. The *shipped* local path is the **native
ComfyUI LTX-2.3 blueprint** (ComfyUI Template Library -> Video -> "Text to Video
(LTX-2.3)"), NOT DD's compiled ``ltx_pipelines`` — that library can't quantize the
Gemma text encoder (its fp8 policy is transformer-specific), so on a 24GB card the
23.6GB bf16 Gemma thrashes to system RAM. The ComfyUI path instead loads an
official **fp8 checkpoint** (DiT + VAE + audio VAE in one file) plus an
**fp4-mixed Gemma** encoder (~8.8GB) that fits 24GB with room to spare, plus the
distilled speed LoRA. See the memory note ``ltx-comfyui-official-recipe`` and the
``local-model-vram`` skill for why the native path beats hand-rolled runtime quant.

This Protocol is the swap boundary: everything above it (queue, gpu-slot routing,
model picker, warmth pill, ETA) is engine-agnostic and identical to the H3 local
engine, so a future NATIVE (no-ComfyUI) LTX engine can drop in behind it. The
Phase-1 implementation drives the same local ComfyUI instance H3 uses — only one
video model fits in 24GB at a time, and the gpu slot serialises jobs, so H3<->LTX
model switching never collides.
"""

from __future__ import annotations

from typing import Callable, Protocol

# The single DD video-model id for local LTX-2.3 (ComfyUI engine). Routes to the
# "gpu" slot (free, user's GPU) — never the "api" slot. Distinct from the legacy
# "fast"/"ltx-fast" ids that drove the thrashing ltx_pipelines path.
LTX_COMFY_MODEL = "ltx-comfy"

# --- Official ComfyUI LTX-2.3 model files (exact names the blueprint references) --
# Checkpoint is one file = DiT + video VAE + audio VAE.
#   fp8 (Lightricks/LTX-2.3-fp8): the official file, but the 22B DiT is ~22GB — it
#     block-swaps on a 24GB card and crawls (~400-630s/2s). A 32GB-card quant.
#   nvfp4 (Lightricks/LTX-2.3-nvfp4): the 24GB fit. Paired with GPU text-encode +
#     ComfyUI's --disable-smart-memory (evicts the ~8GB Gemma before sampling), the
#     DiT runs resident and compute-bound (~127s cold / ~57s warm for a 2s clip).
LTX_CKPT = "ltx-2.3-22b-dev-fp8.safetensors"
LTX_CKPT_NVFP4 = "ltx-2.3-22b-dev-nvfp4.safetensors"
# Encoders (Gemma-3-12B), preferred first for a 24GB card:
#   1. fp4-mixed (official, ~8.8GB) — the reliable fit; what the blueprint ships.
#   2. Heretic fp8 (uncensored, ~13.5GB) — drop-in alt for LTXAVTextEncoderLoader.
LTX_TE = "gemma_3_12B_it_fp4_mixed.safetensors"
LTX_TE_UNCENSORED = "comfy_gemma_3_12B_it_heretic_fp8.safetensors"
# Distilled speed LoRA (applied to the DiT at strength ~0.5) and 2nd-stage upscaler.
LTX_DISTILLED_LORA = "ltx-2.3-22b-distilled-lora-384.safetensors"
LTX_UPSCALER = "ltx-2.3-spatial-upscaler-x2-1.1.safetensors"

LTX_MAX_SECONDS = 15
LTX_FPS = 24

# LTX spatial VAE compression is 32x — width/height MUST be multiples of 32 or the
# latent geometry is wrong. These are 16:9 / 9:16 pairs at each DD tier, /32-aligned.
LTX_RESOLUTIONS: dict[str, tuple[tuple[int, int], tuple[int, int]]] = {
    "480p": ((832, 480), (480, 832)),
    "720p": ((1280, 704), (704, 1280)),
}


def ltx_dimensions(resolution: str, aspect: str) -> tuple[int, int]:
    """DD resolution + aspect -> (width, height), /32-aligned. Falls back to 480p."""
    tiers = LTX_RESOLUTIONS.get(resolution, LTX_RESOLUTIONS["480p"])
    return tiers[0] if aspect == "16:9" else tiers[1]


def ltx_snap_frames(seconds: float) -> int:
    """LTX temporal VAE compression is 8x, so EmptyLTXVLatentVideo ``length`` must be
    ``8k + 1`` (e.g. 97 = 8*12 + 1). Snap DOWN to the nearest valid count so the
    latent geometry is always legal; the assembler trims to the exact fractional cut.
    5s@24fps -> 120 -> 113; 15s -> 360 -> 353."""
    n = max(9, round(seconds * LTX_FPS))
    return n - ((n - 1) % 8)


class LTXComfyClient(Protocol):
    def generate_video(
        self,
        *,
        prompt: str,
        width: int,
        height: int,
        seconds: float,
        negative_prompt: str = "",
        reference_image_path: str | None = None,
        lora_name: str | None = None,
        lora_strength: float = 1.0,
        seed: int = 7,
        on_phase: Callable[[str, int], None] | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> str:
        """Render one LTX-2.3 clip locally and return the absolute path to the mp4.

        No reference image = text-to-video; a reference image conditions the first
        frame (image-to-video). ``lora_name`` layers an extra LoRA (style / motion /
        IC-LoRA) on top of the always-on distilled speed LoRA. ``on_phase(phase,
        percent)`` reports coarse progress (loading_model / inference / decoding).

        Raises RuntimeError on engine failure or if the user cancels.
        """
        ...
