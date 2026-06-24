"""Tests for the audio-reference library (/api/library/audio)."""

from __future__ import annotations


def test_audio_library_crud(client):
    # starts empty
    assert client.get("/api/library/audio").json()["audio"] == []

    # create
    r = client.post(
        "/api/library/audio",
        json={"name": "Narration take 1", "file_path": "C:/lib/audio/vo.mp3",
              "source": "upload", "duration_seconds": 12.5},
    )
    assert r.status_code == 200, r.text
    created = r.json()
    assert created["name"] == "Narration take 1"
    assert created["file_path"] == "C:/lib/audio/vo.mp3"
    assert created["source"] == "upload"
    assert created["duration_seconds"] == 12.5
    audio_id = created["id"]

    # list shows it
    listed = client.get("/api/library/audio").json()["audio"]
    assert len(listed) == 1 and listed[0]["id"] == audio_id

    # delete
    assert client.delete(f"/api/library/audio/{audio_id}").status_code == 200
    assert client.get("/api/library/audio").json()["audio"] == []


def test_audio_create_rejects_empty_name(client):
    r = client.post("/api/library/audio", json={"name": "  ", "file_path": "C:/a.mp3"})
    assert r.status_code == 400


def test_audio_create_rejects_empty_path(client):
    r = client.post("/api/library/audio", json={"name": "x", "file_path": ""})
    assert r.status_code == 400


def test_audio_delete_missing_returns_404(client):
    assert client.delete("/api/library/audio/does-not-exist").status_code == 404


def test_audio_multipart_upload_saves_and_registers(client):
    r = client.post(
        "/api/library/audio/upload",
        files={"file": ("narration.mp3", b"ID3-fake-audio-bytes", "audio/mpeg")},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["name"] == "narration"
    assert data["source"] == "upload"
    assert data["file_path"].endswith("narration.mp3")
    listed = client.get("/api/library/audio").json()["audio"]
    assert any(a["id"] == data["id"] for a in listed)


def test_audio_upload_rejects_empty_file(client):
    r = client.post(
        "/api/library/audio/upload",
        files={"file": ("empty.mp3", b"", "audio/mpeg")},
    )
    assert r.status_code == 400
