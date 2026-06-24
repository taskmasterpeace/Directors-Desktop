"""Tests for the ReplicateVideoClientImpl video API client (Seedance 1.5 Pro)."""

from __future__ import annotations

import pytest

from services.video_api_client.replicate_video_client_impl import ReplicateVideoClientImpl
from tests.fakes.services import FakeHTTPClient, FakeResponse

API_KEY = "test-replicate-key"
SEEDANCE_MODEL = "seedance-1.5-pro"
BASE_URL = "https://api.replicate.com/v1"

START_FRAME = "data:image/png;base64,AAAA"
END_FRAME = "data:image/png;base64,BBBB"


def _make_client(http: FakeHTTPClient) -> ReplicateVideoClientImpl:
    return ReplicateVideoClientImpl(http=http, api_base_url=BASE_URL)


def _default_kwargs() -> dict[str, object]:
    return {
        "api_key": API_KEY,
        "model": SEEDANCE_MODEL,
        "prompt": "A cat walking on a beach",
        "duration": 5,
        "resolution": "720p",
        "aspect_ratio": "16:9",
        "generate_audio": False,
    }


def _queue_succeeded(http: FakeHTTPClient, video_bytes: bytes = b"mp4") -> None:
    http.queue(
        "post",
        FakeResponse(
            status_code=201,
            json_payload={
                "id": "pred123",
                "status": "succeeded",
                "output": "https://replicate.delivery/video.mp4",
            },
        ),
    )
    http.queue("get", FakeResponse(status_code=200, content=video_bytes))


def test_seedance_sync_success_hits_model_endpoint() -> None:
    http = FakeHTTPClient()
    _queue_succeeded(http, b"fake-mp4-video-content")

    client = _make_client(http)
    result = client.generate_video(**_default_kwargs())

    assert result == b"fake-mp4-video-content"
    assert len(http.calls) == 2
    assert http.calls[0].method == "post"
    assert "bytedance/seedance-1.5-pro" in http.calls[0].url
    assert http.calls[1].method == "get"


def test_seedance_payload_omits_unsupported_resolution() -> None:
    # seedance-1.5-pro has no `resolution` input; sending it would 422.
    http = FakeHTTPClient()
    _queue_succeeded(http)

    _make_client(http).generate_video(**_default_kwargs())

    payload = http.calls[0].json_payload
    assert payload is not None
    inp = payload["input"]
    assert "resolution" not in inp
    assert inp["prompt"] == "A cat walking on a beach"
    assert inp["fps"] == 24
    assert inp["aspect_ratio"] == "16:9"
    assert isinstance(inp["seed"], int)


def test_first_frame_maps_to_image_key() -> None:
    http = FakeHTTPClient()
    _queue_succeeded(http)

    kwargs = _default_kwargs()
    kwargs["first_frame"] = START_FRAME
    _make_client(http).generate_video(**kwargs)

    inp = http.calls[0].json_payload["input"]
    assert inp["image"] == START_FRAME
    assert "last_frame_image" not in inp


def test_last_frame_with_first_frame_maps_to_last_frame_image() -> None:
    http = FakeHTTPClient()
    _queue_succeeded(http)

    kwargs = _default_kwargs()
    kwargs["first_frame"] = START_FRAME
    kwargs["last_frame"] = END_FRAME
    _make_client(http).generate_video(**kwargs)

    inp = http.calls[0].json_payload["input"]
    assert inp["image"] == START_FRAME
    assert inp["last_frame_image"] == END_FRAME


def test_last_frame_without_first_frame_is_dropped() -> None:
    # Replicate: last_frame_image only works when a start image is provided.
    http = FakeHTTPClient()
    _queue_succeeded(http)

    kwargs = _default_kwargs()
    kwargs["last_frame"] = END_FRAME
    _make_client(http).generate_video(**kwargs)

    inp = http.calls[0].json_payload["input"]
    assert "last_frame_image" not in inp
    assert "image" not in inp


def test_duration_is_clamped_to_supported_range() -> None:
    # seedance-1.5-pro supports 4..12s (verified live); below 4 the model 400s.
    http = FakeHTTPClient()
    _queue_succeeded(http)
    kwargs = _default_kwargs()
    kwargs["duration"] = 20
    _make_client(http).generate_video(**kwargs)
    assert http.calls[0].json_payload["input"]["duration"] == 12

    http2 = FakeHTTPClient()
    _queue_succeeded(http2)
    kwargs2 = _default_kwargs()
    kwargs2["duration"] = 2
    _make_client(http2).generate_video(**kwargs2)
    assert http2.calls[0].json_payload["input"]["duration"] == 4


def test_seedance_polling_success() -> None:
    http = FakeHTTPClient()
    http.queue(
        "post",
        FakeResponse(
            status_code=201,
            json_payload={
                "id": "pred456",
                "status": "processing",
                "urls": {"get": f"{BASE_URL}/predictions/pred456"},
            },
        ),
    )
    http.queue("get", FakeResponse(status_code=200, json_payload={"id": "pred456", "status": "processing"}))
    http.queue(
        "get",
        FakeResponse(
            status_code=200,
            json_payload={"id": "pred456", "status": "succeeded", "output": "https://replicate.delivery/v2.mp4"},
        ),
    )
    http.queue("get", FakeResponse(status_code=200, content=b"polled-video-content"))

    result = _make_client(http).generate_video(**_default_kwargs())
    assert result == b"polled-video-content"
    assert len(http.calls) == 4


def test_unknown_model_raises() -> None:
    http = FakeHTTPClient()
    kwargs = _default_kwargs()
    kwargs["model"] = "nonexistent-model"
    with pytest.raises(RuntimeError, match="Unknown video model"):
        _make_client(http).generate_video(**kwargs)


def test_prediction_failure_raises() -> None:
    http = FakeHTTPClient()
    http.queue(
        "post",
        FakeResponse(
            status_code=201,
            json_payload={"id": "pred789", "status": "failed", "error": "GPU out of memory"},
        ),
    )
    with pytest.raises(RuntimeError, match="Replicate prediction failed"):
        _make_client(http).generate_video(**_default_kwargs())
