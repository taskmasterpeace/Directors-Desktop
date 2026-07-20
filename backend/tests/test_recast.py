"""Recast (person replacement): queue routing, upload + swap flow, errors."""

from __future__ import annotations

from pathlib import Path


def _files(tmp_path: Path) -> tuple[str, str]:
    video = tmp_path / "scene.mp4"
    video.write_bytes(b"vid")
    image = tmp_path / "hero.png"
    image.write_bytes(b"img")
    return str(video), str(image)


def test_recast_models_route_to_api_slot(test_state):
    handler = test_state
    assert handler.determine_slot("wan-animate-replace") == "api"
    # scail-2-replace removed from cloud (too expensive; local path planned)


def test_recast_executes_upload_then_replace(test_state, tmp_path: Path):
    handler = test_state
    handler.state.app_settings.fal_api_key = "test-fal-key"
    video, image = _files(tmp_path)

    paths = handler.recast.execute(
        "wan-animate-replace",
        {"videoPath": video, "characterImagePath": image, "resolution": "580p"},
    )
    assert len(paths) == 1
    out = Path(paths[0])
    assert out.is_file() and out.read_bytes() == b"fake-recast-video"

    uploads = handler.fal_upload_client.calls
    assert len(uploads) == 2
    assert uploads[0]["file_name"] == "scene.mp4"
    assert uploads[1]["file_name"] == "hero.png"

    call = handler.recast_client.replace_calls[-1]
    assert call["model"] == "wan-animate-replace"
    assert call["video_url"].endswith("scene.mp4")
    assert call["image_url"].endswith("hero.png")
    assert call["resolution"] == "580p"


def test_recast_through_the_job_queue(client, test_state, tmp_path: Path):
    handler = test_state
    handler.state.app_settings.fal_api_key = "test-fal-key"
    video, image = _files(tmp_path)

    resp = client.post(
        "/api/queue/submit",
        json={
            "type": "video",
            "model": "wan-animate-replace",
            "params": {"videoPath": video, "characterImagePath": image, "resolution": "720p"},
        },
    )
    assert resp.status_code == 200
    job_id = resp.json()["id"]
    job = handler.job_queue.get_job(job_id)
    assert job is not None and job.slot == "api"

    from handlers.job_executors import ApiJobExecutor

    result_paths = ApiJobExecutor(handler).execute(job)
    assert len(result_paths) == 1
    assert Path(result_paths[0]).is_file()
    assert handler.recast_client.replace_calls[-1]["model"] == "wan-animate-replace"


def test_recast_trims_to_the_clip_window_before_upload(test_state, tmp_path: Path):
    # Billing is per second of footage: a 3s clip cut from a 60s take must
    # upload a 3s segment, not the whole file.
    handler = test_state
    handler.state.app_settings.fal_api_key = "test-fal-key"
    video, image = _files(tmp_path)

    extracted: list[tuple[str, float, float]] = []
    segment = tmp_path / "segment.mp4"
    segment.write_bytes(b"segment")

    def fake_extract(path: str, start: float, duration: float) -> str:
        extracted.append((path, start, duration))
        return str(segment)

    from handlers.recast_handler import RecastHandler

    recast = RecastHandler(
        state=handler.state,
        recast_client=handler.recast_client,
        upload_client=handler.fal_upload_client,
        outputs_dir=tmp_path / "out",
        extract_segment=fake_extract,
    )
    recast.execute(
        "wan-animate-replace",
        {
            "videoPath": video,
            "characterImagePath": image,
            "resolution": "480p",
            "trimStart": 12.5,
            "trimDuration": 3.0,
        },
    )
    assert extracted == [(video, 12.5, 3.0)]
    # The uploaded video is the SEGMENT, not the original file.
    assert handler.fal_upload_client.calls[-2]["file_name"] == "segment.mp4"


def test_recast_requires_fal_key(test_state, tmp_path: Path):
    from _routes._errors import HTTPError

    handler = test_state
    handler.state.app_settings.fal_api_key = ""
    video, image = _files(tmp_path)
    try:
        handler.recast.execute(
            "wan-animate-replace",
            {"videoPath": video, "characterImagePath": image},
        )
        raise AssertionError("expected HTTPError")
    except HTTPError as e:
        assert e.status_code == 400
        assert "FAL_API_KEY_REQUIRED" in str(e.detail)


def test_recast_validates_files(test_state, tmp_path: Path):
    from _routes._errors import HTTPError

    handler = test_state
    handler.state.app_settings.fal_api_key = "k"
    _, image = _files(tmp_path)
    try:
        handler.recast.execute(
            "wan-animate-replace",
            {"videoPath": str(tmp_path / "missing.mp4"), "characterImagePath": image},
        )
        raise AssertionError("expected HTTPError")
    except HTTPError as e:
        assert e.status_code == 400
