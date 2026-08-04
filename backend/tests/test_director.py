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

    # #72: a blank concept is now ALLOWED — it gets drafted from the song
    # during analysis (see test_blank_concept_gets_drafted_from_the_song).
    handler.state.app_settings.fal_api_key = "test-fal-key"
    run = handler.director.start(
        audio_path=_make_song(tmp_path),
        concept="   ",
        model="seedance-2.0",
        resolution="720p",
        run_thread=False,
    )
    assert run.phase == "analyzing"


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


def test_aspect_rides_every_job_and_surface(test_state, client, tmp_path: Path):
    handler = test_state
    handler.state.app_settings.fal_api_key = "test-fal-key"
    run = handler.director.start(
        audio_path=_make_song(tmp_path),
        concept="vertical",
        model="seedance-2.0",
        resolution="720p",
        storyboard=True,
        approval="auto",
        aspect="9:16",
        run_thread=False,
    )
    handler.director.step(run.id)  # analyze
    handler.director.step(run.id)  # storyboard submit
    image_jobs = [j for j in handler.job_queue.all_jobs() if "keyframe" in j.tags]
    assert image_jobs and all(j.params.get("aspectRatio") == "9:16" for j in image_jobs)
    assert all("9:16" in str(j.params.get("prompt", "")) for j in image_jobs)
    _complete_keyframe_jobs(handler, tmp_path)
    handler.director.step(run.id)  # keyframes land -> generating
    handler.director.step(run.id)  # submit videos
    video_jobs = [j for j in handler.job_queue.all_jobs() if j.type == "video" and "director" in j.tags]
    assert video_jobs and all(j.params.get("aspectRatio") == "9:16" for j in video_jobs)
    status = client.get(f"/api/director/status?runId={run.id}").json()["run"]
    assert status["aspect"] == "9:16"

    denied = handler.director
    try:
        denied.start(
            audio_path=_make_song(tmp_path),
            concept="x",
            model="seedance-2.0",
            resolution="720p",
            aspect="4:3",
            run_thread=False,
        )
        raise AssertionError("bad aspect accepted")
    except Exception as exc:
        assert "aspect" in str(exc).lower()


def test_blank_concept_gets_drafted_from_the_song(test_state, client, tmp_path: Path):
    handler = test_state
    run = handler.director.start(
        audio_path=_make_song(tmp_path),
        concept="   ",
        model="ltx-fast",
        resolution="720p",
        run_thread=False,
    )
    handler.director.step(run.id)
    assert run.concept.strip(), "concept was not drafted"
    assert run.shots and all(run.concept.split(",")[0] for _ in run.shots)
    status = client.get(f"/api/director/status?runId={run.id}").json()["run"]
    # #69 surface data: beats + per-section energy ride the payload.
    assert status["beats"], "beats missing from payload"
    assert status["sections"] and all("energy" in sec for sec in status["sections"])


def test_local_default_seeds_performance_shots_with_artist_ref(test_state, tmp_path: Path):
    handler = test_state
    ref = str(tmp_path / "artist.png")
    Path(ref).write_bytes(b"fake-png")
    run = handler.director.start(
        audio_path=_make_song(tmp_path),
        concept="keep the face",
        model="ltx-fast",
        resolution="720p",
        reference_image_paths=[ref],
        artist_name="NOVA",
        run_thread=False,
    )
    handler.director.step(run.id)
    handler.director.step(run.id)
    jobs = {j.id: j for j in handler.job_queue.all_jobs() if "director" in j.tags}
    assert jobs
    performance_seen = False
    for shot in run.shots:
        assert shot.job_id in jobs
        params = jobs[shot.job_id].params
        # Local jobs never carry the cloud-style ref list...
        assert "referenceImagePaths" not in params
        if shot.shot_type == "performance":
            performance_seen = True
            # ...but performance shots are seeded with the artist reference.
            assert params.get("imagePath") == ref
        else:
            assert "imagePath" not in params
    assert performance_seen, "planner produced no performance shots to verify"


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


