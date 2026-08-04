"""Recast: replace the person in a clip's footage with a library character.

Runs as an ordinary api-slot queue job (model `wan-animate-replace` or
`scail-2-replace`): upload the local video + character image to fal storage,
call the replacement model, land the result in outputs (so it shows in the
Gallery and can come back as a take on the source asset).
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import TYPE_CHECKING, Callable

from _routes._errors import HTTPError
from server_utils.media_validation import normalize_optional_path
from services.recast_client import RecastClient
from services.upload_client.upload_client import UploadClient

if TYPE_CHECKING:
    from state.app_state_types import AppState

logger = logging.getLogger(__name__)

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


def _default_extract_segment(video_path: str, start: float, duration: float) -> str:
    """Cut [start, start+duration) into a temp mp4 (re-encoded for frame accuracy)."""
    import imageio_ffmpeg

    out = Path(tempfile.mkdtemp(prefix="recast_seg_")) / "segment.mp4"
    result = subprocess.run(
        [
            str(imageio_ffmpeg.get_ffmpeg_exe()), "-y",
            "-ss", f"{max(0.0, start):.3f}",
            "-i", video_path,
            "-t", f"{max(0.1, duration):.3f}",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-pix_fmt", "yuv420p", "-an",
            str(out),
        ],
        capture_output=True,
        timeout=300,
        check=False,
    )
    if result.returncode != 0 or not out.is_file():
        tail = result.stderr.decode(errors="replace")[-400:]
        raise RuntimeError(f"Could not trim footage for replacement: {tail}")
    return str(out)


class RecastHandler:
    def __init__(
        self,
        *,
        state: "AppState",
        recast_client: RecastClient,
        upload_client: UploadClient,
        outputs_dir: Path,
        extract_segment: Callable[[str, float, float], str] | None = None,
    ) -> None:
        self._state = state
        self._client = recast_client
        self._upload = upload_client
        self._outputs_dir = outputs_dir
        self._extract_segment = extract_segment or _default_extract_segment

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

        # Billing is per second of footage: trim to the clip's source window
        # before upload so a 3s clip cut from a 60s take costs 3s, not 60s.
        trim_start = params.get("trimStart")
        trim_duration = params.get("trimDuration")
        segment_path: str | None = None
        if isinstance(trim_start, (int, float)) and isinstance(trim_duration, (int, float)) and trim_duration > 0:
            segment_path = self._extract_segment(video_path, float(trim_start), float(trim_duration))
            video_path = segment_path
        else:
            # No trim window: the ENTIRE source file is uploaded and billed per
            # second. Fine for a clip that IS the take, expensive if it's a short
            # cut from a long one. Warn so an accidental omission is visible in
            # logs rather than only on the invoice.
            logger.warning(
                "Recast has no trim window — uploading and billing the whole file "
                "(%s). Pass trimStart+trimDuration to bill only the clip.",
                video_path,
            )

        try:
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
        finally:
            if segment_path is not None:
                parent = Path(segment_path).parent
                # Only remove the extractor's own dedicated temp dir — never a
                # caller-owned directory an injected extractor might return.
                if parent.name.startswith("recast_seg_"):
                    shutil.rmtree(parent, ignore_errors=True)
