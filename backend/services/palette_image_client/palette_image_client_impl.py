"""Director's Palette image client — calls POST /api/v1/images/generate with a dp_ API key.

DP runs the image model on the user's account/credits and returns a hosted image URL, which
we download and return as bytes (so the rest of the pipeline treats it like any other image).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, cast

from services.services_utils import JSONValue

if TYPE_CHECKING:
    from services.interfaces import HTTPClient

# The live Director's Palette domain (verified: /api/v1/images/generate returns 401, not 404).
# NB: "directorspalette.com" used elsewhere in the app does NOT resolve — this is the real one,
# matching the sync client's connect URL.
PALETTE_BASE_URL = "https://directorspal.com"


class PaletteImageClientImpl:
    def __init__(self, http: "HTTPClient", *, base_url: str = PALETTE_BASE_URL) -> None:
        self._http = http
        self._base_url = base_url.rstrip("/")

    def generate_image(
        self,
        *,
        api_key: str,
        model: str,
        prompt: str,
        aspect_ratio: str = "16:9",
        reference_image_urls: list[str] | None = None,
    ) -> bytes:
        payload: dict[str, JSONValue] = {
            "prompt": prompt,
            "model": model,
            "aspectRatio": aspect_ratio,
        }
        if reference_image_urls:
            payload["referenceImages"] = cast("list[JSONValue]", list(reference_image_urls))

        resp = self._http.post(
            f"{self._base_url}/api/v1/images/generate",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json_payload=payload,
            timeout=300,
        )
        if resp.status_code != 200:
            detail = resp.text[:300] if resp.text else "Unknown error"
            raise RuntimeError(f"Director's Palette image generation failed ({resp.status_code}): {detail}")

        image_url = self._extract_image_url(resp.json())
        if not image_url:
            raise RuntimeError("Director's Palette response missing imageUrl")

        download = self._http.get(image_url, timeout=300)
        if download.status_code != 200:
            raise RuntimeError(f"Failed to download Palette image ({download.status_code})")
        if not download.content:
            raise RuntimeError("Director's Palette image download was empty")
        return download.content

    @staticmethod
    def _extract_image_url(payload: object) -> str | None:
        if not isinstance(payload, dict):
            return None
        data = cast(dict[str, Any], payload)
        url = data.get("imageUrl")
        if isinstance(url, str) and url:
            return url
        # Anchor-transform mode returns an array instead.
        images = data.get("images")
        if isinstance(images, list) and images:
            first = cast(list[Any], images)[0]
            if isinstance(first, str) and first:
                return first
        return None
