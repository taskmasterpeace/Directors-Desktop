"""fal.ai API client for cloud video generation (Seedance 2.0).

Implements the ``VideoAPIClient`` protocol against fal's queue REST API.

fal specifics (verified against the fal model docs for ``bytedance/seedance-2.0``):
- Auth header is ``Authorization: Key <key>`` (not Bearer).
- The image-to-video route requires ``image_url``; ``end_image_url`` is the optional last frame.
- ``resolution`` is one of 480p/720p/1080p; ``duration`` is an int in [4, 15].
- Submit returns ``status_url`` / ``response_url``; poll status, then GET the response for ``video.url``.
"""

from __future__ import annotations

import logging
import time
from typing import Any, cast

from services.http_client.http_client import HTTPClient
from services.services_utils import JSONValue

logger = logging.getLogger(__name__)

FAL_QUEUE_BASE_URL = "https://queue.fal.run"

# model -> {mode: route}. ref = omni reference (reference-to-video).
_MODEL_ROUTES: dict[str, dict[str, str]] = {
    "seedance-2.0": {
        "i2v": "bytedance/seedance-2.0/image-to-video",
        "t2v": "bytedance/seedance-2.0/text-to-video",
        "ref": "bytedance/seedance-2.0/reference-to-video",
    },
    "seedance-2.0-fast": {
        "i2v": "bytedance/seedance-2.0/fast/image-to-video",
        "t2v": "bytedance/seedance-2.0/fast/text-to-video",
        "ref": "bytedance/seedance-2.0/fast/reference-to-video",
    },
}

_FAL_RESOLUTIONS = ("480p", "720p", "1080p")
_MIN_DURATION = 4
_MAX_DURATION = 15
_MAX_REF_IMAGES = 9
_MAX_REF_AUDIO = 3
_POLL_INTERVAL_SECONDS = 2
_POLL_TIMEOUT_SECONDS = 600


