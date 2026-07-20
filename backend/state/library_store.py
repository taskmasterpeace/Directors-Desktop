"""Persistent local library store for characters, styles, and references."""

from __future__ import annotations

import functools
import json
import logging
import os
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from collections.abc import Callable
from typing import Concatenate, Literal, ParamSpec, TypeVar


# Robert's taxonomy (2026-07-19): People / Places / Wardrobe / Styles are the
# working categories (shared with Director's Palette going forward). "props" and
# "other" remain readable so existing libraries load, but the UI no longer
# offers them for new references.
ReferenceCategory = Literal["people", "places", "wardrobe", "styles", "props", "other"]

_T = TypeVar("_T")


@dataclass
class Character:
    id: str
    name: str
    role: str
    description: str
    reference_image_paths: list[str] = field(default_factory=lambda: list[str]())
    created_at: str = ""


@dataclass
class Style:
    id: str
    name: str
    description: str
    reference_image_path: str = ""
    created_at: str = ""


@dataclass
class Reference:
    id: str
    name: str
    category: ReferenceCategory
    image_path: str = ""
    created_at: str = ""


AudioSource = Literal["upload", "timeline", "library"]


@dataclass
class AudioReference:
    id: str
    name: str
    file_path: str = ""
    source: AudioSource = "upload"
    duration_seconds: float = 0.0
    created_at: str = ""


# character/other cover recipes imported from Director's Palette
# (its categories: characters / scenes / styles / products).
RecipeKind = Literal["location", "wardrobe", "style", "character", "other"]


@dataclass
class Recipe:
    id: str
    name: str
    kind: RecipeKind
    text: str = ""
    created_at: str = ""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


logger = logging.getLogger(__name__)

_P = ParamSpec("_P")
_R = TypeVar("_R")


def _with_lock(fn: Callable[Concatenate["LibraryStore", _P], _R]) -> Callable[Concatenate["LibraryStore", _P], _R]:
    """Serialize a mutating LibraryStore method under the store's RLock.

    Queue-worker threads read the library while /api/library/* routes mutate it;
    without this, concurrent read-modify-write pairs could lose updates.
    """

    @functools.wraps(fn)
    def wrapper(self: "LibraryStore", *args: _P.args, **kwargs: _P.kwargs) -> _R:
        with self._lock:  # pyright: ignore[reportPrivateUsage]
            return fn(self, *args, **kwargs)

    return wrapper


def _load_json_list(path: Path, cls: type[_T]) -> list[_T]:
    """Load a list of dataclass instances from a JSON file.

    A corrupt file is renamed to ``<name>.corrupt-<timestamp>`` instead of being
    silently treated as empty — previously the next save would persist the empty
    list over the user's data, making the loss permanent.
    """
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return [cls(**item) for item in raw]  # type: ignore[arg-type]
    except (json.JSONDecodeError, TypeError, KeyError) as exc:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        quarantine = path.with_name(f"{path.name}.corrupt-{stamp}")
        try:
            os.replace(path, quarantine)
            logger.error("Corrupt library file %s (%s) — preserved as %s", path.name, exc, quarantine.name)
        except OSError:
            logger.error("Corrupt library file %s (%s) — could not quarantine", path.name, exc)
        return []


def _write_json(path: Path, data: list[dict[str, object]]) -> None:
    # Temp file + atomic replace (same pattern as JobQueue._save): a crash or
    # concurrent reader can never observe a truncated file, which _load_json_list
    # would otherwise quarantine on the next start.
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, path)


