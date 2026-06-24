"""Library handler for characters, styles, and references."""

from __future__ import annotations

import re
from pathlib import Path

from _routes._errors import HTTPError
from state.library_store import (
    AudioReference,
    AudioSource,
    Character,
    LibraryStore,
    Reference,
    ReferenceCategory,
    Style,
)


def _safe_filename(filename: str) -> str:
    """Strip directory components and unsafe characters from an uploaded filename."""
    base = Path(filename).name
    return re.sub(r"[^A-Za-z0-9._-]", "_", base).strip("._")


class LibraryHandler:
    """Business logic for the local library (characters, styles, references)."""

    def __init__(self, store: LibraryStore) -> None:
        self._store = store

    # ------------------------------------------------------------------
    # Characters
    # ------------------------------------------------------------------

    def list_characters(self) -> list[Character]:
        return self._store.list_characters()

    def resolve_reference_paths(
        self,
        *,
        character_id: str | None = None,
        reference_id: str | None = None,
    ) -> list[str]:
        """Resolve a character (ALL its images) or a reference to local image paths.

        Used to attach a Director's Palette character/reference as reference images
        (Seedance 2.0 omni-reference / image-gen likeness) — never as a start frame.
        """
        paths: list[str] = []
        if character_id:
            character = self._store.get_character(character_id)
            if character:
                paths.extend(p for p in character.reference_image_paths if p)
        if reference_id:
            reference = self._store.get_reference(reference_id)
            if reference and reference.image_path:
                paths.append(reference.image_path)
        return paths

    def create_character(
        self,
        *,
        name: str,
        role: str,
        description: str,
        reference_image_paths: list[str] | None = None,
    ) -> Character:
        if not name.strip():
            raise HTTPError(400, "Character name must not be empty")
        return self._store.create_character(
            name=name,
            role=role,
            description=description,
            reference_image_paths=reference_image_paths,
        )

    def update_character(
        self,
        character_id: str,
        *,
        name: str | None = None,
        role: str | None = None,
        description: str | None = None,
        reference_image_paths: list[str] | None = None,
    ) -> Character:
        if name is not None and not name.strip():
            raise HTTPError(400, "Character name must not be empty")
        character = self._store.update_character(
            character_id,
            name=name,
            role=role,
            description=description,
            reference_image_paths=reference_image_paths,
        )
        if character is None:
            raise HTTPError(404, f"Character {character_id} not found")
        return character

    def delete_character(self, character_id: str) -> None:
        deleted = self._store.delete_character(character_id)
        if not deleted:
            raise HTTPError(404, f"Character {character_id} not found")

    # ------------------------------------------------------------------
    # Styles
    # ------------------------------------------------------------------

    def list_styles(self) -> list[Style]:
        return self._store.list_styles()

    def create_style(
        self,
        *,
        name: str,
        description: str,
        reference_image_path: str = "",
    ) -> Style:
        if not name.strip():
            raise HTTPError(400, "Style name must not be empty")
        return self._store.create_style(
            name=name,
            description=description,
            reference_image_path=reference_image_path,
        )

    def delete_style(self, style_id: str) -> None:
        deleted = self._store.delete_style(style_id)
        if not deleted:
            raise HTTPError(404, f"Style {style_id} not found")

    # ------------------------------------------------------------------
    # References
    # ------------------------------------------------------------------

    def list_references(self, category: ReferenceCategory | None = None) -> list[Reference]:
        return self._store.list_references(category)

    def create_reference(
        self,
        *,
        name: str,
        category: ReferenceCategory,
        image_path: str = "",
    ) -> Reference:
        if not name.strip():
            raise HTTPError(400, "Reference name must not be empty")
        return self._store.create_reference(
            name=name,
            category=category,
            image_path=image_path,
        )

    def delete_reference(self, reference_id: str) -> None:
        deleted = self._store.delete_reference(reference_id)
        if not deleted:
            raise HTTPError(404, f"Reference {reference_id} not found")

    # ------------------------------------------------------------------
    # Audio references
    # ------------------------------------------------------------------

    def list_audio(self) -> list[AudioReference]:
        return self._store.list_audio()

    def create_audio(
        self,
        *,
        name: str,
        file_path: str,
        source: AudioSource = "upload",
        duration_seconds: float = 0.0,
    ) -> AudioReference:
        if not name.strip():
            raise HTTPError(400, "Audio reference name must not be empty")
        if not file_path.strip():
            raise HTTPError(400, "Audio reference file_path must not be empty")
        return self._store.create_audio(
            name=name,
            file_path=file_path,
            source=source,
            duration_seconds=duration_seconds,
        )

    def upload_audio(self, *, filename: str, data: bytes, duration_seconds: float = 0.0) -> AudioReference:
        """Save uploaded audio bytes under the library and register it as a reference."""
        if not data:
            raise HTTPError(400, "Audio upload is empty")
        safe = _safe_filename(filename)
        if not safe:
            raise HTTPError(400, "Invalid audio filename")
        dest = self._store.audio_storage_dir() / safe
        dest.write_bytes(data)
        name = Path(filename).stem or safe
        return self._store.create_audio(
            name=name,
            file_path=str(dest),
            source="upload",
            duration_seconds=duration_seconds,
        )

    def delete_audio(self, audio_id: str) -> None:
        deleted = self._store.delete_audio(audio_id)
        if not deleted:
            raise HTTPError(404, f"Audio reference {audio_id} not found")
