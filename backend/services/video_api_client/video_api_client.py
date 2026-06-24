"""Video API client protocol for cloud video generation.

Implemented by provider-specific clients (Replicate Seedance 1.5, fal Seedance 2.0).
`first_frame` / `last_frame` accept either an https URL or a base64 ``data:`` URI.
"""

from __future__ import annotations

from typing import Protocol


class VideoAPIClient(Protocol):
    def generate_video(
        self,
        *,
        api_key: str,
        model: str,
        prompt: str,
        duration: int,
        resolution: str,
        aspect_ratio: str,
        generate_audio: bool,
        first_frame: str | None = None,
        last_frame: str | None = None,
        reference_images: list[str] | None = None,
        reference_audio: list[str] | None = None,
        seed: int | None = None,
        camera_fixed: bool = False,
    ) -> bytes:
        ...
