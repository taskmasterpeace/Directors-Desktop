"""ffmpeg-backed video trimmer (via imageio-ffmpeg's bundled binary).

Re-encodes rather than stream-copies so the end cut is frame-accurate — the
whole point of exact-duration mode. Clips are short (<=15s API generations),
so the re-encode cost is a couple of seconds. Audio is re-encoded to AAC when
present; files without an audio stream pass through untouched by the audio
flags (ffmpeg ignores codecs for absent streams).
"""

from __future__ import annotations

import logging
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable, Generator, cast

logger = logging.getLogger(__name__)

_TRIM_TIMEOUT_SECONDS = 120

# imageio-ffmpeg ships no type stubs; type its two entry points at the boundary.
_FrameReader = Generator[Any, None, None]


def _ffmpeg_exe() -> str:
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def _open_frame_reader(path: str) -> _FrameReader:
    import imageio_ffmpeg

    read_frames = cast(
        "Callable[[str], _FrameReader]",
        imageio_ffmpeg.read_frames,  # pyright: ignore[reportUnknownMemberType]
    )
    return read_frames(path)


class VideoTrimmerImpl:
    def probe_duration(self, path: str) -> float:
        reader = _open_frame_reader(path)
        try:
            meta_raw: Any = next(reader)
        finally:
            reader.close()
        meta = cast("dict[str, Any]", meta_raw) if isinstance(meta_raw, dict) else {}
        duration = meta.get("duration")
        if not isinstance(duration, (int, float)) or duration <= 0:
            raise RuntimeError(f"Could not read duration of {Path(path).name}")
        return float(duration)

    def trim_to(self, path: str, seconds: float) -> None:
        if seconds <= 0:
            raise RuntimeError(f"Invalid trim duration: {seconds}")
        source = Path(path)
        if not source.exists():
            raise RuntimeError(f"Video not found: {source.name}")

        fd, tmp_name = tempfile.mkstemp(suffix=source.suffix or ".mp4", dir=str(source.parent))
        os.close(fd)
        tmp = Path(tmp_name)
        try:
            args = [
                _ffmpeg_exe(),
                "-y",
                "-i", str(source),
                "-t", f"{seconds:.3f}",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "192k",
                "-movflags", "+faststart",
                str(tmp),
            ]
            result = subprocess.run(
                args, capture_output=True, timeout=_TRIM_TIMEOUT_SECONDS, check=False
            )
            if result.returncode != 0:
                tail = result.stderr.decode(errors="replace")[-400:]
                raise RuntimeError(f"ffmpeg trim failed ({result.returncode}): {tail}")
            if not tmp.exists() or tmp.stat().st_size == 0:
                raise RuntimeError("ffmpeg trim produced no output")
            os.replace(tmp, source)
        finally:
            if tmp.exists():
                try:
                    tmp.unlink()
                except OSError:
                    logger.warning("Could not remove temp trim file %s", tmp)
