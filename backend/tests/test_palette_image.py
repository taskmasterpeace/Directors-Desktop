"""Tests for Director's Palette image generation (dp_ key → live v2 API)."""

from __future__ import annotations

import pytest
from PIL import Image as PILImage

from api_types import GenerateImageRequest
from services.palette_image_client.palette_image_client_impl import PaletteImageClientImpl
from tests.fakes.services import FakeHTTPClient, FakeResponse


def _client(http: FakeHTTPClient) -> PaletteImageClientImpl:
    # poll_interval 0 + no-op sleep so polling loops run instantly in tests.
    return PaletteImageClientImpl(http=http, base_url="https://dp.test", poll_interval=0.0, sleep=lambda _s: None)


# -- standard models: submit → poll jobs → download ---------------------------


def test_generate_image_submits_polls_then_downloads():
    http = FakeHTTPClient()
    http.queue("post", FakeResponse(status_code=201, json_payload={"success": True, "data": {"job_id": "job_123", "status": "pending"}}))
    http.queue("get", FakeResponse(status_code=200, json_payload={"success": True, "data": {"status": "processing"}}))
    http.queue("get", FakeResponse(status_code=200, json_payload={"success": True, "data": {"status": "completed", "result": {"url": "https://dp.media/i.png"}}}))
    http.queue("get", FakeResponse(status_code=200, content=b"PNG-BYTES"))

    result = _client(http).generate_image(
        api_key="dp_secret",
        model="nano-banana-2",
        prompt="a cat astronaut",
        aspect_ratio="16:9",
        reference_image_urls=["https://r/1.png"],
    )

    assert result == b"PNG-BYTES"
    post = http.calls[0]
    assert post.url == "https://dp.test/api/v2/images/generate"
    assert post.headers is not None and post.headers["Authorization"] == "Bearer dp_secret"
    assert post.json_payload == {
        "model": "nano-banana-2",
        "prompt": "a cat astronaut",
        "aspect_ratio": "16:9",
        "num_images": 1,
        "reference_images": ["https://r/1.png"],
    }
    # Two job polls against the job URL, then the image download.
    assert http.calls[1].url == "https://dp.test/api/v2/jobs/job_123"
    assert http.calls[2].url == "https://dp.test/api/v2/jobs/job_123"
    assert http.calls[3].url == "https://dp.media/i.png"


def test_generate_image_forwards_model_params():
    http = FakeHTTPClient()
    http.queue("post", FakeResponse(status_code=201, json_payload={"success": True, "data": {"job_id": "j", "status": "pending"}}))
    http.queue("get", FakeResponse(status_code=200, json_payload={"success": True, "data": {"status": "completed", "result": {"url": "https://dp.media/i.png"}}}))
    http.queue("get", FakeResponse(status_code=200, content=b"PNG"))

    _client(http).generate_image(
        api_key="k",
        model="gpt-image-2",
        prompt="a fox",
        aspect_ratio="3:2",
        params={"quality": "medium", "seed": 42, "model": "IGNORED"},
    )

    post = http.calls[0]
    assert post.json_payload is not None
    # extra params forwarded verbatim...
    assert post.json_payload["quality"] == "medium"
    assert post.json_payload["seed"] == 42
    # ...but core fields always win over a colliding param key.
    assert post.json_payload["model"] == "gpt-image-2"
    assert post.json_payload["prompt"] == "a fox"
    assert post.json_payload["aspect_ratio"] == "3:2"
    assert post.json_payload["num_images"] == 1


def test_generate_image_raises_on_submit_error():
    http = FakeHTTPClient()
    http.queue("post", FakeResponse(status_code=402, text="insufficient_pts"))
    with pytest.raises(RuntimeError):
        _client(http).generate_image(api_key="k", model="nano-banana-2", prompt="x")


