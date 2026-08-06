"""Which local ComfyUI engine (H3 / LTX) is currently up, if any.

The local engines (services/h3_local_client, services/ltx_comfy_client) share
one ComfyUI instance on 127.0.0.1:8188 and record their memory-policy profile
in ``<comfy_dir>/dd_comfy_profile.txt`` (first line ``"<engine>|<flags>"``,
second line the launcher pid). DD itself never tracked that state, so the UI
could only show a neutral "local" pill — and users read a cold engine as
loaded-and-ready, then watched a "5 minute" render take 11.

This helper turns the marker + a cheap localhost probe into an honest state
the health endpoint can expose: which engine profile owns the instance and
whether it is actually serving.
"""

from __future__ import annotations

import json
import os
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

_COMFY_PORT = 8188
_PROFILE_MARKER = "dd_comfy_profile.txt"
_PROBE_TIMEOUT_S = 0.5


def resolve_comfy_dir() -> Path:
    """The same default the job executors use — override via DD_COMFY_DIR."""
    return Path(os.environ.get("DD_COMFY_DIR", r"D:\comfy\ComfyUI_windows_portable"))


def parse_profile_engine(marker_text: str) -> str | None:
    """First line of the marker is ``"<engine>|<flags>"`` — return the engine
    prefix (``"h3"`` / ``"ltx"``), or None for an empty/garbled marker."""
    first = marker_text.splitlines()[0].strip() if marker_text.strip() else ""
    if not first:
        return None
    engine = first.split("|", 1)[0].strip()
    return engine or None


def _default_probe() -> bool:
    """True when a ComfyUI answers on the shared local port. Connection refused
    resolves in microseconds, so this is safe to call from a health poll."""
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{_COMFY_PORT}/system_stats")
        with urllib.request.urlopen(req, timeout=_PROBE_TIMEOUT_S) as r:  # noqa: S310 - localhost only
            json.loads(r.read())
        return True
    except Exception:
        return False


@dataclass(frozen=True)
class ComfyEngineState:
    """``profile`` is the engine that LAUNCHED the running instance ("h3"/"ltx"),
    None when nothing is running or the marker is missing/stale."""

    profile: str | None
    running: bool


def get_comfy_engine_state(
    comfy_dir: Path | None = None,
    probe: Callable[[], bool] | None = None,
) -> ComfyEngineState:
    running = (probe or _default_probe)()
    if not running:
        return ComfyEngineState(profile=None, running=False)
    marker = (comfy_dir or resolve_comfy_dir()) / _PROFILE_MARKER
    try:
        engine = parse_profile_engine(marker.read_text(encoding="utf-8"))
    except Exception:
        engine = None
    return ComfyEngineState(profile=engine, running=True)
