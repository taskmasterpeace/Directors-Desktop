"""Protocol for generating images through Director's Palette."""

from __future__ import annotations

from typing import Protocol


class PaletteImageClient(Protocol):
    def generate_image(
        self,
        *,
        api_key: str,
        model: str,
        prompt: str,
        aspect_ratio: str = "16:9",
        reference_image_urls: list[str] | None = None,
    ) -> bytes:
        """Generate one image via Director's Palette and return the raw bytes."""
        ...
