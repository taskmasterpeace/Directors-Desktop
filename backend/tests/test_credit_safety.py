"""Credit-safety invariants for the money path.

Adopts as real tests the properties the read-only test loop verified by hand
(its "money sweep"). The desktop never deducts for local generation, never for
a job that did not complete, exactly once for one that did, and a failed
deduction must not corrupt the job. Getting any of these wrong charges a real
person real money — this is the surface F10 (double-charge on resume) lived on.
"""

from __future__ import annotations

import time
from pathlib import Path

from state.job_queue import JobQueue, QueueJob
from handlers.queue_worker import QueueWorker


class FakeJobExecutor:
    def __init__(self, result_paths: list[str] | None = None) -> None:
        self.executed_jobs: list[QueueJob] = []
        self.raise_on_execute: Exception | None = None
        self._result_paths = result_paths if result_paths is not None else ["/fake/out.mp4"]

    def execute(self, job: QueueJob) -> list[str]:
        self.executed_jobs.append(job)
        if self.raise_on_execute is not None:
            raise self.raise_on_execute
        return list(self._result_paths)


class SpyCreditDeductor:
    """Records every deduction, and can be told to fail like a flaky server."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, int, dict[str, object] | None]] = []
        self.raise_on_deduct: Exception | None = None

    def deduct_credits(
        self, generation_type: str, count: int, metadata: dict[str, object] | None,
    ) -> dict[str, object]:
        self.calls.append((generation_type, count, metadata))
        if self.raise_on_deduct is not None:
            raise self.raise_on_deduct
        return {"balance_cents": 100}


def _wait_terminal(queue: JobQueue, job_id: str, timeout: float = 3.0) -> QueueJob:
    """Poll until the job reaches a terminal state — no fixed sleeps (see F11)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = queue.get_job(job_id)
        if job is not None and job.status in ("complete", "error", "cancelled"):
            # Deduction happens just after status flips to complete; give the
            # executor thread a beat to run it, then return.
            time.sleep(0.02)
            return queue.get_job(job_id) or job
        time.sleep(0.005)
    raise AssertionError(f"job {job_id} never reached a terminal state")


def _worker(queue: JobQueue, deductor: SpyCreditDeductor, api: FakeJobExecutor) -> QueueWorker:
    return QueueWorker(
        queue=queue,
        gpu_executor=FakeJobExecutor(),
        api_executor=api,
        credit_deductor=deductor,
    )


def _run(tmp_path: Path, *, model: str, slot: str, job_type: str = "video",
         params: dict | None = None, fail_execute: bool = False,
         cancel_before: bool = False, fail_deduct: bool = False):
    queue = JobQueue(persistence_path=tmp_path / "queue.json")
    deductor = SpyCreditDeductor()
    if fail_deduct:
        deductor.raise_on_deduct = RuntimeError("palette 503")
    api = FakeJobExecutor()
    if fail_execute:
        api.raise_on_execute = RuntimeError("provider error")
    job = queue.submit(job_type=job_type, model=model, params=params or {"prompt": "x"}, slot=slot)
    if cancel_before:
        queue.cancel_job(job.id)
    _worker(queue, deductor, api).tick()
    final = _wait_terminal(queue, job.id)
    return deductor, final


# --- the four "never charge" cases ---------------------------------------

def test_local_gpu_job_is_never_charged(tmp_path: Path) -> None:
    deductor, final = _run(tmp_path, model="ltx-fast", slot="gpu")
    assert final.status == "complete"
    assert deductor.calls == [], "local GPU generation must be free"


def test_errored_api_job_is_not_charged(tmp_path: Path) -> None:
    deductor, final = _run(tmp_path, model="seedance-2.0", slot="api", fail_execute=True)
    assert final.status == "error"
    assert deductor.calls == [], "a job that never produced output must not be billed"


def test_cancelled_api_job_is_not_charged(tmp_path: Path) -> None:
    deductor, final = _run(tmp_path, model="seedance-2.0", slot="api", cancel_before=True)
    assert final.status == "cancelled"
    assert deductor.calls == [], "a cancelled job must not be billed"


# --- the "charge exactly once, correctly" cases --------------------------

def test_completed_api_job_is_charged_exactly_once(tmp_path: Path) -> None:
    deductor, final = _run(tmp_path, model="seedance-2.0", slot="api")
    assert final.status == "complete"
    assert len(deductor.calls) == 1
    gen_type, count, meta = deductor.calls[0]
    assert count == 1
    assert meta == {"model": "seedance-2.0", "job_id": final.id}


def test_extra_ticks_do_not_re_charge_a_finished_job(tmp_path: Path) -> None:
    queue = JobQueue(persistence_path=tmp_path / "queue.json")
    deductor = SpyCreditDeductor()
    worker = _worker(queue, deductor, FakeJobExecutor())
    job = queue.submit(job_type="video", model="seedance-2.0", params={"prompt": "x"}, slot="api")
    worker.tick()
    _wait_terminal(queue, job.id)
    for _ in range(3):  # the tick loop keeps running in real life
        worker.tick()
        time.sleep(0.02)
    assert len(deductor.calls) == 1, "a finished job must be billed once, not once per tick"


def test_credit_type_matches_the_job_shape(tmp_path: Path) -> None:
    cases = [
        ("seedance-2.0", "video", {"prompt": "x"}, "video_seedance"),
        ("nano-banana-2", "image", {"prompt": "x"}, "image"),
        ("wan-animate-replace", "video", {"prompt": "x", "imagePath": "/a.png"}, "video_i2v"),
        ("dp-some-video", "video", {"prompt": "x"}, "video_t2v"),
    ]
    for model, job_type, params, expected in cases:
        deductor, final = _run(tmp_path, model=model, slot="api", job_type=job_type, params=params)
        assert final.status == "complete"
        assert deductor.calls and deductor.calls[0][0] == expected, f"{model} -> {expected}"


# --- resilience ----------------------------------------------------------

def test_a_failed_deduction_does_not_fail_the_delivered_job(tmp_path: Path) -> None:
    # The user already has the render; a billing hiccup must not throw the
    # output away. The desktop logs and moves on (server-side reconciliation
    # is Palette's job).
    deductor, final = _run(tmp_path, model="seedance-2.0", slot="api", fail_deduct=True)
    assert final.status == "complete"
    assert final.result_paths == ["/fake/out.mp4"]
    assert len(deductor.calls) == 1  # it tried, exactly once


def test_worker_without_a_deductor_still_completes_api_jobs(tmp_path: Path) -> None:
    # BYO-key / owner mode has no Palette deductor wired in.
    queue = JobQueue(persistence_path=tmp_path / "queue.json")
    worker = QueueWorker(
        queue=queue, gpu_executor=FakeJobExecutor(), api_executor=FakeJobExecutor(),
        credit_deductor=None,
    )
    job = queue.submit(job_type="video", model="seedance-2.0", params={"prompt": "x"}, slot="api")
    worker.tick()
    final = _wait_terminal(queue, job.id)
    assert final.status == "complete"
