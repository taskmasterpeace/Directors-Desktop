"""State package exports.

``AppHandler`` and ``build_initial_state`` live in ``app_handler``, which itself
imports ``state.app_settings`` / ``state.app_state_types``. Re-exporting them
eagerly here made the two modules mutually dependent AT IMPORT TIME, so whether
the import succeeded depended on which one Python happened to load first:

    import state        -> fine
    import app_handler  -> ImportError: cannot import name 'AppHandler'

Every current entry point imports ``state`` first, which is why this never bit
in production — but any new script, test, or tool reaching for ``app_handler``
directly crashed on import.

Exposing the two names lazily (PEP 562) keeps ``from state import AppHandler``
working for existing callers while removing the import-time cycle entirely.
"""

from typing import TYPE_CHECKING, Any

from runtime_config.runtime_config import RuntimeConfig
from state.deps import get_state_service, init_state_service, set_state_service_for_tests
from state.app_state_types import AppState

if TYPE_CHECKING:
    # Type checkers resolve these statically; at runtime they come from __getattr__.
    from app_handler import AppHandler as AppHandler
    from app_handler import build_initial_state as build_initial_state

__all__ = [
    "AppState",
    "AppHandler",
    "RuntimeConfig",
    "build_initial_state",
    "get_state_service",
    "init_state_service",
    "set_state_service_for_tests",
]

_LAZY = frozenset({"AppHandler", "build_initial_state"})


def __getattr__(name: str) -> Any:
    """Resolve the app_handler exports on first use rather than at import time."""
    if name in _LAZY:
        import app_handler

        return getattr(app_handler, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
