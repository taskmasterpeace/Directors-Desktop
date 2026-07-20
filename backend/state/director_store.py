"""Persistent state for Director runs (music-video builds).

Same durability pattern as the job queue: dataclasses serialized to one JSON
file, atomic temp+replace writes, RLock, bounded history. A run is the
crash-resumable record of the whole pipeline — analysis, plan, per-shot job
tracking, output — so an interrupted build resumes instead of restarting.
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Literal, cast

DirectorPhase = Literal[
    "analyzing", "generating", "assembling", "complete", "error", "cancelled"
]

_TERMINAL: tuple[DirectorPhase, ...] = ("complete", "error", "cancelled")
MAX_RUNS_KEPT = 20


@dataclass
class DirectorShot:
    index: int
    start: float
    end: float
    section_label: str
    shot_type: str
    prompt: str
    generate_seconds: int
    status: Literal["pending", "submitted", "complete", "error"] = "pending"
    job_id: str | None = None
    result_path: str | None = None
    error: str | None = None
    retries: int = 0

    @property
    def duration(self) -> float:
        return self.end - self.start


@dataclass
class DirectorRun:
    id: str
    audio_path: str
    concept: str
    model: str
    resolution: str
    created_at: float
    phase: DirectorPhase = "analyzing"
    error: str | None = None
    analysis: dict[str, object] | None = None
    shots: list[DirectorShot] = field(default_factory=lambda: list[DirectorShot]())
    output_path: str | None = None
    reference_image_paths: list[str] = field(default_factory=lambda: list[str]())

    @property
    def is_terminal(self) -> bool:
        return self.phase in _TERMINAL


class DirectorStore:
    def __init__(self, persistence_path: Path) -> None:
        self._path = persistence_path
        self._lock = threading.RLock()
        self._runs: list[DirectorRun] = []
        self._load()

    def create_run(
        self,
        *,
        audio_path: str,
        concept: str,
        model: str,
        resolution: str,
        reference_image_paths: list[str] | None = None,
    ) -> DirectorRun:
        run = DirectorRun(
            id=f"dir_{uuid.uuid4().hex[:10]}",
            audio_path=audio_path,
            concept=concept,
            model=model,
            resolution=resolution,
            created_at=time.time(),
            reference_image_paths=reference_image_paths or [],
        )
        with self._lock:
            self._runs.append(run)
            if len(self._runs) > MAX_RUNS_KEPT:
                # Drop oldest terminal runs first; never evict an active run.
                keep: list[DirectorRun] = []
                overflow = len(self._runs) - MAX_RUNS_KEPT
                for candidate in self._runs:
                    if overflow > 0 and candidate.is_terminal:
                        overflow -= 1
                        continue
                    keep.append(candidate)
                self._runs = keep
            self._save()
        return run

    def get_run(self, run_id: str) -> DirectorRun | None:
        with self._lock:
            return next((r for r in self._runs if r.id == run_id), None)

    def all_runs(self) -> list[DirectorRun]:
        with self._lock:
            return list(self._runs)

    def latest_run(self) -> DirectorRun | None:
        with self._lock:
            return self._runs[-1] if self._runs else None

    def save(self) -> None:
        """Persist after in-place mutation of a run (caller holds no lock)."""
        with self._lock:
            self._save()

    # ── persistence ──────────────────────────────────────────────────────

    def _save(self) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(".tmp")
            tmp.write_text(
                json.dumps([asdict(r) for r in self._runs], indent=1), encoding="utf-8"
            )
            os.replace(tmp, self._path)
        except OSError:
            pass  # persistence is best-effort; in-memory state stays authoritative

    def _load(self) -> None:
        try:
            if not self._path.is_file():
                return
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            if not isinstance(raw, list):
                return
            runs: list[DirectorRun] = []
            for item in cast(list[object], raw):
                if not isinstance(item, dict):
                    continue
                record = cast(dict[str, object], item)
                shots_raw = record.pop("shots", [])
                shots: list[DirectorShot] = []
                if isinstance(shots_raw, list):
                    for shot_obj in cast(list[object], shots_raw):
                        if isinstance(shot_obj, dict):
                            shots.append(DirectorShot(**cast(dict[str, object], shot_obj)))  # type: ignore[arg-type]
                run = DirectorRun(**cast(dict[str, object], record))  # type: ignore[arg-type]
                run.shots = shots
                runs.append(run)
            self._runs = runs
        except (OSError, json.JSONDecodeError, TypeError, UnicodeDecodeError):
            self._runs = []
