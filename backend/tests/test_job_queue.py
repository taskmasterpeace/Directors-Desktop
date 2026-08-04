"""Tests for the persistent job queue."""

from __future__ import annotations

from pathlib import Path

from state.job_queue import JobQueue, QueueJob


def test_submit_job_assigns_id_and_status(tmp_path: Path) -> None:
    queue = JobQueue(persistence_path=tmp_path / "queue.json")
    job = queue.submit(
        job_type="video",
        model="seedance-1.5-pro",
        params={"prompt": "hello"},
        slot="api",
    )
    assert job.id
    assert job.status == "queued"
    assert job.slot == "api"
    assert job.progress == 0


def test_get_all_jobs_returns_ordered(tmp_path: Path) -> None:
    queue = JobQueue(persistence_path=tmp_path / "queue.json")
    j1 = queue.submit(job_type="video", model="ltx-fast", params={}, slot="gpu")
    j2 = queue.submit(job_type="image", model="z-image-turbo", params={}, slot="gpu")
    jobs = queue.get_all_jobs()
    assert [j.id for j in jobs] == [j1.id, j2.id]


def test_next_queued_for_slot(tmp_path: Path) -> None:
    queue = JobQueue(persistence_path=tmp_path / "queue.json")
    queue.submit(job_type="video", model="seedance-1.5-pro", params={}, slot="api")
    queue.submit(job_type="video", model="ltx-fast", params={}, slot="gpu")

    gpu_job = queue.next_queued_for_slot("gpu")
    assert gpu_job is not None
    assert gpu_job.slot == "gpu"

    api_job = queue.next_queued_for_slot("api")
    assert api_job is not None
    assert api_job.slot == "api"


def test_update_job_status(tmp_path: Path) -> None:
    queue = JobQueue(persistence_path=tmp_path / "queue.json")
    job = queue.submit(job_type="video", model="ltx-fast", params={}, slot="gpu")
    queue.update_job(job.id, status="running", progress=50, phase="inference")
    updated = queue.get_job(job.id)
    assert updated is not None
    assert updated.status == "running"
    assert updated.progress == 50
    assert updated.phase == "inference"


def test_cancel_job(tmp_path: Path) -> None:
    queue = JobQueue(persistence_path=tmp_path / "queue.json")
    job = queue.submit(job_type="video", model="ltx-fast", params={}, slot="gpu")
    queue.cancel_job(job.id)
    updated = queue.get_job(job.id)
    assert updated is not None
    assert updated.status == "cancelled"


def test_clear_finished_jobs(tmp_path: Path) -> None:
    queue = JobQueue(persistence_path=tmp_path / "queue.json")
    j1 = queue.submit(job_type="video", model="ltx-fast", params={}, slot="gpu")
    j2 = queue.submit(job_type="video", model="ltx-fast", params={}, slot="gpu")
    queue.update_job(j1.id, status="complete")
    queue.clear_finished()
    remaining = queue.get_all_jobs()
    assert len(remaining) == 1
    assert remaining[0].id == j2.id


def test_persistence_survives_reload(tmp_path: Path) -> None:
    path = tmp_path / "queue.json"
    queue1 = JobQueue(persistence_path=path)
    job = queue1.submit(job_type="video", model="ltx-fast", params={"prompt": "test"}, slot="gpu")

    queue2 = JobQueue(persistence_path=path)
    loaded = queue2.get_job(job.id)
    assert loaded is not None
    assert loaded.params == {"prompt": "test"}


def test_submit_job_with_batch_fields(tmp_path: Path) -> None:
    queue = JobQueue(persistence_path=tmp_path / "queue.json")
    job = queue.submit(
        job_type="image",
        model="zit",
        params={"prompt": "a cat"},
        slot="gpu",
        batch_id="batch_001",
        batch_index=3,
        depends_on="job_abc",
        tags=["batch:batch_001", "sweep:lora_weight"],
    )
    assert job.batch_id == "batch_001"
    assert job.batch_index == 3
    assert job.depends_on == "job_abc"
    assert job.tags == ["batch:batch_001", "sweep:lora_weight"]

    # Verify persistence round-trip
    queue2 = JobQueue(persistence_path=tmp_path / "queue.json")
    loaded = queue2.get_job(job.id)
    assert loaded is not None
    assert loaded.batch_id == "batch_001"
    assert loaded.batch_index == 3
    assert loaded.depends_on == "job_abc"
    assert loaded.tags == ["batch:batch_001", "sweep:lora_weight"]


def test_jobs_for_batch(tmp_path: Path) -> None:
    queue = JobQueue(persistence_path=tmp_path / "queue.json")
    queue.submit(job_type="image", model="zit", params={}, slot="gpu", batch_id="b1", batch_index=0)
    queue.submit(job_type="image", model="zit", params={}, slot="gpu", batch_id="b1", batch_index=1)
    queue.submit(job_type="image", model="zit", params={}, slot="gpu", batch_id="b2", batch_index=0)
    queue.submit(job_type="video", model="fast", params={}, slot="gpu")  # No batch

    batch_jobs = queue.jobs_for_batch("b1")
    assert len(batch_jobs) == 2
    assert all(j.batch_id == "b1" for j in batch_jobs)
    assert [j.batch_index for j in batch_jobs] == [0, 1]


