"""Video trimmer service protocol.

Conforms generated videos to an exact requested duration. Providers round the
requested seconds up to their supported range (Seedance 1.5: 4-12s, Seedance
2.0: 4-15s, local LTX rounds to frame-batch boundaries), so "give me exactly
3 seconds" means: generate at the nearest supported duration, then trim the
file back to precisely the requested length — audio included.
"""

from __future__ import annotations

from typing import Protocol


class VideoTrimmer(Protocol):
    def probe_duration(self, path: str) -> float:
        """Return the media duration in seconds."""
        ...

    def trim_to(self, path: str, seconds: float) -> None:
        """Trim the file in place so it lasts exactly `seconds` from the start,
        preserving the audio track. Raises on failure."""
        ...
