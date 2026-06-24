"""Tests for the Director's Palette prompting language (@character mentions + shot directives)."""

from __future__ import annotations

from dataclasses import dataclass

from server_utils.prompt_language import expand_character_mentions, expand_shot_directives


@dataclass
class _Char:
    id: str
    name: str
    description: str = ""
    reference_image_paths: list[str] | None = None


def test_expands_known_mention_to_name_and_description():
    chars = [_Char(id="c1", name="Hero", description="a tall knight in silver armor")]
    text, refs = expand_character_mentions("@Hero walks forward", chars)
    assert "Hero walks forward" in text
    assert "silver armor" in text
    assert refs == ["c1"]


def test_slug_match_is_case_and_space_insensitive():
    chars = [_Char(id="c1", name="John Doe", description="")]
    text, refs = expand_character_mentions("@johndoe enters", chars)
    assert refs == ["c1"]
    assert text.startswith("John Doe enters")


def test_unknown_mention_is_left_untouched():
    text, refs = expand_character_mentions("@Nobody appears", [])
    assert text == "@Nobody appears"
    assert refs == []


def test_no_mentions_returns_prompt_unchanged():
    text, refs = expand_character_mentions("a quiet forest", [_Char(id="c1", name="Hero")])
    assert text == "a quiet forest"
    assert refs == []


def test_multiple_mentions_dedup_and_ordered():
    chars = [
        _Char(id="c1", name="Hero", description="brave"),
        _Char(id="c2", name="Villain", description="sinister"),
    ]
    _text, refs = expand_character_mentions("@Hero fights @Villain then @Hero wins", chars)
    assert refs == ["c1", "c2"]


def test_shot_directive_expands_known_token():
    text = expand_shot_directives("a city street [dolly in] at night")
    assert "[dolly in]" not in text
    assert "dolly" in text.lower()


def test_shot_directive_leaves_plain_text():
    assert expand_shot_directives("a plain prompt") == "a plain prompt"
