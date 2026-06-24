"""Tests for the FalVideoClientImpl (Seedance 2.0 via fal queue REST API)."""

from __future__ import annotations

import pytest

from services.fal_video_client.fal_video_client_impl import FalVideoClientImpl
from tests.fakes.services import FakeHTTPClient, FakeResponse

FAL_KEY = "fal-test-key"
QUEUE_BASE = "https://queue.fal.run"
START_FRAME = "data:image/png;base64,AAAA"
END_FRAME = "data:image/png;base64,BBBB"


def _make_client(http: FakeHTTPClient) -> FalVideoClientImpl:
    return FalVideoClientImpl(http=http, queue_base_url=QUEUE_BASE)


def _kwargs(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "api_key": FAL_KEY,
        "model": "seedance-2.0",
        "prompt": "a dog running through a field",
        "duration": 5,
        "resolution": "720p",
        "aspect_ratio": "16:9",
        "generate_audio": True,
    }
    base.update(overrides)
    return base


def _queue_completed(http: FakeHTTPClient, video_bytes: bytes = b"fal-mp4") -> None:
    http.queue(
        "post",
        FakeResponse(
            status_code=200,
            json_payload={
                "request_id": "req1",
                "status": "IN_QUEUE",
                "status_url": f"{QUEUE_BASE}/bytedance/seedance-2.0/requests/req1/status",
                "response_url": f"{QUEUE_BASE}/bytedance/seedance-2.0/requests/req1",
            },
        ),
    )
    http.queue("get", FakeResponse(status_code=200, json_payload={"status": "COMPLETED"}))
    http.queue(
        "get",
        FakeResponse(status_code=200, json_payload={"video": {"url": "https://fal.media/out.mp4"}}),
    )
    http.queue("get", FakeResponse(status_code=200, content=video_bytes))


def test_status_poll_keeps_going_through_202_in_queue() -> None:
    """Regression: fal returns HTTP 202 while IN_QUEUE/IN_PROGRESS — must poll, not fail.

    Caught by a live paid run; the previous code treated any non-200 poll as an error,
    which broke every real generation (fakes had only ever returned 200).
    """
    http = FakeHTTPClient()
    http.queue(
        "post",
        FakeResponse(
            status_code=200,
            json_payload={
                "request_id": "req1",
                "status": "IN_QUEUE",
                "status_url": f"{QUEUE_BASE}/bytedance/seedance-2.0/requests/req1/status",
                "response_url": f"{QUEUE_BASE}/bytedance/seedance-2.0/requests/req1",
            },
        ),
    )
    # fal's real queue behaviour: 202 while still working, then 200 when done.
    http.queue("get", FakeResponse(status_code=202, json_payload={"status": "IN_QUEUE"}))
    http.queue("get", FakeResponse(status_code=202, json_payload={"status": "IN_PROGRESS"}))
    http.queue("get", FakeResponse(status_code=200, json_payload={"status": "COMPLETED"}))
    http.queue(
        "get",
        FakeResponse(status_code=200, json_payload={"video": {"url": "https://fal.media/out.mp4"}}),
    )
    http.queue("get", FakeResponse(status_code=200, content=b"final-mp4"))

    result = _make_client(http).generate_video(**_kwargs(reference_images=["https://img/1.png"]))
    assert result == b"final-mp4"


def test_image_to_video_success_uses_image_route_and_key_auth() -> None:
    http = FakeHTTPClient()
    _queue_completed(http, b"the-video-bytes")

    result = _make_client(http).generate_video(**_kwargs(first_frame=START_FRAME))

    assert result == b"the-video-bytes"
    submit = http.calls[0]
    assert submit.method == "post"
    assert "bytedance/seedance-2.0/image-to-video" in submit.url
    assert submit.headers is not None
    assert submit.headers["Authorization"] == f"Key {FAL_KEY}"
    body = submit.json_payload
    assert body is not None
    assert body["image_url"] == START_FRAME
    assert body["prompt"] == "a dog running through a field"


def test_last_frame_maps_to_end_image_url() -> None:
    http = FakeHTTPClient()
    _queue_completed(http)
    _make_client(http).generate_video(**_kwargs(first_frame=START_FRAME, last_frame=END_FRAME))
    body = http.calls[0].json_payload
    assert body["image_url"] == START_FRAME
    assert body["end_image_url"] == END_FRAME


def test_no_first_frame_uses_text_to_video_route() -> None:
    http = FakeHTTPClient()
    _queue_completed(http)
    _make_client(http).generate_video(**_kwargs())
    submit = http.calls[0]
    assert "bytedance/seedance-2.0/text-to-video" in submit.url
    assert "image_url" not in submit.json_payload


