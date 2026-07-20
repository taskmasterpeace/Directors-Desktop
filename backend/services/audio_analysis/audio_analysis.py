"""Protocol + result types for music analysis (the Director's listening pass).

Everything downstream (shot planning, beat-snapped cuts) consumes this shape;
the real implementation is librosa-based, tests use the fake.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


@dataclass(frozen=True)
class AudioSection:
    """One structural span of the song, best-effort labeled."""

    start: float
    end: float
    label: str  # 'intro' | 'verse' | 'chorus' | 'bridge' | 'outro' (best-effort)
    energy: float  # mean RMS in this span, normalized 0..1 across the song


@dataclass(frozen=True)
class AudioAnalysis:
    duration: float
    tempo_bpm: float
    beats: list[float] = field(default_factory=lambda: list[float]())
    downbeats: list[float] = field(default_factory=lambda: list[float]())
    sections: list[AudioSection] = field(default_factory=lambda: list[AudioSection]())


class AudioAnalyzer(Protocol):
    def analyze(self, audio_path: str) -> AudioAnalysis:
        """Analyze the file at audio_path. Raises ValueError if unreadable."""
        ...