def test_active_batch_ids(tmp_path: Path) -> None:
    queue = JobQueue(persistence_path=tmp_path / "queue.json")
    queue.submit(job_type="image", model="zit", params={}, slot="gpu", batch_id="b1")
    queue.submit(job_type="image", model="zit", params={}, slot="gpu", batch_id="b2")
    queue.submit(job_type="video", model="fast", params={}, slot="gpu")

    ids = queue.active_batch_ids()
    assert set(ids) == {"b1", "b2"}


def test_active_batch_ids_excludes_fully_resolved(tmp_path: Path) -> None:
    queue = JobQueue(persistence_path=tmp_path / "queue.json")
    job = queue.submit(job_type="image", model="zit", params={}, slot="gpu", batch_id="b1")
    queue.update_job(job.id, status="complete", result_paths=["/out.png"])

    ids = queue.active_batch_ids()
    assert ids == []  # b1 is fully resolved


def test_cancelled_status_is_not_resurrected(tmp_path: Path) -> None:
    # A job cancelled while its executor thread is still running must stay
    # cancelled when that thread later reports complete/error.
    queue = JobQueue(persistence_path=tmp_path / "queue.json")
    job = queue.submit(job_type="video", model="ltx-fast", params={}, slot="gpu")
    queue.update_job(job.id, status="running")
    queue.cancel_job(job.id)
    queue.update_job(job.id, status="complete", progress=100, result_paths=["/out.mp4"])
    updated = queue.get_job(job.id)
    assert updated is not None
    assert updated.status == "cancelled"


def test_setting_status_back_to_cancelled_is_allowed(tmp_path: Path) -> None:
    queue = JobQueue(persistence_path=tmp_path / "queue.json")
    job = queue.submit(job_type="video", model="ltx-fast", params={}, slot="gpu")
    queue.update_job(job.id, status="cancelled")
    queue.update_job(job.id, status="cancelled", phase="cancelled")
    updated = queue.get_job(job.id)
    assert updated is not None
    assert updated.status == "cancelled"


def test_save_leaves_no_temp_file(tmp_path: Path) -> None:
    path = tmp_path / "queue.json"
    queue = JobQueue(persistence_path=path)
    queue.submit(job_type="video", model="ltx-fast", params={}, slot="gpu")
    # Atomic replace should not leave any *.tmp turds next to the queue file.
    assert path.exists()
    assert list(tmp_path.glob("*.tmp")) == []


def test_finished_jobs_are_pruned_beyond_cap(tmp_path: Path) -> None:
    from state.job_queue import MAX_FINISHED_JOBS

    queue = JobQueue(persistence_path=tmp_path / "queue.json")
    # Submit more than the cap and finish each; the queue must stay bounded.
    for _ in range(MAX_FINISHED_JOBS + 25):
        job = queue.submit(job_type="video", model="ltx-fast", params={}, slot="gpu")
        queue.update_job(job.id, status="complete")
    finished = [j for j in queue.get_all_jobs() if j.status == "complete"]
    assert len(finished) <= MAX_FINISHED_JOBS


def test_prune_keeps_running_and_queued_jobs(tmp_path: Path) -> None:
    from state.job_queue import MAX_FINISHED_JOBS

    queue = JobQueue(persistence_path=tmp_path / "queue.json")
    running = queue.submit(job_type="video", model="ltx-fast", params={}, slot="gpu")
    queue.update_job(running.id, status="running")
    for _ in range(MAX_FINISHED_JOBS + 10):
        job = queue.submit(job_type="video", model="ltx-fast", params={}, slot="gpu")
        queue.update_job(job.id, status="complete")
    assert queue.get_job(running.id) is not None
    assert queue.get_job(running.id).status == "running"  # type: ignore[union-attr]


def test_director_jobs_survive_pruning(tmp_path: Path) -> None:
    """F10 — the only proven way this app could overcharge someone.

    DirectorHandler.resume looks a shot's job up to decide whether it still owes
    work. Once the record was pruned, get_job returned None, the "already paid
    for" guards fell through, and the shot was resubmitted — billing the user a
    second time for a render they had already bought. A music video is ~45 jobs
    against a 200 cap, so a couple of them evicted the earlier ones.
    """
    from state.job_queue import MAX_FINISHED_JOBS

    queue = JobQueue(persistence_path=tmp_path / "queue.json")
    director_jobs = [
        queue.submit(job_type="video", model="ltx-fast", params={}, slot="gpu",
                     tags=["director", "run-abc"])
        for _ in range(45)
    ]
    for job in director_jobs:
        queue.update_job(job.id, status="complete")

    # Enough unrelated finished work to blow well past the cap.
    for _ in range(MAX_FINISHED_JOBS + 50):
        job = queue.submit(job_type="video", model="ltx-fast", params={}, slot="gpu")
        queue.update_job(job.id, status="complete")

    for job in director_jobs:
        assert queue.get_job(job.id) is not None, (
            "a pruned director job makes resume() submit a second PAID job"
        )
    # Ordinary jobs must still be bounded — the protection is targeted, not a leak.
    plain = [j for j in queue.get_all_jobs() if "director" not in j.tags]
    assert len(plain) <= MAX_FINISHED_JOBS


def test_running_jobs_reset_to_queued_on_load(tmp_path: Path) -> None:
    path = tmp_path / "queue.json"
    queue1 = JobQueue(persistence_path=path)
    job = queue1.submit(job_type="video", model="ltx-fast", params={}, slot="gpu")
    queue1.update_job(job.id, status="running")

    queue2 = JobQueue(persistence_path=path)
    loaded = queue2.get_job(job.id)
    assert loaded is not None
    assert loaded.status == "error"
    assert loaded.error == "Interrupted by app restart"
