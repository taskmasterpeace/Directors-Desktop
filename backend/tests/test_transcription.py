"""Tests for POST /api/transcribe (word-level transcription via Replicate)."""

from __future__ import annotations

from tests.fakes.services import FakeResponse


def test_transcribe_returns_word_timestamps(client, test_state, fake_services, tmp_path):
    test_state.state.app_settings.replicate_api_key = "rep-key"
    audio = tmp_path / "v.mp3"
    audio.write_bytes(b"ID3-fake-audio")
    # The handler first resolves the community model's latest version, then posts a prediction.
    fake_services.http.queue(
        "get", FakeResponse(status_code=200, json_payload={"latest_version": {"id": "ver-abc"}})
    )
    fake_services.http.queue(
        "post",
        FakeResponse(
            status_code=201,
            json_payload={
                "id": "t1",
                "status": "succeeded",
                "output": {
                    "text": "hi there",
                    "chunks": [
                        {"text": "hi", "timestamp": [0.0, 0.5]},
                        {"text": "there", "timestamp": [0.5, 1.0]},
                    ],
                },
            },
        ),
    )

    r = client.post("/api/transcribe", json={"audioPath": str(audio)})

    assert r.status_code == 200, r.text
    words = r.json()["words"]
    assert words == [
        {"text": "hi", "start": 0.0, "end": 0.5},
        {"text": "there", "start": 0.5, "end": 1.0},
    ]
    # version resolved via GET, then a prediction POSTed to /predictions with that version
    version_call = fake_services.http.calls[0]
    assert version_call.method == "get"
    assert "incredibly-fast-whisper" in version_call.url
    post_call = fake_services.http.calls[1]
    assert post_call.method == "post"
    assert post_call.url.endswith("/predictions")
    assert post_call.json_payload is not None
    assert post_call.json_payload["version"] == "ver-abc"
    assert post_call.json_payload["input"]["timestamp"] == "word"
    assert post_call.json_payload["input"]["audio"].startswith("data:audio")


def test_transcribe_without_key_returns_error(client, test_state, tmp_path):
    test_state.state.app_settings.replicate_api_key = ""
    audio = tmp_path / "v.mp3"
    audio.write_bytes(b"x")
    r = client.post("/api/transcribe", json={"audioPath": str(audio)})
    assert r.status_code == 400
    assert "REPLICATE" in r.text.upper()
