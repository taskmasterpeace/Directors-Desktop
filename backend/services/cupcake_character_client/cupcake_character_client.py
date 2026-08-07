"""Protocol for local character-likeness image generation on a REMOTE ComfyUI (cupcake).

`cupcake-character` is a LOCAL image model in the sense of the video engines: it drives an
open-source ComfyUI graph on the user's own hardware (the GX10 / "cupcake" box), never a
paid cloud host. The proven graph is SDXL + InstantID (face identity) + IPAdapter (full-
character look/style) — the recipe validated in benchmarks/image on cupcake: it keeps a
character's face AND their hair/outfit/art-style while placing them in a new prompted scene,
locally and free, with no LoRA training.

Unlike the LTX/H3 clients this does NOT launch or manage a ComfyUI subprocess — cupcake runs
ComfyUI as a 24/7 service, so the client is a pure HTTP driver (upload refs, submit /prompt,
poll /history, download /view). The base_url points at the remote box; there is nothing to
Popen or taskkill on another machine.

This Protocol is the swap boundary: the handler above it is engine-agnostic, so a future
native pipeline could replace the ComfyUI driver without changes upstream.
"""

from __future__ import annotations

from typing import Callable, Protocol

# The single DD image-model id for the cupcake character pipeline. Routes to the "gpu" slot
# (the one-at-a-time local-engine slot) via determine_slot, same as h3-local / ltx-comfy.
CUPCAKE_CHARACTER_MODEL = "cupcake-character"

# Model files as they are named on cupcake (see machine-king-ai-os / benchmarks/image).
SDXL_CHECKPOINT = "sd_xl_base_1.0.safetensors"
INSTANTID_MODEL = "ip-adapter.bin"
INSTANTID_CONTROLNET = "instantid_control.safetensors"

# Proven weights (the kwalker consistency run): InstantID locks the face, IPAdapter carries
# the whole-character look (hair/outfit/style). Face-only identity misses defining features
# like hairstyle, so IPAdapter reproducing the full character is what keeps a character on-model.
DEFAULT_INSTANTID_WEIGHT = 0.65
DEFAULT_IPADAPTER_WEIGHT = 0.72
DEFAULT_NEGATIVE = (
    "photograph, real person, blurry, watermark, text, grid lines, extra limbs, deformed"
)


class CupcakeCharacterClient(Protocol):
    def generate_image(
        self,
        *,
        prompt: str,
        character_image_path: str,
        style_image_path: str | None = None,
        width: int = 1024,
        height: int = 1024,
        negative_prompt: str = "",
        seed: int = 7,
        instantid_weight: float = DEFAULT_INSTANTID_WEIGHT,
        ipadapter_weight: float = DEFAULT_IPADAPTER_WEIGHT,
        steps: int = 30,
        on_phase: Callable[[str, int], None] | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> str:
        """Render one on-model character image and return the absolute path to the saved PNG.

        ``character_image_path`` is the identity+look reference (a face/character image); it
        drives both the InstantID face lock and the IPAdapter character branch. ``style_image_path``
        optionally overrides the IPAdapter branch with a separate style/look reference. The
        prompt describes the new scene — it must NOT re-describe facial traits, which the
        identity branch supplies. ``on_phase(phase, percent)`` reports coarse progress.

        Raises RuntimeError on engine failure or if the user cancels.
        """
        ...
