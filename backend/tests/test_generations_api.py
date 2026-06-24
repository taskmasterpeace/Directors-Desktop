"""Tests for the agent-native GET /api/generations endpoint."""

from __future__ import annotations


def test_generations_lists_jobs_with_prompts(client, test_state):
    job = test_state.job_queue.submit(
        job_type="video",
        model="seedance-2.0",
        params={"prompt": "a dog running", "referenceImagePaths": ["/lib/hero.png"]},
        slot="api",
    )
    test_state.job_queue.update_job(job.id, status="complete", result_paths=["/out/v.mp4"])

    r = client.get("/api/generations")
    assert r.status_code == 200
    gens = r.json()["generations"]
    assert len(gens) == 1
    g = gens[0]
    assert g["id"] == job.id
    assert g["prompt"] == "a dog running"
    assert g["model"] == "seedance-2.0"
    assert g["status"] == "complete"
    assert g["result_paths"] == ["/out/v.mp4"]
    assert g["reference_image_paths"] == ["/lib/hero.png"]


def test_generations_empty_when_none(client):
    r = client.get("/api/generations")
    assert r.status_code == 200
    assert r.json()["generations"] == []
