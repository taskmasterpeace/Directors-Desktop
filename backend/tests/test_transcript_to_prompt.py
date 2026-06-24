"""Tests for POST /api/transcript/to-prompt (Phase 3 transcript→generate bridge)."""

from __future__ import annotations

from tests.fakes.services import FakeResponse


def _gemini(text: str) -> FakeResponse:
    return FakeResponse(
        status_code=200,
        json_payload={"candidates": [{"content": {"parts": [{"text": text}]}}]},
    )


def _system_text(fake_services) -> str:
    call = fake_services.http.calls[0]
    assert call.json_payload is not None
    return call.json_payload["systemInstruction"]["parts"][0]["text"]


def test_story_aware_includes_full_story_and_video_guidance(client, test_state, fake_services):
    test_state.state.app_settings.gemini_api_key = "g-key"
    fake_services.http.queue("post", _gemini("A neon city street at night, rain falling."))

    r = client.post(
        "/api/transcript/to-prompt",
        json={
            "text": "she steps into the rain",
            "targetModel": "seedance-2.0",
            "storyAware": True,
            "fullStory": "In a cyberpunk city, a detective named Mara hunted a ghost.",
            "mediaType": "video",
        },
    )

    assert r.status_code == 200, r.text
    sys = _system_text(fake_services)
    assert "FULL STORY" in sys
    assert "cyberpunk city" in sys  # the whole-story context is supplied
    assert "Mara" in sys
    assert "camera and motion" in sys.lower()  # video-specific guidance


def test_music_mode_uses_lyrics_not_story(client, test_state, fake_services):
    test_state.state.app_settings.gemini_api_key = "g-key"
    fake_services.http.queue("post", _gemini("Neon stage, strobing lights, a dancer mid-leap."))

    r = client.post(
        "/api/transcript/to-prompt",
        json={
            "text": "we light it up tonight",
            "mode": "music",
            "lyrics": "We light it up tonight / dancing till the morning light",
            "mediaType": "video",
        },
    )

    assert r.status_code == 200, r.text
    sys = _system_text(fake_services)
    assert "SONG LYRICS" in sys
    assert "MUSIC VIDEO" in sys
    assert "dancing till the morning light" in sys  # the lyrics are supplied as context
    assert "FULL STORY" not in sys  # music mode, not story


def test_plain_prompt_omits_story_and_uses_image_guidance(client, test_state, fake_services):
    test_state.state.app_settings.gemini_api_key = "g-key"
    fake_services.http.queue("post", _gemini("A still portrait of a woman."))

    r = client.post(
        "/api/transcript/to-prompt",
        json={
            "text": "a woman smiles",
            "mediaType": "image",
            "fullStory": "SECRET-STORY-CONTENT",  # must be ignored when not story-aware
        },
    )

    assert r.status_code == 200, r.text
    sys = _system_text(fake_services)
    assert "SECRET-STORY-CONTENT" not in sys
    assert "FULL STORY" not in sys
    assert "still image" in sys.lower()  # image-specific guidance


def test_long_story_is_truncated(client, test_state, fake_services):
    test_state.state.app_settings.gemini_api_key = "g-key"
    fake_services.http.queue("post", _gemini("A scene."))
    big_story = "word " * 4000  # ~20000 chars, over the cap

    r = client.post(
        "/api/transcript/to-prompt",
        json={"text": "a scene", "storyAware": True, "fullStory": big_story},
    )

    assert r.status_code == 200, r.text
    sys = _system_text(fake_services)
    assert "…" in sys  # truncation marker present
    assert len(sys) < len(big_story)  # the full story was not sent verbatim


def test_transcript_to_prompt_converts_excerpt(client, test_state, fake_services):
    test_state.state.app_settings.gemini_api_key = "g-key"
    fake_services.http.queue("post", _gemini("A neon-lit city at dusk, rain-slicked streets reflecting signs."))

    r = client.post(
        "/api/transcript/to-prompt",
        json={"text": "so then we walked through the rainy city at night", "targetModel": "seedance-2.0"},
    )

    assert r.status_code == 200, r.text
    assert "neon-lit city" in r.json()["prompt"]
    # the transcript-aware system prompt was sent
    call = fake_services.http.calls[0]
    assert call.json_payload is not None
    system_text = call.json_payload["systemInstruction"]["parts"][0]["text"]
    assert "transcript" in system_text.lower()


def test_transcript_to_prompt_empty_span_rejected(client, test_state):
    test_state.state.app_settings.gemini_api_key = "g-key"
    r = client.post("/api/transcript/to-prompt", json={"text": "   "})
    assert r.status_code == 400
    assert "EMPTY_TRANSCRIPT_SPAN" in r.text


def test_transcript_to_prompt_no_ai_service(client, test_state):
    test_state.state.app_settings.gemini_api_key = ""
    test_state.state.app_settings.openrouter_api_key = ""
    test_state.state.app_settings.palette_api_key = ""
    r = client.post("/api/transcript/to-prompt", json={"text": "hello world"})
    assert r.status_code == 400
    assert "NO_AI_SERVICE_CONFIGURED" in r.text
