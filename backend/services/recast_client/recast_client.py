"""Protocol for person/character replacement in existing footage (Recast).

Swaps the tracked person in a video for a reference character image while
preserving motion, expression, scene, and camera. Cloud-hosted models only in
v1 (fal); the Protocol keeps a future local SCAIL-2 pipeline drop-in.
"""

from __future__ import annotations

from typing import Callable, Protocol

# Model ids the app exposes -> fal queue routes.
RECAST_MODELS: dict[str, str] = {
    # Wan 2.2 Animate, Replace mode — the workhorse: cheap, commercial-badged.
    "wan-animate-replace": "fal-ai/wan/v2.2-14b/animate/replace",
    # SCAIL-2, replacement mode — stylized characters/hard motion, <=10s.
    "scail-2-replace": "fal-ai/scail-2",
}


class RecastClient(Protocol):
    def replace(
        self,
        *,
        api_key: str,
        model: str,
        video_url: str,
        image_url: str,
        resolution: str,
        prompt: str = "",
        should_cancel: Callable[[], bool] | None = None,
    ) -> bytes:
        """Run the replacement and return the finished video bytes.

        Raises RuntimeError on provider errors or unknown model."""
        ...
