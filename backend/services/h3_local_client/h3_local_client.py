"""Protocol for LOCAL MiniMax H3 video generation on the user's GPU.

H3 is a NATIVE LOCAL video engine in Directors Desktop — NOT fal, NOT any cloud
host. It runs on the user's 4090-class GPU under MKL's special MiniMax license
permission (the public H3 Community License excludes the US, EU, UK, and South
Korea from local deployment; MKL holds an individual authorization). The license
requires the UI show "MiniMax H3" attribution.

This Protocol is the swap boundary between the shipped-goal NATIVE pipeline and
the Phase-1 implementation that drives the proven ComfyUI node graph (ported from
the validated `render.py` battery on the 4090). Everything above this boundary
(queue, gpu-slot routing, model picker, ETA) is engine-agnostic, so Phase 2 can
replace the engine without touching the rest of the app.
"""

from __future__ import annotations

from typing import Callable, Literal, Protocol

# The single DD video-model id for local H3. Routes to the "gpu" slot (free,
# user's GPU) — never the "api" slot.
H3_LOCAL_MODEL = "h3-local"

H3Quant = Literal["int8", "fp8"]

# Proven pixel tiers as (16:9, 9:16) — portrait measured free (same cost) across
# four battery pairs. int4 is disqualified (crosshatch noise); int8 is the
# quality workhorse. Dims are the exact ones from the 4090 runs.
H3_RESOLUTIONS: dict[str, tuple[tuple[int, int], tuple[int, int]]] = {
    "480p": ((854, 480), (480, 854)),
    "544p": ((960, 544), (544, 960)),
    "720p": ((1280, 704), (704, 1280)),
}

H3_MAX_SECONDS = 15
H3_FPS = 24

# Text encoders (Qwen3-VL-32B for H3), in preference order for a 24GB card:
#   1. NVFP4 Heretic (uncensored, ~15.7GB) — fits 24GB (peak ~10GB), the right pick.
#   2. int8 Heretic (uncensored, ~26GB) — works but spills to RAM on 24GB (~5.5min
#      vs ~2min); meant for 32GB cards.
#   3. nvfp4 AWQ (standard/censored, ~15.7GB) — safe fallback if no uncensored weights.
H3_TE_UNCENSORED_NVFP4 = "qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors"
H3_TE_UNCENSORED = "qwen3vl_32b_minimax_h3_ultra_uncensored_heretic_int8_convrot.safetensors"
H3_TE_FALLBACK = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"


def h3_dimensions(resolution: str, aspect: str) -> tuple[int, int]:
    """DD resolution + aspect -> (width, height). Falls back to 480p."""
    tiers = H3_RESOLUTIONS.get(resolution, H3_RESOLUTIONS["480p"])
    return tiers[0] if aspect == "16:9" else tiers[1]


def h3_snap_frames(seconds: float) -> int:
    """H3 generates on a 17k+5 frame grid; 5s -> 124, 15s -> 362. Rounding here
    keeps the frame count identical to what the engine actually produces (and to
    what the ETA model in generation-cost.ts was fitted against)."""
    n = max(5, round(seconds * H3_FPS))
    return n + (5 - (n % 17)) % 17


class H3LocalClient(Protocol):
    def generate_video(
        self,
        *,
        prompt: str,
        width: int,
        height: int,
        seconds: float,
        quant: H3Quant = "int8",
        reference_image_path: str | None = None,
        first_frame_path: str | None = None,
        last_frame_path: str | None = None,
        seed: int = 7,
        on_phase: Callable[[str, int], None] | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> str:
        """Render one H3 clip locally and return the absolute path to the mp4.

        A reference image selects omni-reference mode (character/artist lock);
        a first (and optional last) frame selects keyframe mode; neither = text
        -to-video. All modes emit native audio. `on_phase(phase, percent)`
        reports coarse progress (loading_model / inference / decoding).

        Raises RuntimeError on engine failure or if the user cancels.
        """
        ...
