"""Agent bridge: read-model mirror + action queue round-trips."""

from __future__ import annotations

from pathlib import Path


def _sample_project() -> dict[str, object]:
    return {
        "id": "p1",
        "name": "Bridge Test",
        "storyDocs": [{"id": "s1", "title": "Script", "text": "JAX: go.", "kind": "script"}],
        "cast": [{"storyName": "JAX", "characterId": "char-1"}],
        "assets": [
            {
                "id": "a1",
                "transcript": {
                    "source": "stt",
                    "words": [
                        {"text": "hello", "start": 10.0, "end": 10.5},
                        {"text": "world", "start": 10.5, "end": 11.0},
                        {"text": "outside", "start": 30.0, "end": 31.0},
                    ],
                },
            }
        ],
        "activeTimelineId": "t1",
        "timelines": [
            {
                "id": "t1",
                "clips": [
                    {
                        "id": "c1",
                        "assetId": "a1",
                        "trackIndex": 0,
                        "startTime": 5.0,
                        "duration": 10.0,
                        "trimStart": 10.0,
                        "speed": 1.0,
                    }
                ],
            }
        ],
    }


def test_publish_then_read_current(client):
    resp = client.post("/api/project/publish", json={"project": _sample_project()})
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"

    resp = client.get("/api/project/current")
    assert resp.status_code == 200
    body = resp.json()
    assert body["project"]["id"] == "p1"
    assert body["publishedAt"] is not None


def test_current_is_empty_before_any_publish(client):
    resp = client.get("/api/project/current")
    assert resp.status_code == 200
    assert resp.json()["project"] is None


def test_live_transcript_maps_source_words_to_timeline_time(client):
    client.post("/api/project/publish", json={"project": _sample_project()})
    words = client.get("/api/project/transcript").json()["words"]
    # The out-of-window word (30s) is excluded; in-window words map through
    # startTime + (t - trimStart) / speed.
    assert [w["text"] for w in words] == ["hello", "world"]
    assert words[0]["start"] == 5.0
    assert words[0]["end"] == 5.5
    assert words[0]["clipId"] == "c1"


def test_live_transcript_respects_speed(client):
    project = _sample_project()
    project["timelines"][0]["clips"][0]["speed"] = 2.0  # type: ignore[index]
    client.post("/api/project/publish", json={"project": project})
    words = client.get("/api/project/transcript").json()["words"]
    assert words[0]["start"] == 5.0
    assert words[0]["end"] == 5.25  # 0.5s of source at 2x = 0.25s of timeline


def test_story_route_returns_docs_and_cast(client):
    client.post("/api/project/publish", json={"project": _sample_project()})
    body = client.get("/api/project/story").json()
    assert body["storyDocs"][0]["title"] == "Script"
    assert body["cast"][0]["storyName"] == "JAX"


def test_action_queue_roundtrip(client):
    submit = client.post(
        "/api/project/actions",
        json={"actions": [{"kind": "delete_clip", "clipId": "c1"}]},
    )
    assert submit.status_code == 200
    ids = submit.json()["ids"]
    assert len(ids) == 1

    # Delivered exactly once.
    pending = client.get("/api/project/actions/pending").json()["actions"]
    assert [p["id"] for p in pending] == ids
    assert pending[0]["action"]["kind"] == "delete_clip"
    assert client.get("/api/project/actions/pending").json()["actions"] == []

    # Renderer reports the outcome; agent sees it in status.
    client.post(
        "/api/project/actions/report",
        json={"results": [{"id": ids[0], "status": "applied"}]},
    )
    statuses = client.get("/api/project/actions/status").json()["actions"]
    assert statuses[0]["id"] == ids[0]
    assert statuses[0]["status"] == "applied"
    assert statuses[0]["kind"] == "delete_clip"


def test_report_ignores_unknown_ids_and_bad_statuses(client):
    submit = client.post(
        "/api/project/actions",
        json={"actions": [{"kind": "delete_marker", "markerId": "m1"}]},
    )
    ids = submit.json()["ids"]
    client.get("/api/project/actions/pending")
    client.post(
        "/api/project/actions/report",
        json={
            "results": [
                {"id": "act_nonexistent", "status": "applied"},
                {"id": ids[0], "status": "exploded"},
            ]
        },
    )
    statuses = client.get("/api/project/actions/status").json()["actions"]
    assert statuses[0]["status"] == "delivered"  # bad status did not stick


def test_publish_persists_to_disk_and_reloads(tmp_path: Path):
    from handlers.project_bridge_handler import ProjectBridgeHandler

    path = tmp_path / "project_read_model.json"
    first = ProjectBridgeHandler(persistence_path=path)
    first.publish({"id": "persisted"})

    reloaded = ProjectBridgeHandler(persistence_path=path)
    project, published_at = reloaded.current()
    assert project == {"id": "persisted"}
    assert published_at is not None
