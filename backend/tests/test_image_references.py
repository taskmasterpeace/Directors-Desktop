"""Tests for image-generation reference images (nano-banana-2 image_input)."""

from __future__ import annotations

from services.image_api_client.replicate_client_impl import ReplicateImageClientImpl
from tests.fakes.services import FakeHTTPClient, FakeResponse


def _client(http: FakeHTTPClient) -> ReplicateImageClientImpl:
    return ReplicateImageClientImpl(http=http, api_base_url="https://api.replicate.com/v1")


def _queue_ok(http: FakeHTTPClient) -> None:
    http.queue(
        "post",
        FakeResponse(status_code=201, json_payload={"id": "p", "status": "succeeded", "output": "https://i.png"}),
    )
    http.queue("get", FakeResponse(status_code=200, content=b"png-bytes"))


def _gen(http: FakeHTTPClient, model: str, refs: list[str] | None) -> None:
    _client(http).generate_text_to_image(
        api_key="k",
        model=model,
        prompt="x",
        width=1024,
        height=1024,
        seed=1,
        num_inference_steps=4,
        reference_image_urls=refs,
    )


def test_nano_banana_passes_reference_images_as_image_input() -> None:
    http = FakeHTTPClient()
    _queue_ok(http)
    _gen(http, "nano-banana-2", ["urlA", "urlB"])
    assert http.calls[0].json_payload["input"]["image_input"] == ["urlA", "urlB"]


def test_nano_banana_caps_image_input_to_14() -> None:
    http = FakeHTTPClient()
    _queue_ok(http)
    _gen(http, "nano-banana-2", [f"u{i}" for i in range(16)])
    assert len(http.calls[0].json_payload["input"]["image_input"]) == 14


def test_nano_banana_without_refs_omits_image_input() -> None:
    http = FakeHTTPClient()
    _queue_ok(http)
    _gen(http, "nano-banana-2", None)
    assert "image_input" not in http.calls[0].json_payload["input"]


def test_z_image_ignores_references() -> None:
    http = FakeHTTPClient()
    _queue_ok(http)
    _gen(http, "z-image-turbo", ["urlA"])
    assert "image_input" not in http.calls[0].json_payload["input"]
