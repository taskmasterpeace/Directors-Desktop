"""Recast: replace the person in a clip's footage with a library character.

Runs as an ordinary api-slot queue job (model `wan-animate-replace` or
`scail-2-replace`): upload the local video + character image to fal storage,
call the replacement model, land the result in outputs (so it shows in the
Gallery and can come back as a take on the source asset).
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import TYPE_CHECKING, Callable

from _routes._errors import HTTPError
from server_utils.media_validation import normalize_optional_path
from services.recast_client import RecastClient
from services.upload_client.upload_client import UploadClient

if TYPE_CHECKING:
    from state.app_state_types import AppState

_IMAGE_CONTENT_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}

_VIDEO_CONTENT_TYPES = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".m4v": "video/x-m4v",
}


class RecastHandler:
    def __init__(
        self,
        *,
        state: "AppState",
        recast_client: RecastClient,
        upload_client: UploadClient,
        outputs_dir: Path,
    ) -> None:
        self._state = state
        self._client = recast_client
        self._upload = upload_client
        self._outputs_dir = outputs_dir

    def execute(
        self,
        model: str,
        params: dict[str, object],
        should_cancel: Callable[[], bool] | None = None,
    ) -> list[str]:
        api_key = self._state.app_settings.fal_api_key.strip()
        if not api_key:
            raise HTTPError(400, "FAL_API_KEY_REQUIRED: person replacement renders on fal. Add your fal API key in Settings.")

        video_path = normalize_optional_path(str(params.get("videoPath") or ""))
        image_path = normalize_optional_path(str(params.get("characterImagePath") or ""))
        if not video_path or not Path(video_path).is_file():
            raise HTTPError(400, f"Video file not found: {params.get('videoPath')}")
        if not image_path or not Path(image_path).is_file():
            raise HTTPError(400, f"Character image not found: {params.get('characterImagePath')}")
        resolution = str(params.get("resolution") or "")
        prompt = str(params.get("prompt") or "")

        video_file = Path(video_path)
        image_file = Path(image_path)
        video_url = self._upload.upload(
            api_key=api_key,
            data=video_file.read_bytes(),
            content_type=_VIDEO_CONTENT_TYPES.get(video_file.suffix.lower(), "video/mp4"),
            file_name=video_file.name,
        )
        image_url = self._upload.upload(
            api_key=api_key,
            data=image_file.read_bytes(),
            content_type=_IMAGE_CONTENT_TYPES.get(image_file.suffix.lower(), "image/png"),
            file_name=image_file.name,
        )

        result = self._client.replace(
            api_key=api_key,
            model=model,
            video_url=video_url,
            image_url=image_url,
            resolution=resolution,
            prompt=prompt,
            should_cancel=should_cancel,
        )

        self._outputs_dir.mkdir(parents=True, exist_ok=True)
        out = self._outputs_dir / f"recast_{model.replace('-', '_')}_{int(time.time())}.mp4"
        out.write_bytes(result)
        return [str(out)]