def test_generate_image_raises_when_job_fails():
    http = FakeHTTPClient()
    http.queue("post", FakeResponse(status_code=201, json_payload={"success": True, "data": {"job_id": "j", "status": "pending"}}))
    http.queue("get", FakeResponse(status_code=200, json_payload={"success": True, "data": {"status": "failed", "error_message": "content policy"}}))
    with pytest.raises(RuntimeError, match="content policy"):
        _client(http).generate_image(api_key="k", model="nano-banana-2", prompt="x")


# -- reference upload (multipart) ---------------------------------------------


def test_upload_reference_posts_multipart_and_returns_url():
    http = FakeHTTPClient()
    http.queue("post", FakeResponse(status_code=201, json_payload={"success": True, "data": {"id": "g1", "url": "https://dp.media/up.png"}}))

    url = _client(http).upload_reference(
        api_key="k", image_bytes=b"IMGDATA", file_name="ref.png", content_type="image/png"
    )

    assert url == "https://dp.media/up.png"
    post = http.calls[0]
    assert post.url == "https://dp.test/api/v2/images/upload"
    # No Content-Type header — requests sets the multipart boundary itself.
    assert post.headers is not None and "Content-Type" not in post.headers
    assert post.files is not None and post.files["file"] == ("ref.png", b"IMGDATA", "image/png")


# -- camera angle (synchronous) -----------------------------------------------


def test_generate_camera_angle_posts_and_downloads():
    http = FakeHTTPClient()
    http.queue("post", FakeResponse(status_code=200, json_payload={"success": True, "data": {"url": "https://dp.media/cam.png", "prediction_id": "p"}}))
    http.queue("get", FakeResponse(status_code=200, content=b"CAM"))

    result = _client(http).generate_camera_angle(
        api_key="k",
        image_url="https://r/subject.png",
        azimuth=90,
        elevation=10,
        distance=7,
        prompt="hero shot",
        lora_scale=0.6,
    )

    assert result == b"CAM"
    post = http.calls[0]
    assert post.url == "https://dp.test/api/v2/images/camera-angle"
    assert post.json_payload == {
        "image_url": "https://r/subject.png",
        "azimuth": 90,
        "elevation": 10,
        "distance": 7,
        "prompt": "hero shot",
        "lora_scale": 0.6,
    }
    assert http.calls[1].url == "https://dp.media/cam.png"


# -- handler routing (via fake client) ----------------------------------------


def test_dp_image_model_routes_through_palette(test_state, fake_services):
    test_state.state.app_settings.image_model = "dp-nano-banana-2"
    test_state.state.app_settings.palette_api_key = "dp_userkey"

    result = test_state.image_generation.generate(
        GenerateImageRequest(prompt="a dragon over a city", width=1024, height=576, numImages=1, numSteps=4)
    )

    assert result.status == "complete"
    calls = fake_services.palette_image_client.calls
    assert len(calls) == 1
    assert calls[0]["api_key"] == "dp_userkey"
    assert calls[0]["model"] == "nano-banana-2"  # the "dp-" prefix is stripped for DP's API
    assert calls[0]["aspect_ratio"] == "16:9"  # 1024x576 → 16:9
    assert result.image_paths and result.image_paths[0].endswith(".png")
    # the Replicate image client was NOT used
    assert not fake_services.image_api_client.text_to_image_calls


def test_dp_image_model_threads_model_params(test_state, fake_services):
    test_state.state.app_settings.image_model = "dp-nano-banana-2"
    test_state.state.app_settings.palette_api_key = "dp_userkey"

    result = test_state.image_generation.generate(
        GenerateImageRequest(
            prompt="a dragon over a city",
            width=1024,
            height=1024,
            numImages=1,
            numSteps=4,
            modelParams={"resolution": "2K", "personGeneration": "allow_adult"},
        )
    )

    assert result.status == "complete"
    calls = fake_services.palette_image_client.calls
    assert len(calls) == 1
    sent = calls[0]["params"]
    assert sent["resolution"] == "2K"
    assert sent["personGeneration"] == "allow_adult"
    # The handler injects a per-image seed so numImages=N gives N distinct results.
    assert isinstance(sent.get("seed"), int)


