"""Tests for using library characters/references as REFERENCE images (Seedance 2.0).

References attach as reference images (omni-reference) — never as the start frame.
This is the corrected model; a character no longer sets imagePath.
"""

from __future__ import annotations

from pathlib import Path

from handlers.job_executors import ApiJobExecutor
from state.job_queue import QueueJob


def _img(make_test_image, tmp_path: Path, name: str, color: str = "red") -> str:
    p = tmp_path / name
    p.write_bytes(make_test_image(color=color).getvalue())
    return str(p)


def _video_job(model: str, params: dict[str, object]) -> QueueJob:
    return QueueJob(id="j1", type="video", model=model, params=params, status="running", slot="api")


class TestResolveReferencePaths:
    def test_character_returns_all_images(self, test_state, make_test_image, tmp_path):
        a = _img(make_test_image, tmp_path, "a.png")
        b = _img(make_test_image, tmp_path, "b.png", "blue")
        char = test_state.library.create_character(
            name="Hero", role="", description="", reference_image_paths=[a, b]
        )
        assert test_state.library.resolve_reference_paths(character_id=char.id) == [a, b]

    def test_reference_returns_single(self, test_state, make_test_image, tmp_path):
        img = _img(make_test_image, tmp_path, "r.png")
        ref = test_state.library.create_reference(name="Place", category="places", image_path=img)
        assert test_state.library.resolve_reference_paths(reference_id=ref.id) == [img]

    def test_unknown_returns_empty(self, test_state):
        assert test_state.library.resolve_reference_paths(character_id="nope") == []


class TestSeedance2References:
    def test_explicit_reference_paths_reach_fal_as_references(
        self, test_state, fake_services, make_test_image, tmp_path
    ):
        img = _img(make_test_image, tmp_path, "ref.png", "red")
        test_state.state.app_settings.fal_api_key = "fal-key"
        ApiJobExecutor(test_state).execute(
            _video_job("seedance-2.0", {"prompt": "x", "referenceImagePaths": [img], "duration": "6"})
        )
        calls = fake_services.fal_video_client.video_calls
        assert len(calls) == 1
        refs = calls[0]["reference_images"]
        assert refs and refs[0].startswith("https://fake.fal/uploads/")
        assert calls[0]["first_frame"] is None  # references are NOT a start frame

    def test_character_id_resolves_to_references_not_start_frame(
        self, test_state, fake_services, make_test_image, tmp_path
    ):
        img = _img(make_test_image, tmp_path, "hero.png", "red")
        char = test_state.library.create_character(
            name="Hero", role="", description="a knight", reference_image_paths=[img]
        )
        test_state.state.app_settings.fal_api_key = "fal-key"
        ApiJobExecutor(test_state).execute(
            _video_job("seedance-2.0", {"prompt": "x", "character_id": char.id, "duration": "6"})
        )
        call = fake_services.fal_video_client.video_calls[0]
        assert call["reference_images"] and call["reference_images"][0].startswith("https://fake.fal/uploads/")
        assert call["first_frame"] is None  # regression: character must NOT become the start frame

    def test_audio_reference_paths_reach_fal(
        self, test_state, fake_services, make_test_image, tmp_path
    ):
        img = _img(make_test_image, tmp_path, "ref.png", "red")
        audio = tmp_path / "verse.mp3"
        audio.write_bytes(b"ID3-fake-audio-bytes")
        test_state.state.app_settings.fal_api_key = "fal-key"
        ApiJobExecutor(test_state).execute(
            _video_job(
                "seedance-2.0",
                {
                    "prompt": "x",
                    "referenceImagePaths": [img],
                    "audioReferencePaths": [str(audio)],
                    "duration": "6",
                },
            )
        )
        call = fake_services.fal_video_client.video_calls[0]
        assert call["reference_audio"] and call["reference_audio"][0].startswith("https://fake.fal/uploads/")

    def test_explicit_image_path_still_works_as_start_frame(
        self, test_state, fake_services, make_test_image, tmp_path
    ):
        # The separate, explicit start-frame control is unaffected by references.
        start = _img(make_test_image, tmp_path, "start.png", "blue")
        test_state.state.app_settings.fal_api_key = "fal-key"
        ApiJobExecutor(test_state).execute(
            _video_job("seedance-2.0", {"prompt": "x", "imagePath": start, "duration": "6"})
        )
        call = fake_services.fal_video_client.video_calls[0]
        assert call["first_frame"] is not None
        assert not call["reference_images"]
