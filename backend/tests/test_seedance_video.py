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


class TestSeedance20VideoReferences:
    """Video references (clip → reference pipeline): fal `video_urls` support."""

    def _write_clip(self, tmp_path: Path, name: str = "ref.mp4") -> str:
        p = tmp_path / name
        p.write_bytes(b"fake-mp4-bytes")
        return str(p)

    def test_video_reference_is_uploaded_and_sent(
        self, client, test_state, fake_services, tmp_path
    ):
        test_state.state.app_settings.fal_api_key = "fal-key"
        clip = self._write_clip(tmp_path)

        r = client.post(
            "/api/generate",
            json={
                "prompt": "@Video1 but set at night in the rain",
                "model": "seedance-2.0",
                "duration": "6",
                "videoReferencePaths": [clip],
            },
        )

        assert r.status_code == 200, r.text
        assert r.json()["status"] == "complete"
        calls = fake_services.fal_video_client.video_calls
        assert len(calls) == 1
        # No images attached: video refs alone must still route to reference mode.
        assert calls[0]["reference_images"] is None
        assert calls[0]["reference_videos"] == ["https://fake.fal/uploads/ref.mp4"]
        # The clip was uploaded to fal storage with a video content type, never inlined.
        uploads = fake_services.fal_upload_client.calls
        assert len(uploads) == 1
        assert uploads[0]["content_type"] == "video/mp4"
        assert uploads[0]["file_name"] == "ref.mp4"

    def test_video_reference_alongside_images(
        self, client, test_state, fake_services, make_test_image, tmp_path
    ):
        test_state.state.app_settings.fal_api_key = "fal-key"
        img = _write_image(make_test_image, tmp_path, "face.png", "red")
        clip = self._write_clip(tmp_path)

        r = client.post(
            "/api/generate",
            json={
                "prompt": "@Image1 acting out @Video1",
                "model": "seedance-2.0",
                "duration": "6",
                "referenceImagePaths": [img],
                "videoReferencePaths": [clip],
            },
        )

        assert r.status_code == 200, r.text
        call = fake_services.fal_video_client.video_calls[0]
        assert call["reference_images"] == ["https://fake.fal/uploads/face.png"]
        assert call["reference_videos"] == ["https://fake.fal/uploads/ref.mp4"]

    def test_too_many_video_references_returns_400(self, client, test_state, tmp_path):
        test_state.state.app_settings.fal_api_key = "fal-key"
        clips = [self._write_clip(tmp_path, f"c{i}.mp4") for i in range(4)]
        r = client.post(
            "/api/generate",
            json={"prompt": "x", "model": "seedance-2.0", "duration": "6", "videoReferencePaths": clips},
        )
        assert r.status_code == 400
        assert "3" in r.text and "video" in r.text.lower()

    def test_video_reference_longer_than_15s_returns_400(
        self, client, test_state, fake_services, tmp_path
    ):
        test_state.state.app_settings.fal_api_key = "fal-key"
        fake_services.video_trimmer.probe_result = 30.0
        clip = self._write_clip(tmp_path)
        r = client.post(
            "/api/generate",
            json={"prompt": "x", "model": "seedance-2.0", "duration": "6", "videoReferencePaths": [clip]},
        )
        assert r.status_code == 400
        assert "15 seconds" in r.text
        # Rejected before any upload happened.
        assert fake_services.fal_upload_client.calls == []

    def test_unsupported_video_format_returns_400(self, client, test_state, tmp_path):
        test_state.state.app_settings.fal_api_key = "fal-key"
        p = tmp_path / "ref.avi"
        p.write_bytes(b"fake-avi-bytes")
        r = client.post(
            "/api/generate",
            json={"prompt": "x", "model": "seedance-2.0", "duration": "6", "videoReferencePaths": [str(p)]},
        )
        assert r.status_code == 400
        assert "avi" in r.text.lower()

    def test_video_reference_on_seedance_15_returns_400(self, client, test_state, tmp_path):
        test_state.state.app_settings.replicate_api_key = "rep-key"
        clip = self._write_clip(tmp_path)
        r = client.post(
            "/api/generate",
            json={
                "prompt": "x",
                "model": "seedance-1.5-pro",
                "duration": "5",
                "videoReferencePaths": [clip],
            },
        )
        assert r.status_code == 400
        assert "seedance 2.0" in r.text.lower()

    def test_video_reference_on_local_model_returns_400(self, client, test_state, tmp_path):
        clip = self._write_clip(tmp_path)
        r = client.post(
            "/api/generate",
            json={
                "prompt": "x",
                "model": "fast",
                "duration": "2",
                "videoReferencePaths": [clip],
            },
        )
        assert r.status_code == 400
        assert "seedance 2.0" in r.text.lower()


