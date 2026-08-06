"""The comfy-engine state helper: marker parsing + probe combination."""
from pathlib import Path

from server_utils.comfy_engine_state import (
    ComfyEngineState,
    get_comfy_engine_state,
    parse_profile_engine,
)


def test_parse_profile_engine_extracts_prefix() -> None:
    assert parse_profile_engine("ltx|--disable-smart-memory\n12345\n") == "ltx"
    assert parse_profile_engine("h3|\n999\n") == "h3"


def test_parse_profile_engine_handles_garbage() -> None:
    assert parse_profile_engine("") is None
    assert parse_profile_engine("\n\n") is None
    assert parse_profile_engine("|flags-only\n1\n") is None


def test_not_running_reports_no_profile(tmp_path: Path) -> None:
    (tmp_path / "dd_comfy_profile.txt").write_text("ltx|--disable-smart-memory\n1\n", encoding="utf-8")
    state = get_comfy_engine_state(comfy_dir=tmp_path, probe=lambda: False)
    assert state == ComfyEngineState(profile=None, running=False)


def test_running_with_marker_reports_engine(tmp_path: Path) -> None:
    (tmp_path / "dd_comfy_profile.txt").write_text("h3|--lowvram\n42\n", encoding="utf-8")
    state = get_comfy_engine_state(comfy_dir=tmp_path, probe=lambda: True)
    assert state == ComfyEngineState(profile="h3", running=True)


def test_running_without_marker_is_unknown_profile(tmp_path: Path) -> None:
    state = get_comfy_engine_state(comfy_dir=tmp_path, probe=lambda: True)
    assert state == ComfyEngineState(profile=None, running=True)
