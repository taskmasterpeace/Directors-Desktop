"""Director's enhance flow: analyze -> direction -> four visible choices.

Edge cases Robert asked for: Palette-only setups (no LLM key), very long
prompts, empty prompts, malformed provider responses.
"""
from __future__ import annotations

from tests.fakes.services import FakeResponse


def _palette_ok(text: str) -> FakeResponse:
    return FakeResponse(status_code=200, json_payload={"expandedPrompt": text})


class TestDirectionsPhase:
    def test_palette_only_returns_house_directions(self, client, test_state):
        test_state.state.app_settings.palette_api_key = "dp_key"
        resp = client.post("/api/enhance-prompt/options", json={"prompt": "a rapper on a roof", "model": "h3-local"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["question"]
        assert len(data["options"]) == 4
        assert all(o["id"] and o["label"] for o in data["options"])

    def test_empty_prompt_still_offers_directions(self, client, test_state):
        test_state.state.app_settings.palette_api_key = "dp_key"
        resp = client.post("/api/enhance-prompt/options", json={"prompt": "", "model": "h3-local"})
        assert resp.status_code == 200
        assert len(resp.json()["options"]) == 4


class TestVariantsPhase:
    def test_palette_path_returns_up_to_four_distinct_variants(self, client, test_state, fake_services):
        test_state.state.app_settings.palette_api_key = "dp_key"
        http = fake_services.http
        for i in range(4):
            http.queue("post", _palette_ok(f"enhanced variant {i}"))
        resp = client.post("/api/enhance-prompt/options", json={
            "prompt": "a rapper on a roof", "model": "h3-local", "direction": "hype",
        })
        assert resp.status_code == 200
        variants = resp.json()["variants"]
        assert len(variants) == 4
        assert len(set(variants)) == 4
        # The chosen direction's guidance was folded into every expander call.
        sent = [c.json_payload["prompt"] for c in http.calls if "prompt-expander" in c.url]
        assert all("Music-video hype" in p for p in sent)

    def test_duplicate_and_failed_provider_responses_are_tolerated(self, client, test_state, fake_services):
        test_state.state.app_settings.palette_api_key = "dp_key"
        http = fake_services.http
        http.queue("post", _palette_ok("same text"), _palette_ok("same text"),
                   FakeResponse(status_code=500, json_payload={"error": "boom"}), _palette_ok("different text"))
        resp = client.post("/api/enhance-prompt/options", json={
            "prompt": "x", "model": "h3-local", "direction": "locked",
        })
        assert resp.status_code == 200
        variants = resp.json()["variants"]
        assert variants == ["same text", "different text"]

    def test_very_long_prompt_is_clamped_not_rejected(self, client, test_state, fake_services):
        test_state.state.app_settings.palette_api_key = "dp_key"
        http = fake_services.http
        for _ in range(4):
            http.queue("post", _palette_ok("ok"))
        long_prompt = "cinematic " * 600  # ~6000 chars
        resp = client.post("/api/enhance-prompt/options", json={
            "prompt": long_prompt, "model": "h3-local", "direction": "moving",
        })
        assert resp.status_code == 200
        sent = [c.json_payload["prompt"] for c in http.calls if "prompt-expander" in c.url]
        assert all(len(p) < 3300 for p in sent)

    def test_no_provider_at_all_fails_loudly(self, client, test_state):
        test_state.state.app_settings.palette_api_key = ""
        test_state.state.app_settings.palette_generation_key = ""
        resp = client.post("/api/enhance-prompt/options", json={
            "prompt": "x", "model": "h3-local", "direction": "locked",
        })
        assert resp.status_code == 400


class TestGuideSelection:
    """The selected model decides the prompting language the enhancer speaks."""

    def test_each_model_family_gets_its_own_guide(self):
        from handlers.enhance_prompt_handler import (
            _H3_GUIDE, _LTX_GUIDE, _SEEDANCE_GUIDE, _guide_for_model,
        )
        assert _guide_for_model("h3-local") is _H3_GUIDE
        assert _guide_for_model("ltx-comfy") is _LTX_GUIDE
        assert _guide_for_model("ltx-fast") is _LTX_GUIDE
        assert _guide_for_model("seedance-1.0-pro") is _SEEDANCE_GUIDE
        assert _guide_for_model("dp-seedance-fast") is _SEEDANCE_GUIDE
        # Unknown models fall back to the H3 house language, never crash.
        assert _guide_for_model("future-model") is _H3_GUIDE

    def test_guides_carry_their_models_laws(self):
        from handlers.enhance_prompt_handler import _LTX_GUIDE, _SEEDANCE_GUIDE
        # LTX: specificity + simple camera + described (not performed) audio.
        assert "subject -> action -> camera -> mood" in _LTX_GUIDE
        assert "avoid fast complex movement" in _LTX_GUIDE
        # Seedance: the formula + timeline prompting + no fast/rapid.
        assert "timeline prompting" in _SEEDANCE_GUIDE
        assert "'fast' and 'rapid'" in _SEEDANCE_GUIDE