class TestExactDuration:
    """Exact-length promise: give it 3 seconds, get exactly 3 seconds back.

    Providers round durations into their supported ranges (Seedance 1.5: 4-12s,
    2.0: 4-15s), so the handler trims the delivered file back to the request.
    """

    def test_fal_output_is_trimmed_to_requested_seconds(self, client, test_state, fake_services):
        test_state.state.app_settings.fal_api_key = "fal-key"
        fake_services.video_trimmer.probe_result = 4.0  # Seedance 2.0 minimum

        r = client.post(
            "/api/generate",
            json={"prompt": "a dog", "model": "seedance-2.0", "duration": "3", "exactDuration": True},
        )

        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "complete"
        trims = fake_services.video_trimmer.trim_calls
        assert len(trims) == 1
        assert trims[0][0] == body["video_path"]
        assert trims[0][1] == 3.0

    def test_replicate_output_is_trimmed_too(self, client, test_state, fake_services):
        test_state.state.app_settings.replicate_api_key = "rep-key"
        fake_services.video_trimmer.probe_result = 4.0  # Seedance 1.5 minimum

        r = client.post(
            "/api/generate",
            json={"prompt": "a cat", "model": "seedance-1.5-pro", "duration": "3", "exactDuration": True},
        )

        assert r.status_code == 200, r.text
        assert fake_services.video_trimmer.trim_calls == [(r.json()["video_path"], 3.0)]

    def test_no_trim_when_output_already_matches(self, client, test_state, fake_services):
        test_state.state.app_settings.fal_api_key = "fal-key"
        fake_services.video_trimmer.probe_result = 5.02  # within the epsilon

        r = client.post(
            "/api/generate",
            json={"prompt": "a dog", "model": "seedance-2.0", "duration": "5", "exactDuration": True},
        )

        assert r.status_code == 200, r.text
        assert fake_services.video_trimmer.trim_calls == []

    def test_no_probe_or_trim_without_the_flag(self, client, test_state, fake_services):
        test_state.state.app_settings.fal_api_key = "fal-key"

        r = client.post(
            "/api/generate",
            json={"prompt": "a dog", "model": "seedance-2.0", "duration": "5"},
        )

        assert r.status_code == 200, r.text
        assert fake_services.video_trimmer.probe_calls == []
        assert fake_services.video_trimmer.trim_calls == []

    def test_forced_api_ceils_off_list_duration_and_trims_back(
        self, client, test_state, fake_services
    ):
        # The LTX API only takes discrete durations (6/8/10...): exact mode
        # generates at the smallest one covering the request, then trims.
        test_state.config.force_api_generations = True
        test_state.state.app_settings.ltx_api_key = "api-key"
        fake_services.video_trimmer.probe_result = 6.0

        r = client.post(
            "/api/generate",
            json={
                "prompt": "x",
                "model": "fast",
                "resolution": "1080p",
                "duration": "3",
                "fps": "24",
                "exactDuration": True,
            },
        )

        assert r.status_code == 200, r.text
        t2v = fake_services.ltx_api_client.text_to_video_calls
        assert len(t2v) == 1
        assert t2v[0]["duration"] == 6.0
        assert fake_services.video_trimmer.trim_calls == [(r.json()["video_path"], 3.0)]

    def test_forced_api_off_list_duration_still_400_without_exact_mode(
        self, client, test_state
    ):
        test_state.config.force_api_generations = True
        test_state.state.app_settings.ltx_api_key = "api-key"
        r = client.post(
            "/api/generate",
            json={"prompt": "x", "model": "fast", "resolution": "1080p", "duration": "3", "fps": "24"},
        )
        assert r.status_code == 400
        assert "INVALID_FORCED_API_DURATION" in r.text

    def test_trim_failure_still_delivers_the_video(self, client, test_state, fake_services):
        test_state.state.app_settings.fal_api_key = "fal-key"
        fake_services.video_trimmer.probe_result = 4.0
        fake_services.video_trimmer.raise_on_trim = RuntimeError("ffmpeg exploded")

        r = client.post(
            "/api/generate",
            json={"prompt": "a dog", "model": "seedance-2.0", "duration": "3", "exactDuration": True},
        )

        # The (possibly paid) generation is delivered untrimmed rather than discarded.
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "complete"
        assert r.json()["video_path"]
