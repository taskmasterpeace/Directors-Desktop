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


def test_local_model_runs_on_gpu_slot_with_per_shot_audio(test_state, tmp_path: Path):
    # Phase 2: local LTX renders through the A2V pipeline — every shot's job
    # must carry the song plus ITS window so the model hears its own bars.
    handler = test_state
    run = handler.director.start(
        audio_path=_make_song(tmp_path),
        concept="local lip-sync test",
        model="ltx-fast",
        resolution="720p",
        run_thread=False,
    )
    handler.director.step(run.id)  # analyze + plan
    handler.director.step(run.id)  # submit

    jobs = [j for j in handler.job_queue.all_jobs() if "director" in j.tags]
    assert jobs and all(j.slot == "gpu" for j in jobs)
    by_id = {j.id: j for j in jobs}
    for shot in run.shots:
        job = by_id[shot.job_id]
        assert job.params["audioPath"] == run.audio_path
        assert abs(float(job.params["audioStartTime"]) - shot.start) < 0.01
        assert float(job.params["audioMaxDuration"]) >= (shot.end - shot.start) - 0.01
        assert "referenceImagePaths" not in job.params


def test_shot_phase_and_progress_are_surfaced(test_state, tmp_path: Path):
    handler = test_state
    run = _start(handler, tmp_path)
    handler.director.step(run.id)
    handler.director.step(run.id)  # submit
    first = run.shots[0]
    assert first.job_id is not None
    handler.job_queue.update_job(first.job_id, phase="inference", progress=42)
    handler.director.step(run.id)
    assert first.phase == "inference"
    assert first.progress == 42


def _complete_keyframe_jobs(handler, tmp_path: Path) -> int:
    done = 0
    for job in handler.job_queue.all_jobs():
        if job.status == "queued" and "keyframe" in job.tags:
            frame = tmp_path / f"kf_{job.id}.png"
            frame.write_bytes(b"png")
            handler.job_queue.update_job(job.id, status="complete", result_paths=[str(frame)])
            done += 1
    return done


def test_storyboard_auto_mode_keyframes_then_videos(test_state, tmp_path: Path):
    handler = test_state
    handler.state.app_settings.fal_api_key = "test-fal-key"
    run = handler.director.start(
        audio_path=_make_song(tmp_path),
        concept="chrome desert caravan",
        model="seedance-2.0",
        resolution="720p",
        treatment="A drifter finds a buried radio. The radio leads her to a hidden city. She frees the city's music.",
        artist_name="NOVA",
        storyboard=True,
        approval="auto",
        run_thread=False,
    )
    handler.director.step(run.id)  # analyze + plan
    assert run.phase == "storyboarding"
    # Vision inputs reached the prompts.
    assert any("NOVA" in s.prompt for s in run.shots if s.shot_type == "performance")
    assert any("Story beat:" in s.prompt for s in run.shots)

    handler.director.step(run.id)  # submit keyframe image jobs
    image_jobs = [j for j in handler.job_queue.all_jobs() if "keyframe" in j.tags]
    assert len(image_jobs) == len(run.shots)
    assert all(j.type == "image" and j.model == "dp-nano-banana-2" for j in image_jobs)

    _complete_keyframe_jobs(handler, tmp_path)
    handler.director.step(run.id)  # collect keyframes -> auto rolls to generating
    assert run.phase == "generating"
    assert all(s.keyframe_path for s in run.shots)

    handler.director.step(run.id)  # submit video jobs seeded by keyframes
    video_jobs = [j for j in handler.job_queue.all_jobs() if j.type == "video" and "director" in j.tags]
    assert video_jobs
    for job in video_jobs:
        assert str(job.params.get("imagePath", "")).endswith(".png")

    _complete_director_jobs(handler, tmp_path)
    handler.director.step(run.id)
    handler.director.step(run.id)
    assert run.phase == "complete"


def test_storyboard_approval_pauses_and_regenerates(test_state, tmp_path: Path):
    handler = test_state
    handler.state.app_settings.fal_api_key = "test-fal-key"
    run = handler.director.start(
        audio_path=_make_song(tmp_path),
        concept="noir rooftop",
        model="seedance-2.0",
        resolution="720p",
        storyboard=True,
        approval="approve",
        run_thread=False,
    )
    handler.director.step(run.id)
    handler.director.step(run.id)  # submit keyframes
    _complete_keyframe_jobs(handler, tmp_path)
    handler.director.step(run.id)
    assert run.phase == "awaiting_approval"

    # Regenerate one frame: back to storyboarding, only that shot resubmits.
    redo_index = run.shots[1].index
    old_path = run.shots[1].keyframe_path
    handler.director.approve_storyboard(run.id, regenerate=[redo_index], run_thread=False)
    assert run.phase == "storyboarding"
    assert run.shots[1].keyframe_path is None
    handler.director.step(run.id)
    resubmitted = [j for j in handler.job_queue.all_jobs() if "keyframe" in j.tags and j.status == "queued"]
    assert len(resubmitted) == 1
    _complete_keyframe_jobs(handler, tmp_path)
    handler.director.step(run.id)
    assert run.phase == "awaiting_approval"
    assert run.shots[1].keyframe_path is not None and run.shots[1].keyframe_path != old_path

    # Approve: rolls into generating.
    handler.director.approve_storyboard(run.id, run_thread=False)
    assert run.phase == "generating"


def test_approve_route_surface(client, test_state, tmp_path: Path):
    handler = test_state
    handler.state.app_settings.fal_api_key = "test-fal-key"
    song = _make_song(tmp_path)
    resp = client.post(
        "/api/director/start",
        json={
            "audioPath": song,
            "concept": "x",
            "storyboard": True,
            "approval": "approve",
            "treatment": "One. Two.",
            "artistName": "NOVA",
        },
    )
    assert resp.status_code == 200
    body = resp.json()["run"]
    assert body["storyboard"] is True and body["approval"] == "approve"
    run_id = body["id"]
    # Approving before awaiting_approval is a clean 409, not silent nonsense.
    denied = client.post("/api/director/storyboard/approve", json={"runId": run_id})
    assert denied.status_code == 409
    client.post("/api/director/cancel", json={"runId": run_id})


def test_director_style_flavors_every_prompt(test_state, client, tmp_path: Path):
    handler = test_state
    handler.state.app_settings.fal_api_key = "test-fal-key"
    styles = client.get("/api/director/styles").json()["styles"]
    assert len(styles) == 5 and any(st["id"] == "hype-trillions" for st in styles)

    run = handler.director.start(
        audio_path=_make_song(tmp_path),
        concept="rooftop",
        model="seedance-2.0",
        resolution="720p",
        director_style="hype-trillions",
        run_thread=False,
    )
    handler.director.step(run.id)
    assert run.shots
    assert all("fisheye" in s.prompt for s in run.shots)


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
