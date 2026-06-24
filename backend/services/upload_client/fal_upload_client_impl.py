"""fal storage upload client (2-step initiate + PUT).

Mirrors the fal SDK's ``fal.storage.upload`` flow:
1. POST ``/storage/upload/initiate`` with ``Authorization: Key <key>`` and
   ``{content_type, file_name}`` → ``{upload_url, file_url}``.
2. PUT the raw bytes to ``upload_url`` with the content type.
3. Use ``file_url`` as the hosted URL passed to the model.
"""

from __future__ import annotations

from typing import Any, cast

from services.http_client.http_client import HTTPClient

FAL_REST_BASE_URL = "https://rest.alpha.fal.ai"


class FalUploadClientImpl:
    def __init__(self, http: HTTPClient, *, rest_base_url: str = FAL_REST_BASE_URL) -> None:
        self._http = http
        self._base_url = rest_base_url.rstrip("/")

    def upload(self, *, api_key: str, data: bytes, content_type: str, file_name: str) -> str:
        initiate = self._http.post(
            f"{self._base_url}/storage/upload/initiate?storage_type=fal-cdn-v3",
            headers={"Authorization": f"Key {api_key}", "Content-Type": "application/json"},
            json_payload={"content_type": content_type, "file_name": file_name},
            timeout=60,
        )
        if initiate.status_code not in (200, 201):
            detail = initiate.text[:300] if initiate.text else "Unknown error"
            raise RuntimeError(f"fal upload initiate failed ({initiate.status_code}): {detail}")

        payload = initiate.json()
        if not isinstance(payload, dict):
            raise RuntimeError("fal upload initiate returned an unexpected response")
        body = cast(dict[str, Any], payload)
        upload_url = body.get("upload_url")
        file_url = body.get("file_url")
        if not isinstance(upload_url, str) or not isinstance(file_url, str) or not upload_url or not file_url:
            raise RuntimeError("fal upload initiate missing upload_url/file_url")

        put = self._http.put(
            upload_url,
            data=data,
            headers={"Content-Type": content_type},
            timeout=300,
        )
        if put.status_code not in (200, 201, 204):
            detail = put.text[:300] if put.text else "Unknown error"
            raise RuntimeError(f"fal upload PUT failed ({put.status_code}): {detail}")

        return file_url
