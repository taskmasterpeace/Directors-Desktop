"""F9 — the import graph must not depend on load order.

``app_handler`` imports ``state``; ``state`` re-exported ``AppHandler`` and
``state.deps`` imported it eagerly. That closed a cycle, so:

    import state        -> worked
    import app_handler  -> ImportError

Every existing entry point happens to import ``state`` first, which hid it. Any
new script, tool or test that reached for ``app_handler`` directly crashed.

These run in subprocesses because import order is a property of a FRESH
interpreter — once pytest has imported everything, sys.modules hides the cycle.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent


def _import_in_fresh_interpreter(statement: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", statement],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        timeout=180,
    )


def test_app_handler_can_be_imported_first():
    result = _import_in_fresh_interpreter("import app_handler")
    assert result.returncode == 0, (
        "importing app_handler before state must not fail:\n" + result.stderr[-1500:]
    )


def test_state_can_be_imported_first():
    result = _import_in_fresh_interpreter("import state")
    assert result.returncode == 0, result.stderr[-1500:]


def test_state_still_re_exports_the_handler_api():
    """The lazy re-export must remain transparent to existing callers."""
    result = _import_in_fresh_interpreter(
        "from state import AppHandler, build_initial_state; "
        "assert AppHandler.__name__ == 'AppHandler'; "
        "assert callable(build_initial_state)"
    )
    assert result.returncode == 0, result.stderr[-1500:]


def test_unknown_attribute_still_raises_attribute_error():
    """__getattr__ must not turn typos into silent None."""
    result = _import_in_fresh_interpreter(
        "import state\n"
        "try:\n"
        "    state.NotAThing\n"
        "except AttributeError:\n"
        "    pass\n"
        "else:\n"
        "    raise SystemExit('expected AttributeError')\n"
    )
    assert result.returncode == 0, result.stderr[-1500:]
