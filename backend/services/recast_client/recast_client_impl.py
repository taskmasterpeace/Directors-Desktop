"""fal-backed person replacement (Wan 2.2 Animate Replace / SCAIL-2).

Same queue protocol as the Seedance client: submit to queue.fal.run, poll the
status_url, fetch the result, download the video. Payloads per fal's published
schemas (July 2026):
- fal-ai/wan/v2.2-14b/animate/replace: { video_url, image_url, resolution? }
- fal-ai/scail-2: { prompt, image_url, video_url, mode: "replacement",
  resolution: "512p"|"704p" }
"""

from __future__ import annotations

import time
from typing import Any, Callable, cast

from services.http_client.http_client import HTTPClient
from services.recast_client.recast_client import RECAST_MODELS

FAL_QUEUE_BASE_URL = "https://queue.fal.run"

_POLL_INTERVAL_SECONDS = 2
_POLL_TIMEOUT_SECONDS = 900

_WAN_RESOLUTIONS = ("480p", "580p", "720p")
_SCAIL_RESOLUTIONS = ("512p", "704p")


class FalRecastClientImpl:
    def __init__(self, http: HTTPClient, *, queue_base_url: str = FAL_QUEUE_BASE_URL) -> None:
        self._http = http
        self._base_url = queue_base_url.rstrip("/")

    @staticmethod
    def _headers(api_key: str) -> dict[str, str]:
        return {"Authorization": f"Key {api_key}", "Content-Type": "application/json"}

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
        route = RECAST_MODELS.get(model)
        if route is None:
            raise RuntimeError(f"Unknown recast model: {model}")

        payload: dict[str, Any]
        if model == "scail-2-replace":
            res = resolution if resolution in _SCAIL_RESOLUTIONS else "704p"
            payload = {
                "prompt": prompt or "replace the person in the video with the reference character",
                "image_url": image_url,
                "video_url": video_url,
                "mode": "replacement",
                "resolution": res,
            }
        else:
            res = resolution if resolution in _WAN_RESOLUTIONS else "580p"
            payload = {"video_url": video_url, "image_url": image_url, "resolution": res}

        submit_resp = self._http.post(
            f"{self._base_url}/{route}",
            headers=self._headers(api_key),
            json_payload=payload,
            timeout=120,
        )
        if submit_resp.status_code not in (200, 201, 202):
            detail = submit_resp.text[:500] if submit_resp.text else "Unknown error"
            raise RuntimeError(f"fal recast submit failed ({submit_resp.status_code}): {detail}")
        submit = self._json_object(submit_resp.json(), context="submit")

        response_url = self._wait(api_key=api_key, submit=submit, should_cancel=should_cancel)
        result = self._json_object(
            self._get_json(api_key=api_key, url=response_url, context="result"), context="result"
        )
        out_url = self._extract_video_url(result)
        return self._download(api_key=api_key, url=out_url)

    # ── queue plumbing ───────────────────────────────────────────────────

    def _wait(
        self,
        *,
        api_key: str,
        submit: dict[str, Any],
        should_cancel: Callable[[], bool] | None,
    ) -> str:
        status_url = submit.get("status_url")
        response_url = submit.get("response_url")
        if not isinstance(status_url, str) or not isinstance(response_url, str):
            raise RuntimeError("fal recast submit missing status_url/response_url")
        cancel_url = submit.get("cancel_url")
        deadline = time.time() + _POLL_TIMEOUT_SECONDS
        while time.time() < deadline:
            if should_cancel is not None and should_cancel():
                if isinstance(cancel_url, str) and cancel_url:
                    try:
                        self._http.put(cancel_url, headers=self._headers(api_key), timeout=30)
                    except Exception:
                        pass
                raise RuntimeError("Recast was cancelled")
            status_obj = self._json_object(
                self._get_json(api_key=api_key, url=status_url, context="status"), context="status"
            )
            status = str(status_obj.get("status", "")).upper()
            if status == "COMPLETED":
                return response_url
            if status in ("FAILED", "ERROR", "CANCELLED"):
                raise RuntimeError(f"fal recast job {status.lower()}")
            time.sleep(_POLL_INTERVAL_SECONDS)
        raise RuntimeError("fal recast timed out")

    def _get_json(self, *, api_key: str, url: str, context: str) -> object:
        resp = self._http.get(url, headers=self._headers(api_key), timeout=60)
        if resp.status_code != 200:
            detail = resp.text[:500] if resp.text else "Unknown error"
            raise RuntimeError(f"fal recast {context} failed ({resp.status_code}): {detail}")
        return resp.json()

    @staticmethod
    def _json_object(value: object, *, context: str) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise RuntimeError(f"fal recast {context} returned an unexpected response")
        return cast(dict[str, Any], value)

    @staticmethod
    def _extract_video_url(result: dict[str, Any]) -> str:
        video = result.get("video")
        if isinstance(video, dict):
            url = cast(dict[str, Any], video).get("url")
            if isinstance(url, str) and url:
                return url
        # SCAIL-2 result nests the same {video: {url}} shape; guard alternates.
        url = result.get("video_url")
        if isinstance(url, str) and url:
            return url
        raise RuntimeError("fal recast result missing video url")

    def _download(self, *, api_key: str, url: str) -> bytes:
        resp = self._http.get(url, headers=self._headers(api_key), timeout=600)
        if resp.status_code != 200:
            detail = resp.text[:500] if resp.text else "Unknown error"
            raise RuntimeError(f"fal recast download failed ({resp.status_code}): {detail}")
        if not resp.content:
            raise RuntimeError("fal recast download returned empty body")
        return resp.content
