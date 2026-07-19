"""Integration-style tests for generation and image endpoints."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest

from _routes._errors import HTTPError
from state.app_state_types import GpuSlot, VideoPipelineState, VideoPipelineWarmth
from tests.fakes.services import FakeFastVideoPipeline


@dataclass
class _FakeEncodingResult:
    """Minimal stand-in for TextEncodingResult in tests."""

    video_context: object = "fake_tensor"
    audio_context: object = None

_T2V_JSON = {
    "prompt": "test",
    "resolution": "540p",
    "model": "fast",
    "duration": "2",
    "fps": "24",
}


def _write_test_wav(path: Path, *, duration_seconds: float = 0.1, sample_rate: int = 8000) -> None:
    import wave

    frame_count = max(1, int(duration_seconds * sample_rate))
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(b"\x00\x00" * frame_count)


def _enable_local_text_encoding(test_state) -> None:
    test_state.state.app_settings.use_local_text_encoder = True


def _fake_running_generation_state(test_state) -> None:
    pipeline = FakeFastVideoPipeline()
    test_state.state.gpu_slot = GpuSlot(
        active_pipeline=VideoPipelineState(
            pipeline=pipeline,
            warmth=VideoPipelineWarmth.COLD,
            is_compiled=False,
        ),
        generation=None,
    )
    test_state.generation.start_generation("running")


class TestGenerate:
    def test_t2v_happy_path(self, client, test_state, fake_services, create_fake_model_files):
        create_fake_model_files()
        _enable_local_text_encoding(test_state)

        r = client.post(
            "/api/generate",
            json={
                "prompt": "A beautiful sunset",
                "resolution": "1080p",
                "model": "fast",
                "duration": "2",
                "fps": "24",
                "cameraMotion": "none",
            },
        )

        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "complete"
        assert data["video_path"] is not None
        assert Path(data["video_path"]).exists()

        pipeline = fake_services.fast_video_pipeline
        assert len(pipeline.generate_calls) == 1

    def test_already_running(self, client, test_state):
        _fake_running_generation_state(test_state)

        r = client.post("/api/generate", json=_T2V_JSON)
        assert r.status_code == 409

    def test_i2v_nonexistent_image(self, client, test_state, create_fake_model_files):
        create_fake_model_files()
        _enable_local_text_encoding(test_state)

        r = client.post(
            "/api/generate",
            json={**_T2V_JSON, "imagePath": "/no/such/file.png"},
        )
        assert r.status_code == 400

    def test_i2v_rejects_invalid_image_content_400(self, client, test_state, create_fake_model_files, tmp_path):
        create_fake_model_files()
        _enable_local_text_encoding(test_state)
        bad_image = tmp_path / "bad.png"
        bad_image.write_bytes(b"not-a-real-png")

        r = client.post(
            "/api/generate",
            json={**_T2V_JSON, "imagePath": str(bad_image)},
        )
        assert r.status_code == 400
        assert "Invalid image file" in r.json()["error"]

    def test_resolution_mapping_540p(self, client, test_state, fake_services, create_fake_model_files):
        create_fake_model_files()
        _enable_local_text_encoding(test_state)

        r = client.post("/api/generate", json=_T2V_JSON)
        assert r.status_code == 200

        pipeline = fake_services.fast_video_pipeline
        call = pipeline.generate_calls[0]
        assert call["width"] == 960
        assert call["height"] == 512

    def test_resolution_mapping_720p(self, client, test_state, fake_services, create_fake_model_files):
        create_fake_model_files()
        _enable_local_text_encoding(test_state)

        r = client.post("/api/generate", json={**_T2V_JSON, "resolution": "720p"})
        assert r.status_code == 200

        pipeline = fake_services.fast_video_pipeline
        call = pipeline.generate_calls[0]
        assert call["width"] == 1280
        assert call["height"] == 704

    def test_locked_seed(self, client, test_state, fake_services, create_fake_model_files):
        create_fake_model_files()
        _enable_local_text_encoding(test_state)
        test_state.state.app_settings.seed_locked = True
        test_state.state.app_settings.locked_seed = 123

        r = client.post("/api/generate", json=_T2V_JSON)
        assert r.status_code == 200

        pipeline = fake_services.fast_video_pipeline
        assert pipeline.generate_calls[0]["seed"] == 123

    def test_error_sets_generation_error(self, client, test_state, fake_services, create_fake_model_files):
        create_fake_model_files()
        _enable_local_text_encoding(test_state)
        fake_services.fast_video_pipeline.raise_on_generate = RuntimeError("GPU OOM")

        r = client.post("/api/generate", json=_T2V_JSON)
        assert r.status_code == 500

        progress = test_state.generation.get_generation_progress()
        assert progress.status == "error"

    def test_cancelled_response(self, client, test_state, fake_services, create_fake_model_files):
        create_fake_model_files()
        _enable_local_text_encoding(test_state)
        fake_services.fast_video_pipeline.raise_on_generate = RuntimeError("cancelled")

        r = client.post("/api/generate", json=_T2V_JSON)
        assert r.status_code == 200
        assert r.json()["status"] == "cancelled"


class TestA2VGenerate:
    def test_a2v_generation_happy_path(self, client, test_state, fake_services, create_fake_model_files, tmp_path):
        create_fake_model_files()
        _enable_local_text_encoding(test_state)
        audio_file = tmp_path / "test_audio.wav"
        _write_test_wav(audio_file)

        r = client.post(
            "/api/generate",
            json={
                "prompt": "A music video",
                "resolution": "540p",
                "model": "fast",
                "duration": "2",
                "fps": "24",
                "audioPath": str(audio_file),
            },
        )

        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "complete"
        assert data["video_path"] is not None
        assert Path(data["video_path"]).exists()

        pipeline = fake_services.a2v_pipeline
        assert len(pipeline.generate_calls) == 1
        call = pipeline.generate_calls[0]
        assert call["audio_path"] == str(audio_file)
        assert call["audio_start_time"] == 0.0
        assert call["audio_max_duration"] is None

    def test_a2v_rejects_missing_audio_file(self, client, test_state, create_fake_model_files):
        create_fake_model_files()
        _enable_local_text_encoding(test_state)

        r = client.post(
            "/api/generate",
            json={
                "prompt": "A music video",
                "duration": "2",
                "fps": "24",
                "audioPath": "/no/such/audio.wav",
            },
        )
        assert r.status_code == 400

    def test_a2v_rejects_invalid_audio_content_400(self, client, test_state, create_fake_model_files, tmp_path):
        create_fake_model_files()
        _enable_local_text_encoding(test_state)
        audio_file = tmp_path / "bad.wav"
        audio_file.write_bytes(b"not-a-real-wav")

        r = client.post(
            "/api/generate",
            json={
                "prompt": "A music video",
                "duration": "2",
                "fps": "24",
                "audioPath": str(audio_file),
            },
        )
        assert r.status_code == 400
        assert "Invalid audio file" in r.json()["error"]

class TestLtxCloudDisabled:
    """Fork policy: nothing is ever sent to LTX/Lightricks.

    Even when the runtime config or stored settings ask for LTX-API video
    generation, routing must stay local and the LTX API client must never
    be called. These tests replace the old TestForcedApiGenerate suite,
    which exercised the (now removed) LTX cloud generation path.
    """

    def _arm_ltx_preferences(self, test_state) -> None:
        test_state.config.force_api_generations = True
        test_state.state.app_settings.ltx_api_key = "ltx-key"
        test_state.state.app_settings.user_prefers_ltx_api_video_generations = True

    def _assert_no_ltx_calls(self, fake_services) -> None:
        ltx = fake_services.ltx_api_client
        assert ltx.text_to_video_calls == []
        assert ltx.image_to_video_calls == []
        assert ltx.audio_to_video_calls == []
        assert ltx.upload_file_calls == []

    def test_policy_helper_is_hard_false(self, test_state):
        from state.app_settings import should_video_generate_with_ltx_api

        settings = test_state.state.app_settings
        settings.ltx_api_key = "ltx-key"
        settings.user_prefers_ltx_api_video_generations = True
        assert (
            should_video_generate_with_ltx_api(force_api_generations=True, settings=settings)
            is False
        )

    def test_forced_config_routes_local_and_never_calls_ltx(
        self, client, test_state, fake_services, create_fake_model_files
    ):
        create_fake_model_files()
        _enable_local_text_encoding(test_state)
        self._arm_ltx_preferences(test_state)

        r = client.post(
            "/api/generate",
            json={
                "prompt": "a calm ocean",
                "resolution": "1080p",
                "model": "fast",
                "duration": "2",
                "fps": "24",
                "cameraMotion": "none",
            },
        )

        assert r.status_code == 200, r.text
        assert r.json()["status"] == "complete"
        assert len(fake_services.fast_video_pipeline.generate_calls) == 1
        self._assert_no_ltx_calls(fake_services)

    def test_forced_api_handler_refuses_outright(self, test_state):
        from api_types import GenerateVideoRequest

        req = GenerateVideoRequest(
            prompt="x", model="fast", duration="6", resolution="1080p"
        )
        with pytest.raises(HTTPError) as exc:
            test_state.video_generation._generate_forced_api(req)
        assert "LTX_API_DISABLED" in str(exc.value.detail)


class TestGenerateCancel:
    def test_cancel_active(self, client, test_state):
        _fake_running_generation_state(test_state)

        r = client.post("/api/generate/cancel")
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "cancelling"

    def test_cancel_no_active(self, client):
        r = client.post("/api/generate/cancel")
        assert r.status_code == 200
        assert r.json()["status"] == "no_active_generation"


class TestGenerationProgress:
    def test_idle(self, client):
        r = client.get("/api/generation/progress")
        assert r.status_code == 200
        assert r.json()["status"] == "idle"

    def test_running(self, client, test_state):
        _fake_running_generation_state(test_state)
        test_state.generation.update_progress("inference", 50, 4, 8)

        r = client.get("/api/generation/progress")
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "running"
        assert data["phase"] == "inference"
        assert data["progress"] == 50
        assert data["currentStep"] == 4
        assert data["totalSteps"] == 8

    def test_running_from_api_generation_state(self, client, test_state):
        test_state.generation.start_api_generation("api-running")
        test_state.generation.update_progress("inference", 35)

        r = client.get("/api/generation/progress")
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "running"
        assert data["phase"] == "inference"
        assert data["progress"] == 35
        assert data["currentStep"] is None
        assert data["totalSteps"] is None


class TestGenerateImage:
    def test_happy_path(self, client, create_fake_model_files):
        create_fake_model_files(include_zit=True)
        r = client.post(
            "/api/generate-image",
            json={"prompt": "A cat", "width": 1024, "height": 1024, "numSteps": 4},
        )

        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "complete"
        assert len(data["image_paths"]) == 1
        assert Path(data["image_paths"][0]).exists()

    def test_dimension_clamping(self, client, fake_services, create_fake_model_files):
        create_fake_model_files(include_zit=True)
        r = client.post(
            "/api/generate-image",
            json={"prompt": "test", "width": 1023, "height": 1023},
        )
        assert r.status_code == 200

        call = fake_services.image_generation_pipeline.generate_calls[0]
        assert call["width"] == 1008
        assert call["height"] == 1008

    def test_num_images_clamped(self, client, fake_services, create_fake_model_files):
        create_fake_model_files(include_zit=True)
        r = client.post(
            "/api/generate-image",
            json={"prompt": "test", "numImages": 20},
        )
        assert r.status_code == 200

        assert len(fake_services.image_generation_pipeline.generate_calls) == 12

    def test_error(self, client, fake_services, create_fake_model_files):
        create_fake_model_files(include_zit=True)
        fake_services.image_generation_pipeline.raise_on_generate = RuntimeError("GPU OOM")

        r = client.post("/api/generate-image", json={"prompt": "test"})
        assert r.status_code == 500

    def test_cancelled(self, client, fake_services, create_fake_model_files):
        create_fake_model_files(include_zit=True)
        fake_services.image_generation_pipeline.raise_on_generate = RuntimeError("cancelled")

        r = client.post("/api/generate-image", json={"prompt": "test"})
        assert r.status_code == 200
        assert r.json()["status"] == "cancelled"


class TestForcedApiGenerateImage:
    def test_generate_image_routes_to_api(self, client, test_state, fake_services):
        test_state.config.force_api_generations = True
        test_state.state.app_settings.replicate_api_key = "rep-key"

        r = client.post(
            "/api/generate-image",
            json={"prompt": "A cat", "width": 1024, "height": 1024, "numSteps": 4, "numImages": 2},
        )

        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "complete"
        assert len(data["image_paths"]) == 2
        assert len(fake_services.image_api_client.text_to_image_calls) == 2
        assert len(fake_services.image_generation_pipeline.generate_calls) == 0

    def test_generate_image_passes_model(self, client, test_state, fake_services):
        test_state.config.force_api_generations = True
        test_state.state.app_settings.replicate_api_key = "rep-key"
        test_state.state.app_settings.image_model = "nano-banana-2"

        r = client.post(
            "/api/generate-image",
            json={"prompt": "A cat", "width": 1024, "height": 1024, "numSteps": 4, "numImages": 1},
        )

        assert r.status_code == 200
        assert fake_services.image_api_client.text_to_image_calls[0]["model"] == "nano-banana-2"

    def test_generate_image_missing_replicate_key(self, client, test_state, fake_services):
        test_state.config.force_api_generations = True
        test_state.state.app_settings.replicate_api_key = ""

        r = client.post("/api/generate-image", json={"prompt": "A cat"})

        assert r.status_code == 500
        assert r.json()["error"] == "REPLICATE_API_KEY_NOT_CONFIGURED"

    def test_generate_image_cancelled(self, client, test_state, fake_services):
        test_state.config.force_api_generations = True
        test_state.state.app_settings.replicate_api_key = "rep-key"
        fake_services.image_api_client.raise_on_text_to_image = RuntimeError("cancelled")

        r = client.post("/api/generate-image", json={"prompt": "A cat"})

        assert r.status_code == 200
        assert r.json()["status"] == "cancelled"


class TestEmptyPromptRejected:
    def test_empty_prompt_rejected(self, client):
        r = client.post("/api/generate", json={"prompt": ""})
        assert r.status_code == 422

    def test_whitespace_prompt_rejected(self, client):
        r = client.post("/api/generate", json={"prompt": "   "})
        assert r.status_code == 422

    def test_missing_prompt_rejected(self, client):
        r = client.post("/api/generate", json={})
        assert r.status_code == 422

    def test_empty_image_prompt_rejected(self, client):
        r = client.post("/api/generate-image", json={"prompt": ""})
        assert r.status_code == 422

    def test_whitespace_image_prompt_rejected(self, client):
        r = client.post("/api/generate-image", json={"prompt": "   "})
        assert r.status_code == 422

    def test_missing_image_prompt_rejected(self, client):
        r = client.post("/api/generate-image", json={})
        assert r.status_code == 422


class TestTextEncoderRouting:
    """Text encoding is local-only (LTX cloud is disabled fork-wide). Generation
    must always use the local encoder and never the dead API path — including the
    upgrader config that previously dead-ended at Generate (see the LTX-removal
    review, Finding A)."""

    def test_local_encoding_never_calls_api(self, client, test_state, fake_services, create_fake_model_files):
        create_fake_model_files()
        test_state.state.app_settings.use_local_text_encoder = True
        test_state.state.app_settings.prompt_enhancer_enabled_t2v = True

        r = client.post("/api/generate", json=_T2V_JSON)
        assert r.status_code == 200
        assert len(fake_services.text_encoder.encode_calls) == 0

    def test_upgrader_config_uses_local_not_dead_api(self, client, test_state, fake_services, create_fake_model_files):
        # Regression (Finding A): an upgrader's settings.json can carry
        # {ltx_api_key set, use_local_text_encoder: False} from the old
        # API-encoder default. With the local encoder present, generation MUST
        # route to it — not the disabled API — and must NOT dead-end at Generate.
        create_fake_model_files()
        test_state.state.app_settings.ltx_api_key = "stale-upgrader-key"
        test_state.state.app_settings.use_local_text_encoder = False

        r = client.post("/api/generate", json=_T2V_JSON)
        assert r.status_code == 200, r.text
        assert len(fake_services.text_encoder.encode_calls) == 0


def test_generate_video_request_accepts_last_frame_path():
    from api_types import GenerateVideoRequest
    req = GenerateVideoRequest(prompt="test", lastFramePath="/path/to/last.png")
    assert req.lastFramePath == "/path/to/last.png"


def test_generate_video_request_last_frame_defaults_none():
    from api_types import GenerateVideoRequest
    req = GenerateVideoRequest(prompt="test")
    assert req.lastFramePath is None
