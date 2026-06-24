"""Replicate API client implementation for cloud video generation (Seedance 1.5 Pro).

Param names verified against the live Replicate schema for ``bytedance/seedance-1.5-pro``:
first frame is ``image``, last frame is ``last_frame_image`` (only honored when ``image`` is
also set), and there is NO ``resolution`` input. Duration is an int in [2, 12].
"""

from __future__ import annotations

import logging
import time
from typing import Any, cast

from services.http_client.http_client import HTTPClient
from services.services_utils import JSONValue

logger = logging.getLogger(__name__)

REPLICATE_API_BASE_URL = "https://api.replicate.com/v1"

_MODEL_ROUTES: dict[str, str] = {
    "seedance-1.5-pro": "bytedance/seedance-1.5-pro",
}

# Verified live: the ByteDance model rejects durations below 4s ("duration is not
# supported for model seedance-1-5-pro") even though Replicate's schema declares [2,12].
_MIN_DURATION = 4
_MAX_DURATION = 12
_POLL_INTERVAL_SECONDS = 2
_POLL_TIMEOUT_SECONDS = 300


class ReplicateVideoClientImpl:
    def __init__(self, http: HTTPClient, *, api_base_url: str = REPLICATE_API_BASE_URL) -> None:
        self._http = http
        self._base_url = api_base_url.rstrip("/")

    def generate_video(
        self,
        *,
        api_key: str,
        model: str,
        prompt: str,
        duration: int,
        resolution: str,  # noqa: ARG002 - seedance-1.5-pro has no resolution input
        aspect_ratio: str,
        generate_audio: bool,
        first_frame: str | None = None,
        last_frame: str | None = None,
        reference_images: list[str] | None = None,  # noqa: ARG002 - Seedance 1.5 has no refs
        reference_audio: list[str] | None = None,  # noqa: ARG002 - Seedance 1.5 has no refs
        seed: int | None = None,
        camera_fixed: bool = False,
    ) -> bytes:
        replicate_model = _MODEL_ROUTES.get(model)
        if replicate_model is None:
            raise RuntimeError(f"Unknown video model: {model}")

        input_payload = self._build_input(
            prompt=prompt,
            duration=duration,
            aspect_ratio=aspect_ratio,
            generate_audio=generate_audio,
            first_frame=first_frame,
            last_frame=last_frame,
            seed=seed,
            camera_fixed=camera_fixed,
        )

        prediction = self._create_prediction(
            api_key=api_key,
            replicate_model=replicate_model,
            input_payload=input_payload,
        )

        output_url = self._wait_for_output(api_key, prediction)
        return self._download_video(api_key, output_url)

    @staticmethod
    def _build_input(
        *,
        prompt: str,
        duration: int,
        aspect_ratio: str,
        generate_audio: bool,
        first_frame: str | None,
        last_frame: str | None,
        seed: int | None,
        camera_fixed: bool,
    ) -> dict[str, JSONValue]:
        clamped_duration = max(_MIN_DURATION, min(_MAX_DURATION, int(duration)))
        resolved_seed = seed if seed is not None else int(time.time()) % 2_147_483_647

        input_payload: dict[str, JSONValue] = {
            "prompt": prompt,
            "duration": clamped_duration,
            "aspect_ratio": aspect_ratio,
            "fps": 24,
            "generate_audio": generate_audio,
            "camera_fixed": camera_fixed,
            "seed": resolved_seed,
        }

        if first_frame is not None:
            input_payload["image"] = first_frame
            # last_frame_image only takes effect when a start image is provided.
            if last_frame is not None:
                input_payload["last_frame_image"] = last_frame
        elif last_frame is not None:
            logger.warning(
                "Seedance 1.5 last frame ignored: a start frame is required for last_frame_image",
            )

        return input_payload

    def _create_prediction(
        self,
        *,
        api_key: str,
        replicate_model: str,
        input_payload: dict[str, JSONValue],
    ) -> dict[str, Any]:
        url = f"{self._base_url}/models/{replicate_model}/predictions"
        payload: dict[str, JSONValue] = {"input": input_payload}

        response = self._http.post(
            url,
            headers=self._headers(api_key, prefer_wait=True),
            json_payload=payload,
            timeout=300,
        )
        if response.status_code not in (200, 201):
            detail = response.text[:500] if response.text else "Unknown error"
            raise RuntimeError(f"Replicate prediction failed ({response.status_code}): {detail}")

        return self._json_object(response.json(), context="create prediction")

    def _wait_for_output(self, api_key: str, prediction: dict[str, Any]) -> str:
        status = prediction.get("status", "")
        if status == "succeeded":
            return self._extract_output_url(prediction)

        if status in ("failed", "canceled"):
            error = prediction.get("error", "Unknown error")
            raise RuntimeError(f"Replicate prediction failed ({status}): {error}")

        poll_url = prediction.get("urls", {}).get("get")
        if not isinstance(poll_url, str) or not poll_url:
            prediction_id = prediction.get("id", "")
            poll_url = f"{self._base_url}/predictions/{prediction_id}"

        deadline = time.monotonic() + _POLL_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            time.sleep(_POLL_INTERVAL_SECONDS)
            resp = self._http.get(poll_url, headers=self._headers(api_key), timeout=30)
            if resp.status_code != 200:
                detail = resp.text[:500] if resp.text else "Unknown error"
                raise RuntimeError(f"Replicate poll failed ({resp.status_code}): {detail}")

            data = self._json_object(resp.json(), context="poll")
            poll_status = data.get("status", "")
            if poll_status == "succeeded":
                return self._extract_output_url(data)
            if poll_status in ("failed", "canceled"):
                error = data.get("error", "Unknown error")
                raise RuntimeError(f"Replicate prediction failed ({poll_status}): {error}")

        raise RuntimeError("Replicate prediction timed out")

    def _download_video(self, api_key: str, url: str) -> bytes:
        download = self._http.get(url, headers=self._headers(api_key), timeout=300)
        if download.status_code != 200:
            detail = download.text[:500] if download.text else "Unknown error"
            raise RuntimeError(f"Replicate video download failed ({download.status_code}): {detail}")
        if not download.content:
            raise RuntimeError("Replicate video download returned empty body")
        return download.content

    @staticmethod
    def _headers(api_key: str, *, prefer_wait: bool = False) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        if prefer_wait:
            headers["Prefer"] = "wait"
        return headers

    @staticmethod
    def _extract_output_url(prediction: dict[str, Any]) -> str:
        output = prediction.get("output")
        if isinstance(output, list) and output:
            output_list = cast(list[object], output)
            first = output_list[0]
            if isinstance(first, str) and first:
                return first

        if isinstance(output, str) and output:
            return output

        raise RuntimeError("Replicate response missing output URL")

    @staticmethod
    def _json_object(payload: object, *, context: str) -> dict[str, Any]:
        if isinstance(payload, dict):
            return cast(dict[str, Any], payload)
        raise RuntimeError(f"Unexpected Replicate {context} response format")
