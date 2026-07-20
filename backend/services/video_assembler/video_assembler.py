"""Protocol for cutting generated shots to length and muxing the song under them."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class AssemblyShot:
    video_path: str
    duration: float  # exact seconds to keep from the head of the clip


class VideoAssembler(Protocol):
    def assemble(self, *, shots: list[AssemblyShot], audio_path: str, output_path: str) -> None:
        """Trim each shot to its duration, concatenate in order, lay the song
        audio under the picture. Raises RuntimeError on ffmpeg failure."""
        ...