class LibraryStore:
    """Manages JSON file persistence for library entities."""

    def __init__(self, library_dir: Path) -> None:
        self._lock = threading.RLock()
        self._dir = library_dir
        self._dir.mkdir(parents=True, exist_ok=True)
        self._characters_file = self._dir / "characters.json"
        self._styles_file = self._dir / "styles.json"
        self._references_file = self._dir / "references.json"
        self._audio_file = self._dir / "audio.json"
        self._recipes_file = self._dir / "recipes.json"

        self._characters: list[Character] = _load_json_list(self._characters_file, Character)
        self._styles: list[Style] = _load_json_list(self._styles_file, Style)
        self._references: list[Reference] = _load_json_list(self._references_file, Reference)
        self._audio: list[AudioReference] = _load_json_list(self._audio_file, AudioReference)
        self._recipes: list[Recipe] = _load_json_list(self._recipes_file, Recipe)

    # ------------------------------------------------------------------
    # Characters
    # ------------------------------------------------------------------

    def list_characters(self) -> list[Character]:
        return list(self._characters)

    def get_character(self, character_id: str) -> Character | None:
        for c in self._characters:
            if c.id == character_id:
                return c
        return None

    @_with_lock
    def create_character(
        self,
        *,
        name: str,
        role: str,
        description: str,
        reference_image_paths: list[str] | None = None,
    ) -> Character:
        character = Character(
            id=_new_id(),
            name=name,
            role=role,
            description=description,
            reference_image_paths=reference_image_paths or [],
            created_at=_now_iso(),
        )
        self._characters.append(character)
        self._save_characters()
        return character

    @_with_lock
    def update_character(
        self,
        character_id: str,
        *,
        name: str | None = None,
        role: str | None = None,
        description: str | None = None,
        reference_image_paths: list[str] | None = None,
    ) -> Character | None:
        character = self.get_character(character_id)
        if character is None:
            return None
        if name is not None:
            character.name = name
        if role is not None:
            character.role = role
        if description is not None:
            character.description = description
        if reference_image_paths is not None:
            character.reference_image_paths = reference_image_paths
        self._save_characters()
        return character

    @_with_lock
    def delete_character(self, character_id: str) -> bool:
        before = len(self._characters)
        self._characters = [c for c in self._characters if c.id != character_id]
        if len(self._characters) < before:
            self._save_characters()
            return True
        return False

    # ------------------------------------------------------------------
    # Styles
    # ------------------------------------------------------------------

    def list_styles(self) -> list[Style]:
        return list(self._styles)

    def get_style(self, style_id: str) -> Style | None:
        for s in self._styles:
            if s.id == style_id:
                return s
        return None

    @_with_lock
    def create_style(
        self,
        *,
        name: str,
        description: str,
        reference_image_path: str = "",
    ) -> Style:
        style = Style(
            id=_new_id(),
            name=name,
            description=description,
            reference_image_path=reference_image_path,
            created_at=_now_iso(),
        )
        self._styles.append(style)
        self._save_styles()
        return style

    @_with_lock
    def delete_style(self, style_id: str) -> bool:
        before = len(self._styles)
        self._styles = [s for s in self._styles if s.id != style_id]
        if len(self._styles) < before:
            self._save_styles()
            return True
        return False

    # ------------------------------------------------------------------
    # References
    # ------------------------------------------------------------------

    def list_references(self, category: ReferenceCategory | None = None) -> list[Reference]:
        if category is None:
            return list(self._references)
        return [r for r in self._references if r.category == category]

    def get_reference(self, reference_id: str) -> Reference | None:
        for r in self._references:
            if r.id == reference_id:
                return r
        return None

    @_with_lock
    def create_reference(
        self,
        *,
        name: str,
        category: ReferenceCategory,
        image_path: str = "",
    ) -> Reference:
        ref = Reference(
            id=_new_id(),
            name=name,
            category=category,
            image_path=image_path,
            created_at=_now_iso(),
        )
        self._references.append(ref)
        self._save_references()
        return ref

    @_with_lock
    def delete_reference(self, reference_id: str) -> bool:
        before = len(self._references)
        self._references = [r for r in self._references if r.id != reference_id]
        if len(self._references) < before:
            self._save_references()
            return True
        return False

    # ------------------------------------------------------------------
    # Audio references (Seedance 2.0 audio refs / lip-sync; sources: upload,
    # timeline clip, or voiceover/music library)
    # ------------------------------------------------------------------

    def audio_storage_dir(self) -> Path:
        """Directory where uploaded audio files are saved (created on demand)."""
        directory = self._dir / "audio"
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def list_audio(self) -> list[AudioReference]:
        return list(self._audio)

    def get_audio(self, audio_id: str) -> AudioReference | None:
        for a in self._audio:
            if a.id == audio_id:
                return a
        return None

    @_with_lock
    def create_audio(
        self,
        *,
        name: str,
        file_path: str,
        source: AudioSource = "upload",
        duration_seconds: float = 0.0,
    ) -> AudioReference:
        audio = AudioReference(
            id=_new_id(),
            name=name,
            file_path=file_path,
            source=source,
            duration_seconds=duration_seconds,
            created_at=_now_iso(),
        )
        self._audio.append(audio)
        self._save_audio()
        return audio

    @_with_lock
    def delete_audio(self, audio_id: str) -> bool:
        before = len(self._audio)
        self._audio = [a for a in self._audio if a.id != audio_id]
        if len(self._audio) < before:
            self._save_audio()
            return True
        return False

    # ------------------------------------------------------------------
    # Recipes (named prompt snippets: locations / wardrobe / style)
    # ------------------------------------------------------------------

    def list_recipes(self, kind: RecipeKind | None = None) -> list[Recipe]:
        if kind is None:
            return list(self._recipes)
        return [r for r in self._recipes if r.kind == kind]

    def get_recipe(self, recipe_id: str) -> Recipe | None:
        for r in self._recipes:
            if r.id == recipe_id:
                return r
        return None

    @_with_lock
    def create_recipe(
        self,
        *,
        name: str,
        kind: RecipeKind,
        text: str,
    ) -> Recipe:
        recipe = Recipe(
            id=_new_id(),
            name=name,
            kind=kind,
            text=text,
            created_at=_now_iso(),
        )
        self._recipes.append(recipe)
        self._save_recipes()
        return recipe

    @_with_lock
    def delete_recipe(self, recipe_id: str) -> bool:
        before = len(self._recipes)
        self._recipes = [r for r in self._recipes if r.id != recipe_id]
        if len(self._recipes) < before:
            self._save_recipes()
            return True
        return False

    # ------------------------------------------------------------------
    # Persistence helpers
    # ------------------------------------------------------------------

    def _save_characters(self) -> None:
        _write_json(self._characters_file, [asdict(c) for c in self._characters])

    def _save_styles(self) -> None:
        _write_json(self._styles_file, [asdict(s) for s in self._styles])

    def _save_references(self) -> None:
        _write_json(self._references_file, [asdict(r) for r in self._references])

    def _save_audio(self) -> None:
        _write_json(self._audio_file, [asdict(a) for a in self._audio])

    def _save_recipes(self) -> None:
        _write_json(self._recipes_file, [asdict(r) for r in self._recipes])
