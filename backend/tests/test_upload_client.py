"""Tests for the fal storage upload client (reference hosting)."""

from __future__ import annotations

import pytest

from services.upload_client.fal_upload_client_impl import FalUploadClientImpl
from tests.fakes.services import FakeHTTPClient, FakeResponse


def _client(http: FakeHTTPClient) -> FalUploadClientImpl:
    return FalUploadClientImpl(http=http)


def test_initiate_then_put_returns_file_url() -> None:
    http = FakeHTTPClient()
    http.queue(
        "post",
        FakeResponse(
            status_code=200,
            json_payload={"upload_url": "https://up.fal/abc", "file_url": "https://cdn.fal/abc.png"},
        ),
    )
    http.queue("put", FakeResponse(status_code=200))

    url = _client(http).upload(api_key="k", data=b"bytes", content_type="image/png", file_name="x.png")

    assert url == "https://cdn.fal/abc.png"
    assert "storage/upload/initiate" in http.calls[0].url
    assert http.calls[0].headers is not None
    assert http.calls[0].headers["Authorization"] == "Key k"
    assert http.calls[0].json_payload == {"content_type": "image/png", "file_name": "x.png"}
    assert http.calls[1].method == "put"
    assert http.calls[1].url == "https://up.fal/abc"
    assert http.calls[1].data == b"bytes"


def test_initiate_failure_raises() -> None:
    http = FakeHTTPClient()
    http.queue("post", FakeResponse(status_code=401, text="unauthorized"))
    with pytest.raises(RuntimeError, match="fal upload"):
        _client(http).upload(api_key="k", data=b"b", content_type="image/png", file_name="x.png")


def test_put_failure_raises() -> None:
    http = FakeHTTPClient()
    http.queue(
        "post",
        FakeResponse(status_code=200, json_payload={"upload_url": "https://up.fal/abc", "file_url": "https://cdn.fal/abc.png"}),
    )
    http.queue("put", FakeResponse(status_code=500, text="boom"))
    with pytest.raises(RuntimeError, match="fal upload"):
        _client(http).upload(api_key="k", data=b"b", content_type="image/png", file_name="x.png")