def test_plan_review_pauses_free_and_applies_prompt_edits(test_state, client, tmp_path: Path):
    handler = test_state
    handler.state.app_settings.fal_api_key = "test-fal-key"
    run = handler.director.start(
        audio_path=_make_song(tmp_path),
        concept="plan gate",
        model="seedance-2.0",
        resolution="720p",
        plan_review=True,
        run_thread=False,
    )
    handler.director.step(run.id)  # analyze + plan
    assert run.phase == "plan_ready"
    # Nothing submitted, nothing spent.
    assert not [j for j in handler.job_queue.all_jobs() if "director" in j.tags]

    # step() is a no-op while the human reviews.
    handler.director.step(run.id)
    assert run.phase == "plan_ready"

    edited = "hand-polished prompt for the opener"
    handler.director.approve_plan(run.id, prompts={0: edited}, run_thread=False)
    assert run.shots[0].prompt == edited
    assert run.phase == "generating"

    # Route surface: approving when not plan_ready is a clean 409; unknown 404.
    denied = client.post("/api/director/plan/approve", json={"runId": run.id})
    assert denied.status_code == 409
    missing = client.post("/api/director/plan/approve", json={"runId": "dir_nope"})
    assert missing.status_code == 404


def test_plan_review_flag_rides_the_start_route(client, test_state, tmp_path: Path):
    handler = test_state
    handler.state.app_settings.fal_api_key = "test-fal-key"
    resp = client.post(
        "/api/director/start",
        json={"audioPath": _make_song(tmp_path), "concept": "x", "planReview": True},
    )
    assert resp.status_code == 200
    body = resp.json()["run"]
    assert body["planReview"] is True
    client.post("/api/director/cancel", json={"runId": body["id"]})


def test_reroll_rerenders_only_chosen_shots(test_state, client, tmp_path: Path):
    handler = test_state
    run = _start(handler, tmp_path)
    handler.director.step(run.id)
    handler.director.step(run.id)
    _complete_director_jobs(handler, tmp_path)
    handler.director.step(run.id)
    handler.director.step(run.id)
    assert run.phase == "complete"
    kept_path = run.shots[0].result_path
    old_output = run.output_path

    handler.director.reroll_shots(run.id, [1, 2], run_thread=False)
    assert run.phase == "generating"
    assert run.shots[0].status == "complete" and run.shots[0].result_path == kept_path
    assert run.shots[1].status == "pending" and run.shots[1].result_path is None
    assert run.output_path is None

    before = len(handler.job_queue.all_jobs())
    handler.director.step(run.id)  # resubmit ONLY the rerolled shots
    assert len(handler.job_queue.all_jobs()) == before + 2
    _complete_director_jobs(handler, tmp_path)
    handler.director.step(run.id)
    handler.director.step(run.id)
    assert run.phase == "complete"
    assert run.output_path and run.output_path == old_output  # same target file, rebuilt

    # Route surface: no-op indices are a 400 (state untouched), unknown run 404.
    noop = client.post("/api/director/reroll", json={"runId": run.id, "indices": [99]})
    assert noop.status_code == 400
    assert run.phase == "complete"
    missing = client.post("/api/director/reroll", json={"runId": "dir_nope", "indices": [0]})
    assert missing.status_code == 404


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


# --- Adversarial phase-machine assertions (loop I6) -----------------------
# The phase machine touches paid work, so its edges matter: a wrong transition
# resubmits a shot, loses one, or spends after cancel. These pin the edges.

def test_cancel_is_idempotent(test_state, tmp_path: Path):
    handler = test_state
    run = _start(handler, tmp_path)
    handler.director.cancel(run.id)
    assert run.phase == "cancelled"
    # A second cancel must not raise or change anything.
    again = handler.director.cancel(run.id)
    assert again.phase == "cancelled"


def test_cancel_before_any_shot_submits_nothing(test_state, tmp_path: Path):
    handler = test_state
    run = _start(handler, tmp_path)  # phase: analyzing
    handler.director.cancel(run.id)
    assert run.phase == "cancelled"
    assert [j for j in handler.job_queue.all_jobs() if "director" in j.tags] == []


