"""Tests for Director's Palette image generation (dp_ key → /api/v1/images/generate)."""

from __future__ import annotations

import pytest

from api_types import GenerateImageRequest
from services.palette_image_client.palette_image_client_impl import PaletteImageClientImpl
from tests.fakes.services import FakeHTTPClient, FakeResponse


def test_palette_image_client_posts_then_downloads():
    http = FakeHTTPClient()
    http.queue("post", FakeResponse(status_code=200, json_payload={"imageUrl": "https://dp.media/i.png", "creditsUsed": 10}))
    http.queue("get", FakeResponse(status_code=200, content=b"PNG-BYTES"))

    client = PaletteImageClientImpl(http=http, base_url="https://dp.test")
    result = client.generate_image(
        api_key="dp_secret",
        model="nano-banana-2",
        prompt="a cat astronaut",
        aspect_ratio="16:9",
        reference_image_urls=["https://r/1.png"],
    )

    assert result == b"PNG-BYTES"
    post = http.calls[0]
    assert post.url == "https://dp.test/api/v1/images/generate"
    assert post.headers is not None and post.headers["Authorization"] == "Bearer dp_secret"
    assert post.json_payload == {
        "prompt": "a cat astronaut",
        "model": "nano-banana-2",
        "aspectRatio": "16:9",
        "referenceImages": ["https://r/1.png"],
    }
    assert http.calls[1].method == "get"
    assert http.calls[1].url == "https://dp.media/i.png"


def test_palette_image_client_raises_on_http_error():
    http = FakeHTTPClient()
    http.queue("post", FakeResponse(status_code=402, text="insufficient_credits"))
    client = PaletteImageClientImpl(http=http)
    with pytest.raises(RuntimeError):
        client.generate_image(api_key="dp_k", model="nano-banana-2", prompt="x")


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


def test_dp_image_model_without_palette_key_errors(test_state):
    test_state.state.app_settings.image_model = "dp-nano-banana-2"
    test_state.state.app_settings.palette_api_key = ""
    with pytest.raises(Exception):
        test_state.image_generation.generate(
            GenerateImageRequest(prompt="x", width=512, height=512, numImages=1, numSteps=4)
        )