def test_job_model_overrides_saved_setting(test_state, fake_services):
    """The model picked in the UI travels on the job and wins over the saved default.

    Regression: _execute_image used to drop job.model, so every image ran on
    whatever app_settings.image_model happened to be — the picker did nothing.
    """
    test_state.state.app_settings.image_model = "flux-klein-9b"  # saved default is LOCAL
    test_state.state.app_settings.palette_api_key = "dp_userkey"

    result = test_state.image_generation.generate(
        GenerateImageRequest(
            prompt="a dragon over a city",
            model="dp-nano-banana-2-lite",  # ...but this job asked for a Palette model
            width=1024,
            height=1024,
            numImages=1,
            numSteps=4,
        )
    )

    assert result.status == "complete"
    calls = fake_services.palette_image_client.calls
    assert len(calls) == 1
    assert calls[0]["model"] == "nano-banana-2-lite"


def test_dp_camera_angle_model_uploads_ref_and_routes(test_state, fake_services, tmp_path):
    test_state.state.app_settings.image_model = "dp-qwen-image-edit"
    test_state.state.app_settings.palette_api_key = "dp_userkey"
    subject = tmp_path / "subject.png"
    PILImage.new("RGB", (512, 512), "blue").save(subject)

    result = test_state.image_generation.generate(
        GenerateImageRequest(
            prompt="turn around",
            width=512,
            height=512,
            numImages=1,
            numSteps=4,
            referenceImagePaths=[str(subject)],
            modelParams={"azimuth": 90, "elevation": 10, "distance": 7, "loraScale": 0.6, "aspectRatio": "1:1"},
        )
    )

    assert result.status == "complete"
    # the reference was uploaded to Palette first...
    uploads = fake_services.palette_image_client.upload_calls
    assert len(uploads) == 1
    # ...then routed to the synchronous camera-angle endpoint, not standard generate.
    cams = fake_services.palette_image_client.camera_calls
    assert len(cams) == 1
    assert cams[0]["azimuth"] == 90.0 and cams[0]["elevation"] == 10.0 and cams[0]["distance"] == 7.0
    assert cams[0]["lora_scale"] == 0.6
    assert cams[0]["aspect_ratio"] == "1:1"
    assert cams[0]["image_url"].startswith("https://fake.dp/uploads/")
    assert not fake_services.palette_image_client.calls


def test_dp_camera_angle_without_reference_errors(test_state):
    test_state.state.app_settings.image_model = "dp-qwen-image-edit"
    test_state.state.app_settings.palette_api_key = "dp_userkey"
    with pytest.raises(Exception):
        test_state.image_generation.generate(
            GenerateImageRequest(prompt="x", width=512, height=512, numImages=1, numSteps=4)
        )


def test_dp_models_route_to_api_slot(test_state):
    """dp- models are cloud-only: they must never occupy the gpu slot.

    Regression: determine_slot only knew the seedance/nano set, so dp- image
    jobs landed on "gpu" — blocking local generation during cloud polls,
    colliding with api-slot jobs, and dodging credit deduction.
    """
    for model in ("dp-nano-banana-2", "dp-nano-banana-2-lite", "dp-gpt-image-2", "dp-qwen-image-edit"):
        assert test_state.determine_slot(model) == "api"
    assert test_state.determine_slot("z-image-turbo") == "gpu"


def test_dp_image_model_without_palette_key_errors(test_state):
    test_state.state.app_settings.image_model = "dp-nano-banana-2"
    test_state.state.app_settings.palette_api_key = ""
    with pytest.raises(Exception):
        test_state.image_generation.generate(
            GenerateImageRequest(prompt="x", width=512, height=512, numImages=1, numSteps=4)
        )
