"""Director phase machine: plan from analysis, generate through the queue,
retry, assemble, cancel, resume, and route surface."""

from __future__ import annotations

from pathlib import Path


def _make_song(tmp_path: Path) -> str:
    song = tmp_path / "song.mp3"
    song.write_bytes(b"fake-mp3")
    return str(song)


def _start(handler, tmp_path: Path):
    handler.state.app_settings.fal_api_key = "test-fal-key"
    return handler.director.start(
        audio_path=_make_song(tmp_path),
        concept="neon-lit rooftop at night",
        model="seedance-2.0",
        resolution="720p",
        run_thread=False,
    )


def _complete_director_jobs(handler, tmp_path: Path) -> int:
    done = 0
    for job in handler.job_queue.all_jobs():
        if job.status == "queued" and "director" in job.tags:
            clip = tmp_path / f"{job.id}.mp4"
            clip.write_bytes(b"clip")
            handler.job_queue.update_job(job.id, status="complete", result_paths=[str(clip)])
            done += 1
    return done


def test_full_run_to_complete(test_state, tmp_path: Path):
    handler = test_state
    run = _start(handler, tmp_path)
    assert run.phase == "analyzing"

    handler.director.step(run.id)  # analyze + plan
    assert run.phase == "generating"
    assert run.shots, "plan should produce shots"
    # Fake analysis: 40s song — plan must tile it fully.
    assert abs(run.shots[-1].end - 40.0) < 0.01
    assert run.analysis is not None and run.analysis["tempo_bpm"] == 120.0

    handler.director.step(run.id)  # submit all shots
    submitted = [s for s in run.shots if s.status == "submitted"]
    assert len(submitted) == len(run.shots)
    assert all(s.job_id for s in run.shots)

    completed = _complete_director_jobs(handler, tmp_path)
    assert completed == len(run.shots)

    handler.director.step(run.id)  # collect results -> assembling
    assert run.phase == "assembling"

    handler.director.step(run.id)  # assemble -> complete
    assert run.phase == "complete"
    assert run.output_path and Path(run.output_path).is_file()

    call = handler.video_assembler.assemble_calls[-1]
    assert call["audio_path"] == run.audio_path
    # Exact fractional durations reach the assembler (trim-to-beat), in order.
    durations = [s.duration for s in call["shots"]]
    assert durations == [s.end - s.start for s in run.shots]


def test_shot_failure_retries_then_errors_and_resumes(test_state, tmp_path: Path):
    handler = test_state
    run = _start(handler, tmp_path)
    handler.director.step(run.id)
    handler.director.step(run.id)  # submit

    # Fail every job: first pass consumes the one retry, second pass errors out.
    for _ in range(2):
        for job in handler.job_queue.all_jobs():
            if job.status == "queued" and "director" in job.tags:
                handler.job_queue.update_job(job.id, status="error", error="credits exhausted")
        handler.director.step(run.id)  # requeue (retry) or mark error
        handler.director.step(run.id)  # submit retries / settle

    assert run.phase == "error"
    assert run.error is not None and "resume" in run.error

    # Resume: failed shots go back to pending, run re-enters generating.
    handler.director.resume(run.id, run_thread=False)
    assert run.phase == "generating"
    assert all(s.status in ("pending", "complete") for s in run.shots)

    handler.director.step(run.id)  # resubmit
    _complete_director_jobs(handler, tmp_path)
    handler.director.step(run.id)
    handler.director.step(run.id)
    assert run.phase == "complete"


def test_cancel_cancels_queued_jobs(test_state, tmp_path: Path):
    handler = test_state
    run = _start(handler, tmp_path)
    handler.director.step(run.id)
    handler.director.step(run.id)  # submit

    handler.director.cancel(run.id)
    assert run.phase == "cancelled"
    director_jobs = [j for j in handler.job_queue.all_jobs() if "director" in j.tags]
    assert director_jobs
    assert all(j.status == "cancelled" for j in director_jobs)
    # Further steps are no-ops on a terminal run.
    assert handler.director.step(run.id).phase == "cancelled"


def test_start_validates_inputs(test_state, tmp_path: Path):
    from _routes._errors import HTTPError

    handler = test_state
    try:
        handler.director.start(
            audio_path=str(tmp_path / "missing.mp3"),
            concept="x",
            model="seedance-2.0",
            resolution="720p",
            run_thread=False,
        )
        raise AssertionError("expected HTTPError")
    except HTTPError as e:
        assert e.status_code == 400

    handler.state.app_settings.fal_api_key = "test-fal-key"
    try:
        handler.director.start(
            audio_path=_make_song(tmp_path),
            concept="   ",
            model="seedance-2.0",
            resolution="720p",
            run_thread=False,
        )
        raise AssertionError("expected HTTPError")
    except HTTPError as e:
        assert e.status_code == 400


def test_start_requires_fal_key_for_seedance(test_state, tmp_path: Path):
    from _routes._errors import HTTPError

    handler = test_state
    handler.state.app_settings.fal_api_key = ""
    try:
        handler.director.start(
            audio_path=_make_song(tmp_path),
            concept="x",
            model="seedance-2.0",
            resolution="720p",
            run_thread=False,
        )
        raise AssertionError("expected HTTPError")
    except HTTPError as e:
        assert e.status_code == 400
        assert "FAL_API_KEY_REQUIRED" in str(e.detail)


def test_store_persists_and_reloads(tmp_path: Path):
    from state.director_store import DirectorStore

    path = tmp_path / "director_runs.json"
    store = DirectorStore(path)
    run = store.create_run(
        audio_path="a.mp3", concept="c", model="m", resolution="720p"
    )
    run.phase = "generating"
    store.save()

    reloaded = DirectorStore(path)
    loaded = reloaded.get_run(run.id)
    assert loaded is not None
    assert loaded.phase == "generating"
    assert loaded.concept == "c"


def test_routes_surface(client, test_state, tmp_path: Path):
    handler = test_state
    handler.state.app_settings.fal_api_key = "test-fal-key"
    song = _make_song(tmp_path)
    resp = client.post(
        "/api/director/start",
        json={"audioPath": song, "concept": "desert chrome caravan"},
    )
    assert resp.status_code == 200
    run_id = resp.json()["run"]["id"]

    status = client.get(f"/api/director/status?runId={run_id}").json()["run"]
    assert status["id"] == run_id
    assert status["phase"] in ("analyzing", "generating", "assembling", "complete")

    runs = client.get("/api/director/runs").json()["runs"]
    assert any(r["id"] == run_id for r in runs)

    cancelled = client.post("/api/director/cancel", json={"runId": run_id}).json()["run"]
    assert cancelled["phase"] in ("cancelled", "complete")

    # The background thread exits promptly once the run is terminal.
    handler.director.status(run_id)