def test_fast_variant_routes_to_fast_endpoint() -> None:
    http = FakeHTTPClient()
    _queue_completed(http)
    _make_client(http).generate_video(**_kwargs(model="seedance-2.0-fast", first_frame=START_FRAME))
    assert "bytedance/seedance-2.0/fast/image-to-video" in http.calls[0].url


def test_resolution_normalized_to_fal_enum() -> None:
    http = FakeHTTPClient()
    _queue_completed(http)
    # desktop resolutions like "512p" aren't valid fal values -> nearest supported
    _make_client(http).generate_video(**_kwargs(resolution="512p"))
    assert http.calls[0].json_payload["resolution"] == "720p"


def test_duration_clamped_to_fal_range() -> None:
    http = FakeHTTPClient()
    _queue_completed(http)
    _make_client(http).generate_video(**_kwargs(duration=2))
    assert http.calls[0].json_payload["duration"] == 4

    http2 = FakeHTTPClient()
    _queue_completed(http2)
    _make_client(http2).generate_video(**_kwargs(duration=30))
    assert http2.calls[0].json_payload["duration"] == 15


def test_unknown_model_raises() -> None:
    http = FakeHTTPClient()
    with pytest.raises(RuntimeError, match="Unknown video model"):
        _make_client(http).generate_video(**_kwargs(model="not-a-model"))


def test_failed_status_raises() -> None:
    http = FakeHTTPClient()
    http.queue(
        "post",
        FakeResponse(
            status_code=200,
            json_payload={
                "request_id": "req2",
                "status": "IN_QUEUE",
                "status_url": f"{QUEUE_BASE}/x/requests/req2/status",
                "response_url": f"{QUEUE_BASE}/x/requests/req2",
            },
        ),
    )
    http.queue("get", FakeResponse(status_code=200, json_payload={"status": "FAILED", "error": "bad input"}))
    with pytest.raises(RuntimeError, match="fal"):
        _make_client(http).generate_video(**_kwargs(first_frame=START_FRAME))


def test_submit_http_error_raises() -> None:
    http = FakeHTTPClient()
    http.queue("post", FakeResponse(status_code=401, text="unauthorized"))
    with pytest.raises(RuntimeError, match="fal"):
        _make_client(http).generate_video(**_kwargs(first_frame=START_FRAME))


AUDIO_REF = "data:audio/mpeg;base64,ZZZZ"


def test_reference_images_route_to_reference_to_video() -> None:
    http = FakeHTTPClient()
    _queue_completed(http)
    _make_client(http).generate_video(**_kwargs(reference_images=[START_FRAME, END_FRAME]))
    submit = http.calls[0]
    assert "bytedance/seedance-2.0/reference-to-video" in submit.url
    body = submit.json_payload
    assert body["image_urls"] == [START_FRAME, END_FRAME]
    assert "image_url" not in body


def test_reference_audio_maps_to_audio_urls_when_images_present() -> None:
    http = FakeHTTPClient()
    _queue_completed(http)
    _make_client(http).generate_video(
        **_kwargs(reference_images=[START_FRAME], reference_audio=[AUDIO_REF])
    )
    body = http.calls[0].json_payload
    assert body["audio_urls"] == [AUDIO_REF]


def test_reference_audio_dropped_without_images() -> None:
    # fal reference-to-video requires >=1 image for audio; audio alone -> text-to-video, no audio.
    http = FakeHTTPClient()
    _queue_completed(http)
    _make_client(http).generate_video(**_kwargs(reference_audio=[AUDIO_REF]))
    submit = http.calls[0]
    assert "bytedance/seedance-2.0/text-to-video" in submit.url
    assert "audio_urls" not in submit.json_payload


def test_reference_caps_images_to_9_and_audio_to_3() -> None:
    http = FakeHTTPClient()
    _queue_completed(http)
    imgs = [f"data:image/png;base64,{i}" for i in range(12)]
    auds = [f"data:audio/mpeg;base64,{i}" for i in range(5)]
    _make_client(http).generate_video(**_kwargs(reference_images=imgs, reference_audio=auds))
    body = http.calls[0].json_payload
    assert len(body["image_urls"]) == 9
    assert len(body["audio_urls"]) == 3


def test_reference_fast_variant_route() -> None:
    http = FakeHTTPClient()
    _queue_completed(http)
    _make_client(http).generate_video(
        **_kwargs(model="seedance-2.0-fast", reference_images=[START_FRAME])
    )
    assert "bytedance/seedance-2.0/fast/reference-to-video" in http.calls[0].url


def test_reference_images_take_precedence_over_first_frame() -> None:
    http = FakeHTTPClient()
    _queue_completed(http)
    _make_client(http).generate_video(
        **_kwargs(first_frame=START_FRAME, reference_images=[END_FRAME])
    )
    submit = http.calls[0]
    assert "reference-to-video" in submit.url
    assert submit.json_payload["image_urls"] == [END_FRAME]
    assert "image_url" not in submit.json_payload