class FalVideoClientImpl:
    def __init__(self, http: HTTPClient, *, queue_base_url: str = FAL_QUEUE_BASE_URL) -> None:
        self._http = http
        self._base_url = queue_base_url.rstrip("/")

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
        camera_fixed: bool = False,  # noqa: ARG002 - not a Seedance 2.0 input
    ) -> bytes:
        routes = _MODEL_ROUTES.get(model)
        if routes is None:
            raise RuntimeError(f"Unknown video model: {model}")

        # Omni-reference mode (image_urls/audio_urls) wins over single first/last frame.
        if reference_images:
            route = routes["ref"]
        elif first_frame is not None:
            route = routes["i2v"]
        else:
            route = routes["t2v"]

        input_payload = self._build_input(
            prompt=prompt,
            duration=duration,
            resolution=resolution,
            aspect_ratio=aspect_ratio,
            generate_audio=generate_audio,
            first_frame=first_frame,
            last_frame=last_frame,
            reference_images=reference_images,
            reference_audio=reference_audio,
            seed=seed,
        )

        submit = self._submit(api_key=api_key, route=route, input_payload=input_payload)
        response_url = self._wait_for_completion(api_key=api_key, submit=submit)
        video_url = self._extract_video_url(self._fetch_result(api_key=api_key, response_url=response_url))
        return self._download(api_key=api_key, url=video_url)

    @staticmethod
    def _build_input(
        *,
        prompt: str,
        duration: int,
        resolution: str,
        aspect_ratio: str,
        generate_audio: bool,
        first_frame: str | None,
        last_frame: str | None,
        reference_images: list[str] | None,
        reference_audio: list[str] | None,
        seed: int | None,
    ) -> dict[str, JSONValue]:
        payload: dict[str, JSONValue] = {
            "prompt": prompt,
            "resolution": _normalize_resolution(resolution),
            "duration": max(_MIN_DURATION, min(_MAX_DURATION, int(duration))),
            "aspect_ratio": aspect_ratio,
            "generate_audio": generate_audio,
        }
        if seed is not None:
            payload["seed"] = seed
        if reference_images:
            # Omni reference: up to 9 images, up to 3 audio (audio requires >=1 image).
            payload["image_urls"] = cast("list[JSONValue]", list(reference_images)[:_MAX_REF_IMAGES])
            if reference_audio:
                payload["audio_urls"] = cast("list[JSONValue]", list(reference_audio)[:_MAX_REF_AUDIO])
        elif first_frame is not None:
            payload["image_url"] = first_frame
            if last_frame is not None:
                payload["end_image_url"] = last_frame
        return payload

    def _submit(
        self, *, api_key: str, route: str, input_payload: dict[str, JSONValue]
    ) -> dict[str, Any]:
        url = f"{self._base_url}/{route}"
        resp = self._http.post(
            url,
            headers=self._headers(api_key),
            json_payload=input_payload,
            timeout=120,
        )
        if resp.status_code not in (200, 201):
            detail = resp.text[:500] if resp.text else "Unknown error"
            raise RuntimeError(f"fal submit failed ({resp.status_code}): {detail}")
        data = self._json_object(resp.json(), context="submit")
        # Some fal responses include the result directly; most return queue urls.
        return data

    def _wait_for_completion(self, *, api_key: str, submit: dict[str, Any]) -> str:
        status = str(submit.get("status", "")).upper()
        status_url = submit.get("status_url")
        response_url = submit.get("response_url")
        if not isinstance(response_url, str) or not response_url:
            raise RuntimeError("fal submit response missing response_url")

        if status == "COMPLETED":
            return response_url
        if status in ("FAILED", "ERROR"):
            raise RuntimeError(f"fal request failed: {submit.get('error', 'Unknown error')}")
        if not isinstance(status_url, str) or not status_url:
            raise RuntimeError("fal submit response missing status_url")

        deadline = time.monotonic() + _POLL_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            resp = self._http.get(status_url, headers=self._headers(api_key), timeout=30)
            # fal's queue status endpoint returns 202 while IN_QUEUE/IN_PROGRESS and 200 when
            # COMPLETED — both carry a JSON {"status": ...} body. Only 4xx/5xx is a real failure.
            if resp.status_code not in (200, 202):
                detail = resp.text[:500] if resp.text else "Unknown error"
                raise RuntimeError(f"fal status poll failed ({resp.status_code}): {detail}")
            data = self._json_object(resp.json(), context="status")
            poll_status = str(data.get("status", "")).upper()
            if poll_status == "COMPLETED":
                return response_url
            if poll_status in ("FAILED", "ERROR"):
                raise RuntimeError(f"fal request failed: {data.get('error', 'Unknown error')}")
            time.sleep(_POLL_INTERVAL_SECONDS)

        raise RuntimeError("fal request timed out")

    def _fetch_result(self, *, api_key: str, response_url: str) -> dict[str, Any]:
        resp = self._http.get(response_url, headers=self._headers(api_key), timeout=60)
        if resp.status_code != 200:
            detail = resp.text[:500] if resp.text else "Unknown error"
            raise RuntimeError(f"fal result fetch failed ({resp.status_code}): {detail}")
        return self._json_object(resp.json(), context="result")

    def _download(self, *, api_key: str, url: str) -> bytes:
        resp = self._http.get(url, headers=self._headers(api_key), timeout=300)
        if resp.status_code != 200:
            detail = resp.text[:500] if resp.text else "Unknown error"
            raise RuntimeError(f"fal video download failed ({resp.status_code}): {detail}")
        if not resp.content:
            raise RuntimeError("fal video download returned empty body")
        return resp.content

    @staticmethod
    def _headers(api_key: str) -> dict[str, str]:
        return {
            "Authorization": f"Key {api_key}",
            "Content-Type": "application/json",
        }

    @staticmethod
    def _extract_video_url(result: dict[str, Any]) -> str:
        video = result.get("video")
        if isinstance(video, dict):
            url = cast(dict[str, Any], video).get("url")
            if isinstance(url, str) and url:
                return url
        # Some variants return a list of videos.
        videos = result.get("videos")
        if isinstance(videos, list) and videos:
            first = cast(list[Any], videos)[0]
            if isinstance(first, dict):
                url = cast(dict[str, Any], first).get("url")
                if isinstance(url, str) and url:
                    return url
        raise RuntimeError("fal result missing video url")

    @staticmethod
    def _json_object(payload: object, *, context: str) -> dict[str, Any]:
        if isinstance(payload, dict):
            return cast(dict[str, Any], payload)
        raise RuntimeError(f"Unexpected fal {context} response format")


def _normalize_resolution(resolution: str) -> str:
    value = (resolution or "").strip().lower()
    if value in _FAL_RESOLUTIONS:
        return value
    digits = "".join(ch for ch in value if ch.isdigit())
    height = int(digits) if digits else 720
    if height <= 480:
        return "480p"
    if height >= 1080:
        return "1080p"
    return "720p"
