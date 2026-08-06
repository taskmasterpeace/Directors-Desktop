"""Story Stage: browse Audio Movie Studio (dramatis) books and their un-mixed
chapter exports so the editor can place dialogue/SFX/ambience/music as
separate timeline clips. Pure reads — the Studio owns rendering."""
from __future__ import annotations

from pathlib import Path
from threading import RLock

from server_utils.dramatis_bridge import (
    JsonDict,
    read_book,
    read_export,
    resolve_root,
    safe_id,
    scan_books,
)
from state.app_state_types import AppState


class DramatisHandler:
    def __init__(self, *, state: AppState, lock: RLock) -> None:
        self._state = state
        self._lock = lock

    def _root(self) -> Path | None:
        with self._lock:
            setting = self._state.app_settings.dramatis_root
        return resolve_root(setting)

    def status(self) -> JsonDict:
        root = self._root()
        if root is None:
            with self._lock:
                setting = self._state.app_settings.dramatis_root
            return {
                "available": False,
                "root": None,
                "configuredRoot": setting or None,
                "books": [],
            }
        return {
            "available": True,
            "root": str(root),
            "configuredRoot": None,
            "books": scan_books(root),
        }

    def book(self, book_dir: str) -> JsonDict | None:
        root = self._root()
        if root is None or not safe_id(book_dir):
            return None
        return read_book(root, book_dir)

    def export(self, book_dir: str, chapter: int) -> JsonDict | None:
        root = self._root()
        if root is None or not safe_id(book_dir) or chapter < 1 or chapter > 999:
            return None
        return read_export(root, book_dir, chapter)
