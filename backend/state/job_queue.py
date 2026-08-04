"""Persistent job queue for sequential generation processing."""

from __future__ import annotations

import json
import os
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal


@dataclass
class QueueJob:
    id: str
    type: Literal["video", "image"]
    model: str
    params: dict[str, Any]
    status: Literal["queued", "running", "complete", "error", "cancelled"]
    slot: Literal["gpu", "api"]
    progress: int = 0
    phase: str = "queued"
    result_paths: list[str] = field(default_factory=lambda: list[str]())
    error: str | None = None
    created_at: str = ""
    # Batch fields
    batch_id: str | None = None
    batch_index: int = 0
    depends_on: str | None = None
    auto_params: dict[str, str] = field(default_factory=lambda: dict[str, str]())
    tags: list[str] = field(default_factory=lambda: list[str]())


_TERMINAL = ("complete", "error", "cancelled")
# Cap retained finished jobs so a long session doesn't grow the queue file — and
# each /status poll payload — without bound.
MAX_FINISHED_JOBS = 200


class JobQueue:
    def __init__(self, persistence_path: Path) -> None:
        self._path = persistence_path
        # Reentrant: update_job() calls get_job(), both guarded, same thread.
        self._lock = threading.RLock()
        self._jobs: list[QueueJob] = []
        self._load()

    def submit(
        self,
        *,
        job_type: str,
        model: str,
        params: dict[str, Any],
        slot: str,
        job_id: str | None = None,
        batch_id: str | None = None,
        batch_index: int = 0,
        depends_on: str | None = None,
        auto_params: dict[str, str] | None = None,
        tags: list[str] | None = None,
    ) -> QueueJob:
        job = QueueJob(
            id=job_id or uuid.uuid4().hex[:8],
            type=job_type,  # type: ignore[arg-type]
            model=model,
            params=params,
            status="queued",
            slot=slot,  # type: ignore[arg-type]
            progress=0,
            phase="queued",
            result_paths=[],
            error=None,
            created_at=datetime.now(timezone.utc).isoformat(),
            batch_id=batch_id,
            batch_index=batch_index,
            depends_on=depends_on,
            auto_params=auto_params or {},
            tags=tags or [],
        )
        with self._lock:
            self._jobs.append(job)
            self._prune_finished()
            self._save()
        return job

    def _prune_finished(self) -> None:
        """Drop the oldest finished jobs beyond the retention cap.

        Caller holds self._lock. Never drops queued/running jobs, and never drops
        a finished job that still belongs to a batch with a non-terminal member
        (batch-completion notification still needs it).

        Director jobs are never dropped. ``DirectorHandler.resume`` decides whether
        a shot still owes work by looking its job up here; if the record is gone,
        ``get_job`` returns None, the "already paid for" guards fall through, and
        the shot is resubmitted — charging the user a second time for a render
        they already bought. A music video is ~45 jobs against a 200 cap, so two
        or three of them were enough to trigger it. Keeping these records costs a
        few KB of JSON; losing them costs real money.
        """
        finished = [j for j in self._jobs if j.status in _TERMINAL]
        if len(finished) <= MAX_FINISHED_JOBS:
            return
        active_batches = {
            j.batch_id for j in self._jobs if j.batch_id and j.status not in _TERMINAL
        }
        # Oldest-first candidates that are safe to drop.
        droppable = [
            j for j in finished
            if not (j.batch_id and j.batch_id in active_batches)
            and "director" not in j.tags
        ]
        excess = len(finished) - MAX_FINISHED_JOBS
        to_drop = {id(j) for j in droppable[:excess]}
        if to_drop:
            self._jobs = [j for j in self._jobs if id(j) not in to_drop]

    def get_all_jobs(self) -> list[QueueJob]:
        with self._lock:
            return list(self._jobs)

    def get_job(self, job_id: str) -> QueueJob | None:
        with self._lock:
            for job in self._jobs:
                if job.id == job_id:
                    return job
            return None

    def next_queued_for_slot(self, slot: str) -> QueueJob | None:
        with self._lock:
            for job in self._jobs:
                if job.status == "queued" and job.slot == slot:
                    return job
            return None

    def update_job(
        self,
        job_id: str,
        *,
        status: str | None = None,
        progress: int | None = None,
        phase: str | None = None,
        result_paths: list[str] | None = None,
        error: str | None = None,
    ) -> None:
        with self._lock:
            job = self.get_job(job_id)
            if job is None:
                return
            if status is not None:
                # Never resurrect a job out of the terminal "cancelled" state:
                # the executor thread keeps running after a cancel and would
                # otherwise flip it back to complete/error on return.
                if not (job.status == "cancelled" and status != "cancelled"):
                    job.status = status  # type: ignore[assignment]
            if progress is not None:
                job.progress = progress
            if phase is not None:
                job.phase = phase
            if result_paths is not None:
                job.result_paths = result_paths
            if error is not None:
                job.error = error
            if status is not None and job.status in _TERMINAL:
                self._prune_finished()
            self._save()

    def cancel_job(self, job_id: str) -> None:
        self.update_job(job_id, status="cancelled", phase="cancelled")

    def jobs_for_batch(self, batch_id: str) -> list[QueueJob]:
        with self._lock:
            return sorted(
                [j for j in self._jobs if j.batch_id == batch_id],
                key=lambda j: j.batch_index,
            )

    def active_batch_ids(self) -> list[str]:
        with self._lock:
            batch_ids: set[str] = set()
            for job in self._jobs:
                if job.batch_id and job.status in ("queued", "running"):
                    batch_ids.add(job.batch_id)
            return sorted(batch_ids)

    def all_jobs(self) -> list[QueueJob]:
        with self._lock:
            return list(self._jobs)

    def queued_jobs_for_slot(self, slot: str) -> list[QueueJob]:
        with self._lock:
            return [j for j in self._jobs if j.status == "queued" and j.slot == slot]

    def clear_finished(self) -> None:
        with self._lock:
            self._jobs = [
                j for j in self._jobs if j.status not in ("complete", "error", "cancelled")
            ]
            self._save()

    def _save(self) -> None:
        # Caller holds self._lock. Write to a temp file in the same dir and
        # atomically replace, so a concurrent reader / crash mid-write can never
        # observe a truncated file (which _load would silently reset to empty).
        data = {"jobs": [asdict(j) for j in self._jobs]}
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_name(f"{self._path.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        os.replace(tmp, self._path)

    def _load(self) -> None:
        if not self._path.exists():
            return
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            for item in raw.get("jobs", []):
                # Backwards compat: provide defaults for batch fields
                item.setdefault("batch_id", None)
                item.setdefault("batch_index", 0)
                item.setdefault("depends_on", None)
                item.setdefault("auto_params", {})
                item.setdefault("tags", [])
                job = QueueJob(**item)
                if job.status == "running":
                    job.status = "error"
                    job.error = "Interrupted by app restart"
                self._jobs.append(job)
        except (json.JSONDecodeError, TypeError, KeyError):
            self._jobs = []
