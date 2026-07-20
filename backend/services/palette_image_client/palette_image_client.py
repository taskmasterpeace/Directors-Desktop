"""Protocol for generating images through Director's Palette (v2 API)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Protocol


class PaletteImageClient(Protocol):
    def upload_reference(
        self,
        *,
        api_key: str,
        image_bytes: bytes,
        file_name: str = "reference.png",
        content_type: str = "image/png",
    ) -> str:
        """Upload one local image to Palette storage and return its public URL."""
        ...

    def generate_image(
        self,
        *,
        api_key: str,
        model: str,
        prompt: str,
        aspect_ratio: str = "16:9",
        reference_image_urls: list[str] | None = None,
        params: dict[str, object] | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> bytes:
        """Generate one image via Director's Palette v2 (submit + poll) and return the raw bytes.

        `params` carries extra per-model settings (resolution, quality, background,
        moderation, seed, …) forwarded into the request payload.
        """
        ...

    def generate_camera_angle(
        self,
        *,
        api_key: str,
        image_url: str,
        azimuth: float,
        elevation: float,
        distance: float,
        prompt: str | None = None,
        lora_scale: float | None = None,
        aspect_ratio: str | None = None,
        output_format: str | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> bytes:
        """Orbit the camera around a subject (qwen multi-angle) and return the raw bytes."""
        ...
