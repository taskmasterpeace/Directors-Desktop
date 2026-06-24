"""Director's Palette prompting language.

Two lightweight, deterministic expansions that let the desktop speak the same prompt
dialect as the Director's Palette web app:

1. ``@CharacterName`` mentions  -> the character's name plus its description, and the
   referenced character ids (so a character's reference image can drive a start frame).
2. ``[shot directive]`` tokens -> cinematic phrasing the video models understand.

Both are pure string transforms with no side effects, so they are trivially testable
and safe to run on every prompt.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Protocol

_MENTION_RE = re.compile(r"@([A-Za-z0-9_\-]+)")
_DIRECTIVE_RE = re.compile(r"\[([^\[\]]+)\]")


class CharacterLike(Protocol):
    id: str
    name: str
    description: str


class ReferenceLike(Protocol):
    # Read-only properties so a concrete ``category: Literal[...]`` is accepted (covariance).
    @property
    def id(self) -> str: ...
    @property
    def name(self) -> str: ...
    @property
    def category(self) -> str: ...
    @property
    def image_path(self) -> str: ...


# Director's Palette reference categories (a ``@category`` mention picks from a pool).
REFERENCE_CATEGORIES: frozenset[str] = frozenset({"people", "places", "props", "other"})


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


# Director's Palette shot-directive dialect -> cinematic phrasing.
SHOT_DIRECTIVES: dict[str, str] = {
    "static": "static locked-off camera, no camera movement",
    "dolly in": "dolly in, camera smoothly pushing forward",
    "push in": "slow push in, camera easing toward the subject",
    "dolly out": "dolly out, camera smoothly pulling back",
    "pull back": "camera pulling back to reveal the scene",
    "pan left": "camera panning left",
    "pan right": "camera panning right",
    "tilt up": "camera tilting up",
    "tilt down": "camera tilting down",
    "crane up": "crane up, camera rising",
    "crane down": "crane down, camera descending",
    "orbit": "camera orbiting around the subject",
    "handheld": "handheld camera, subtle natural shake",
    "close up": "close-up shot",
    "wide shot": "wide establishing shot",
    "tracking": "tracking shot following the subject",
}


def expand_character_mentions(
    prompt: str, characters: Sequence[CharacterLike]
) -> tuple[str, list[str]]:
    """Replace ``@Name`` mentions with the character's name and append descriptions.

    Returns the expanded prompt and the ids of referenced characters (ordered, de-duped).
    Unknown mentions are left untouched so arbitrary ``@`` text is never mangled.
    """
    by_slug: dict[str, CharacterLike] = {}
    for character in characters:
        by_slug.setdefault(_slug(character.name), character)

    referenced: list[str] = []

    def _replace(match: re.Match[str]) -> str:
        token = match.group(1)
        character = by_slug.get(_slug(token))
        if character is None:
            return match.group(0)
        if character.id not in referenced:
            referenced.append(character.id)
        return character.name

    expanded = _MENTION_RE.sub(_replace, prompt)

    id_to_char = {c.id: c for c in characters}
    descriptions = [
        f"{id_to_char[cid].name}: {id_to_char[cid].description.strip()}"
        for cid in referenced
        if id_to_char[cid].description.strip()
    ]
    if descriptions:
        expanded = f"{expanded} ({'; '.join(descriptions)})"

    return expanded, referenced


def expand_shot_directives(prompt: str) -> str:
    """Replace ``[shot directive]`` tokens with cinematic phrasing.

    Unknown directives are left as plain text (brackets stripped) so the prompt stays clean.
    """

    def _replace(match: re.Match[str]) -> str:
        token = match.group(1).strip().lower()
        return SHOT_DIRECTIVES.get(token, match.group(1).strip())

    return _DIRECTIVE_RE.sub(_replace, prompt)


def resolve_reference_mentions(
    prompt: str, references: Sequence[ReferenceLike]
) -> list[str]:
    """Resolve ``@name`` and ``@category`` reference mentions to image paths (Phase 1b).

    - ``@hero`` (slug match a Reference's name) -> that reference's image_path.
    - ``@people`` / ``@places`` / ``@props`` / ``@other`` -> the first reference in that
      category (deterministic so it is testable; a caller may shuffle the pool for variety).
    - ``@hero:v2`` version qualifier -> the mention regex stops at ``:`` so this matches the
      base name ``hero`` (there is no per-reference version store yet; the qualifier is ignored).

    Returns image paths in mention order, de-duped, skipping references with no image.
    Character mentions and unknown tokens are ignored here (handled by
    :func:`expand_character_mentions`).
    """
    by_slug: dict[str, ReferenceLike] = {}
    by_category: dict[str, list[ReferenceLike]] = {}
    for ref in references:
        by_slug.setdefault(_slug(ref.name), ref)
        by_category.setdefault(ref.category, []).append(ref)

    paths: list[str] = []
    for match in _MENTION_RE.finditer(prompt):
        slug = _slug(match.group(1))
        chosen: ReferenceLike | None = None
        if slug in REFERENCE_CATEGORIES:
            members = by_category.get(slug) or []
            chosen = members[0] if members else None
        else:
            chosen = by_slug.get(slug)
        if chosen and chosen.image_path and chosen.image_path not in paths:
            paths.append(chosen.image_path)
    return paths


def expand_prompt(prompt: str, characters: Sequence[CharacterLike]) -> tuple[str, list[str]]:
    """Apply the full Director's Palette prompt language: mentions then shot directives."""
    expanded, referenced = expand_character_mentions(prompt, characters)
    return expand_shot_directives(expanded), referenced