def test_resuming_a_complete_run_is_a_noop(test_state, tmp_path: Path):
    handler = test_state
    run = _start(handler, tmp_path)
    handler.director.step(run.id)              # -> generating
    handler.director.step(run.id)              # submit
    _complete_director_jobs(handler, tmp_path)
    handler.director.step(run.id)              # -> assembling
    handler.director.step(run.id)              # -> complete
    assert run.phase == "complete"

    submitted_before = len([j for j in handler.job_queue.all_jobs() if "director" in j.tags])
    resumed = handler.director.resume(run.id, run_thread=False)
    assert resumed.phase == "complete"
    submitted_after = len([j for j in handler.job_queue.all_jobs() if "director" in j.tags])
    assert submitted_after == submitted_before, "resume must not resubmit a finished run"


def test_resume_keeps_already_completed_shots(test_state, tmp_path: Path):
    handler = test_state
    run = _start(handler, tmp_path)
    handler.director.step(run.id)              # -> generating
    handler.director.step(run.id)              # submit all
    # Finish only half of the shots, then error the run out.
    finished = 0
    for job in handler.job_queue.all_jobs():
        if job.status == "queued" and "director" in job.tags and finished < len(run.shots) // 2:
            clip = tmp_path / f"{job.id}.mp4"
            clip.write_bytes(b"clip")
            handler.job_queue.update_job(job.id, status="complete", result_paths=[str(clip)])
            finished += 1
    handler.director.step(run.id)              # collect the completed ones
    done_shots = {s.index for s in run.shots if s.result_path is not None}
    assert done_shots, "at least one shot should have completed"

    run.phase = "error"
    resumed = handler.director.resume(run.id, run_thread=False)
    # Completed shots keep their result; none are thrown back to pending.
    for shot in resumed.shots:
        if shot.index in done_shots:
            assert shot.result_path is not None
            assert shot.status == "complete"


def test_approve_plan_rejects_a_run_not_awaiting_review(test_state, tmp_path: Path):
    from _routes._errors import HTTPError

    handler = test_state
    run = _start(handler, tmp_path)  # phase: analyzing, not plan_ready
    try:
        handler.director.approve_plan(run.id, run_thread=False)
        raise AssertionError("expected HTTPError")
    except HTTPError as e:
        assert e.status_code == 409


def test_reroll_rejects_incomplete_runs_and_bad_indices(test_state, tmp_path: Path):
    from _routes._errors import HTTPError

    handler = test_state
    run = _start(handler, tmp_path)
    try:
        handler.director.reroll_shots(run.id, [0], run_thread=False)  # not complete
        raise AssertionError("expected 409")
    except HTTPError as e:
        assert e.status_code == 409

    # Drive to complete, then reroll a nonexistent index.
    handler.director.step(run.id)
    handler.director.step(run.id)
    _complete_director_jobs(handler, tmp_path)
    handler.director.step(run.id)
    handler.director.step(run.id)
    assert run.phase == "complete"
    try:
        handler.director.reroll_shots(run.id, [9999], run_thread=False)
        raise AssertionError("expected 400")
    except HTTPError as e:
        assert e.status_code == 400


def test_operations_on_an_unknown_run_are_404(test_state):
    from _routes._errors import HTTPError

    handler = test_state
    for op in (
        lambda: handler.director.step("nope"),
        lambda: handler.director.cancel("nope"),
        lambda: handler.director.resume("nope", run_thread=False),
        lambda: handler.director.approve_plan("nope", run_thread=False),
    ):
        try:
            op()
            raise AssertionError("expected 404")
        except HTTPError as e:
            assert e.status_code == 404


def test_steps_after_cancel_stay_cancelled(test_state, tmp_path: Path):
    handler = test_state
    run = _start(handler, tmp_path)
    handler.director.step(run.id)
    handler.director.cancel(run.id)
    for _ in range(3):
        assert handler.director.step(run.id).phase == "cancelled"
