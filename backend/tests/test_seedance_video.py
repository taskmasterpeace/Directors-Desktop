"""Integration tests for Seedance cloud video routing through the video handler.

Covers the user-facing "first and last frame" contract for Seedance 1.5 (Replicate)
and Seedance 2.0 (fal), plus key/edge-case handling.
"""

from __future__ import annotations

from pathlib import Path


def _write_image(make_test_image, tmp_path: Path, name: str, color: str) -> str:
    p = tmp_path / name
    p.write_bytes(make_test_image(color=color).getvalue())
    return str(p)


class TestSeedance15Replicate:
    def test_start_and_end_frames_are_sent_distinctly(
        self, client, test_state, fake_services, make_test_image, tmp_path
    ):
        # Regression: previously the START frame was sent as last_frame and the
        # END frame was dropped entirely.
        test_state.state.app_settings.replicate_api_key = "rep-key"
        start = _write_image(make_test_image, tmp_path, "start.png", "red")
        end = _write_image(make_test_image, tmp_path, "end.png", "blue")

        r = client.post(
            "/api/generate",
            json={
                "prompt": "walk forward on the beach",
                "model": "seedance-1.5-pro",
                "resolution": "720p",
                "duration": "5",
                "aspectRatio": "16:9",
                "imagePath": start,
                "lastFramePath": end,
            },
        )

        assert r.status_code == 200, r.text
        assert r.json()["status"] == "complete"
        calls = fake_services.video_api_client.video_calls
        assert len(calls) == 1
        call = calls[0]
        assert call["model"] == "seedance-1.5-pro"
        assert call["first_frame"] is not None and call["first_frame"].startswith("data:image")
        assert call["last_frame"] is not None and call["last_frame"].startswith("data:image")
        assert call["first_frame"] != call["last_frame"]

    def test_text_to_video_sends_no_frames(self, client, test_state, fake_services):
        test_state.state.app_settings.replicate_api_key = "rep-key"
        r = client.post(
            "/api/generate",
            json={"prompt": "a calm ocean", "model": "seedance-1.5-pro", "duration": "5"},
        )
        assert r.status_code == 200, r.text
        call = fake_services.video_api_client.video_calls[0]
        assert call["first_frame"] is None
        assert call["last_frame"] is None

    def test_missing_replicate_key_returns_error(self, client, test_state):
        test_state.state.app_settings.replicate_api_key = ""
        r = client.post(
            "/api/generate",
            json={"prompt": "a calm ocean", "model": "seedance-1.5-pro", "duration": "5"},
        )
        assert r.status_code == 400
        assert "REPLICATE" in r.text.upper()


class TestSeedance20Fal:
    def test_routes_to_fal_with_start_and_end_frames(
        self, client, test_state, fake_services, make_test_image, tmp_path
    ):
        test_state.state.app_settings.fal_api_key = "fal-key"
        start = _write_image(make_test_image, tmp_path, "start.png", "red")
        end = _write_image(make_test_image, tmp_path, "end.png", "blue")

        r = client.post(
            "/api/generate",
            json={
                "prompt": "a dog running",
                "model": "seedance-2.0",
                "resolution": "720p",
                "duration": "6",
                "aspectRatio": "16:9",
                "imagePath": start,
                "lastFramePath": end,
            },
        )

        assert r.status_code == 200, r.text
        assert r.json()["status"] == "complete"
        calls = fake_services.fal_video_client.video_calls
        assert len(calls) == 1
        assert calls[0]["model"] == "seedance-2.0"
        assert calls[0]["first_frame"].startswith("data:image")
        assert calls[0]["last_frame"].startswith("data:image")
        # the Replicate client must NOT be used for a fal model
        assert len(fake_services.video_api_client.video_calls) == 0

    def test_fast_variant_also_routes_to_fal(self, client, test_state, fake_services):
        test_state.state.app_settings.fal_api_key = "fal-key"
        r = client.post(
            "/api/generate",
            json={"prompt": "a dog", "model": "seedance-2.0-fast", "duration": "6"},
        )
        assert r.status_code == 200, r.text
        assert len(fake_services.fal_video_client.video_calls) == 1

    def test_missing_fal_key_returns_error(self, client, test_state):
        test_state.state.app_settings.fal_api_key = ""
        r = client.post(
            "/api/generate",
            json={"prompt": "a dog", "model": "seedance-2.0", "duration": "6"},
        )
        assert r.status_code == 400
        assert "FAL" in r.text.upper()

    def test_audio_reference_without_image_returns_400(self, client, test_state, tmp_path):
        test_state.state.app_settings.fal_api_key = "fal-key"
        audio = tmp_path / "v.mp3"
        audio.write_bytes(b"audio-bytes")
        r = client.post(
            "/api/generate",
            json={
                "prompt": "a dog",
                "model": "seedance-2.0",
                "duration": "6",
                "audioReferencePaths": [str(audio)],
            },
        )
        assert r.status_code == 400
        assert "image" in r.text.lower()

    def test_too_many_reference_images_returns_400(
        self, client, test_state, make_test_image, tmp_path
    ):
        test_state.state.app_settings.fal_api_key = "fal-key"
        imgs = [_write_image(make_test_image, tmp_path, f"r{i}.png", "red") for i in range(11)]
        r = client.post(
            "/api/generate",
            json={"prompt": "x", "model": "seedance-2.0", "duration": "6", "referenceImagePaths": imgs},
        )
        assert r.status_code == 400
        assert "9" in r.text or "reference image" in r.text.lower()
