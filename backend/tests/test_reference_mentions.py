"""Tests for Phase 1b @name / @category reference-mention resolution."""

from __future__ import annotations

from dataclasses import dataclass

from server_utils.prompt_language import resolve_reference_mentions


@dataclass
class _Ref:
    id: str
    name: str
    category: str
    image_path: str


def test_named_reference_mention_resolves_to_image():
    refs = [
        _Ref("1", "Hero Shot", "people", "C:/hero.png"),
        _Ref("2", "Castle", "places", "C:/castle.png"),
    ]
    assert resolve_reference_mentions("a shot of @HeroShot at dusk", refs) == ["C:/hero.png"]


def test_category_mention_picks_from_pool():
    refs = [_Ref("1", "Alice", "people", "C:/a.png"), _Ref("2", "Bob", "people", "C:/b.png")]
    assert resolve_reference_mentions("@people walking", refs) == ["C:/a.png"]


def test_version_qualifier_matches_base_name():
    refs = [_Ref("1", "Hero", "props", "C:/h.png")]
    assert resolve_reference_mentions("@Hero:v2 in frame", refs) == ["C:/h.png"]


def test_dedups_and_skips_empty_paths():
    refs = [_Ref("1", "Hero", "props", "C:/h.png"), _Ref("2", "Empty", "props", "")]
    assert resolve_reference_mentions("@Hero @Hero @Empty", refs) == ["C:/h.png"]


def test_unknown_mention_ignored():
    assert resolve_reference_mentions("@nobody here", []) == []


def test_reference_mention_reaches_generation(client, test_state, fake_services):
    """An @name reference mention should attach the reference image to a Seedance 2.0 job."""
    test_state.state.app_settings.fal_api_key = "fal-key"
    test_state.library.create_reference(name="Hero", category="people", image_path="C:/hero.png")

    job = test_state.job_queue.submit(
        job_type="video",
        model="seedance-2.0",
        params={"prompt": "@Hero runs through a field", "duration": 5},
        slot="api",
    )
    from handlers.job_executors import _prepare_video_params

    prepared = _prepare_video_params(test_state, dict(job.params))
    assert "C:/hero.png" in prepared["referenceImagePaths"]
