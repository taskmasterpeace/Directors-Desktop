"""Director's Palette image client — routes desktop image generation through Palette's
**live v2 API** (Bearer ``dp_`` key), running on the user's Palette credits.

Three operations, all against ``https://directorspal.com``:

- ``upload_reference``     POST /api/v2/images/upload         (multipart) -> public URL
- ``generate_image``      POST /api/v2/images/generate       -> job, then poll
                          GET  /api/v2/jobs/{job_id}         until completed -> image bytes
- ``generate_camera_angle`` POST /api/v2/images/camera-angle (synchronous) -> image bytes

v2 rejects inline base64 (SSRF guard), so local reference images must be uploaded first
to obtain a public URL. Every response uses the envelope ``{"success": bool, "data": …}``.
Completion of an async job is driven by Palette's own Replicate webhook (which writes
``result: {url}``); the desktop only polls — it never needs a webhook receiver.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, cast

from services.services_utils import JSONValue

if TYPE_CHECKING:
    from services.http_client.http_client import HttpResponseLike
    from services.interfaces import HTTPClient

# The live Director's Palette domain (verified: /api/v1/images/generate returns 401, not 404).
# NB: "directorspalette.com" used elsewhere in the app does NOT resolve — this is the real one,
# matching the sync client's connect URL.
PALETTE_BASE_URL = "https://directorspal.com"


class PaletteImageClientImpl:
    def __init__(
        self,
        http: "HTTPClient",
        *,
        base_url: str = PALETTE_BASE_URL,
        poll_interval: float = 2.0,
        poll_timeout: float = 300.0,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._http = http
        self._base_url = base_url.rstrip("/")
        self._poll_interval = poll_interval
        self._poll_timeout = poll_timeout
        self._sleep = sleep

    # -- reference upload -----------------------------------------------------

    def upload_reference(
        self,
        *,
        api_key: str,
        image_bytes: bytes,
        file_name: str = "reference.png",
        content_type: str = "image/png",
    ) -> str:
        """Upload one local image to Palette storage and return its public URL.

        v2's generate/camera-angle routes require public http URLs for references
        (their SSRF guard rejects data: URIs), so callers upload first, then pass
        the returned URL.
        """
        resp = self._http.post(
            f"{self._base_url}/api/v2/images/upload",
            # No Content-Type header — requests sets the multipart boundary itself.
            headers={"Authorization": f"Bearer {api_key}"},
            files={"file": (file_name, image_bytes, content_type)},
            timeout=180,
        )
        self._raise_for_status(resp, "upload")
        url = self._data(resp).get("url")
        if not isinstance(url, str) or not url:
            raise RuntimeError("Director's Palette upload response missing url")
        return url

    # -- standard models (async: submit + poll) -------------------------------

    def generate_image(
        self,
        *,
        api_key: str,
        model: str,
        prompt: str,
        aspect_ratio: str = "16:9",
        reference_image_urls: list[str] | None = None,
        params: dict[str, object] | None = None,
    ) -> bytes:
        """Generate ONE image via /api/v2/images/generate and return the bytes.

        Submits the job, polls /api/v2/jobs/{job_id} until it completes, then
        downloads the resulting image. `params` carries per-model settings
        (resolution / quality / background / moderation / seed / …) forwarded
        into the request body; core fields below always win on key clash.
        """
        payload: dict[str, JSONValue] = {}
        if params:
            payload.update(cast("dict[str, JSONValue]", params))
        payload["model"] = model
        payload["prompt"] = prompt
        payload["aspect_ratio"] = aspect_ratio
        payload["num_images"] = 1
        if reference_image_urls:
            payload["reference_images"] = cast("list[JSONValue]", list(reference_image_urls))

        resp = self._http.post(
            f"{self._base_url}/api/v2/images/generate",
            headers=self._json_headers(api_key),
            json_payload=payload,
            timeout=120,
        )
        self._raise_for_status(resp, "generate")

        data = self._data(resp)
        # Fast path: a response that already carries the finished image URL.
        url = self._result_url(data)
        if not url:
            job_id = data.get("job_id")
            if not isinstance(job_id, str) or not job_id:
                raise RuntimeError("Director's Palette generate response missing job_id")
            url = self._poll_job(api_key=api_key, job_id=job_id)
        return self._download(url)

    def _poll_job(self, *, api_key: str, job_id: str) -> str:
        """Poll GET /api/v2/jobs/{job_id} until completed (-> url) or failed/timeout."""
        elapsed = 0.0
        while elapsed <= self._poll_timeout:
            resp = self._http.get(
                f"{self._base_url}/api/v2/jobs/{job_id}",
                headers={"Authorization": f"Bearer {api_key}"},
                timeout=30,
            )
            self._raise_for_status(resp, "job status")
            data = self._data(resp)
            status = data.get("status")
            if status == "completed":
                url = self._result_url(data)
                if not url:
                    raise RuntimeError("Director's Palette job completed without a result url")
                return url
            if status == "failed":
                message = data.get("error_message")
                detail = message if isinstance(message, str) and message else "unknown error"
                raise RuntimeError(f"Director's Palette image generation failed: {detail}")
            self._sleep(self._poll_interval)
            elapsed += self._poll_interval
        raise RuntimeError("Director's Palette image generation timed out")

    # -- camera angle (synchronous) -------------------------------------------

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
    ) -> bytes:
        """Orbit the camera around a subject via /api/v2/images/camera-angle.

        This route is synchronous — it builds the ``<sks>`` prompt + injects the
        multi-angle LoRA + polls Replicate server-side — so the gizmo's raw
        azimuth/elevation/distance go straight through and it returns the image URL.
        """
        payload: dict[str, JSONValue] = {
            "image_url": image_url,
            "azimuth": azimuth,
            "elevation": elevation,
            "distance": distance,
        }
        if prompt:
            payload["prompt"] = prompt
        if lora_scale is not None:
            payload["lora_scale"] = lora_scale
        if aspect_ratio:
            payload["aspect_ratio"] = aspect_ratio
        if output_format:
            payload["output_format"] = output_format

        resp = self._http.post(
            f"{self._base_url}/api/v2/images/camera-angle",
            headers=self._json_headers(api_key),
            json_payload=payload,
            timeout=300,
        )
        self._raise_for_status(resp, "camera angle")
        url = self._result_url(self._data(resp))
        if not url:
            raise RuntimeError("Director's Palette camera-angle response missing url")
        return self._download(url)

    # -- helpers --------------------------------------------------------------

    @staticmethod
    def _json_headers(api_key: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    @staticmethod
    def _raise_for_status(resp: "HttpResponseLike", op: str) -> None:
        if resp.status_code not in (200, 201):
            detail = resp.text[:300] if resp.text else "Unknown error"
            raise RuntimeError(f"Director's Palette {op} failed ({resp.status_code}): {detail}")

    @staticmethod
    def _data(resp: "HttpResponseLike") -> dict[str, Any]:
        """Unwrap the ``{success, data}`` v2 envelope; returns {} if malformed."""
        payload = resp.json()
        if isinstance(payload, dict):
            data = cast(dict[str, Any], payload).get("data")
            if isinstance(data, dict):
                return cast(dict[str, Any], data)
        return {}

    @staticmethod
    def _result_url(data: dict[str, Any]) -> str | None:
        """Pull the image URL from a completed job / sync response.

        Handles ``result: {url}`` (async webhook shape), ``result`` as a bare
        string, and a top-level ``url`` (camera-angle / upload shape).
        """
        result = data.get("result")
        if isinstance(result, dict):
            nested = cast(dict[str, Any], result).get("url")
            if isinstance(nested, str) and nested:
                return nested
        if isinstance(result, str) and result:
            return result
        url = data.get("url")
        if isinstance(url, str) and url:
            return url
        return None

    def _download(self, url: str) -> bytes:
        download = self._http.get(url, timeout=300)
        if download.status_code != 200:
            raise RuntimeError(f"Failed to download Palette image ({download.status_code})")
        if not download.content:
            raise RuntimeError("Director's Palette image download was empty")
        return download.content
