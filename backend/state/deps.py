"""Dependency wiring helpers for AppState singleton."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    # Type-only: importing app_handler at runtime here closed a cycle
    # (app_handler -> state -> state.deps -> app_handler) that made the import
    # succeed or fail depending on which module Python loaded first. Annotations
    # are strings under `from __future__ import annotations`, so this is enough.
    from app_handler import AppHandler

_app_handler: AppHandler | None = None


def init_state_service(state_service: AppHandler) -> None:
    global _app_handler
    _app_handler = state_service


def get_state_service() -> AppHandler:
    assert _app_handler is not None, "AppHandler is not initialized"
    return _app_handler


def set_state_service_for_tests(state_service: AppHandler) -> None:
    init_state_service(state_service)
