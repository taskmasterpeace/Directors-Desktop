"""Tests for model download spec consistency and RuntimeConfig path derivation."""

from __future__ import annotations

from typing import get_args

from state import RuntimeConfig
from runtime_config.model_download_specs import (
    DEFAULT_MODEL_DOWNLOAD_SPECS,
    DEFAULT_REQUIRED_MODEL_TYPES,
    MODEL_FILE_ORDER,
    resolve_required_model_types,
)
from state.app_state_types import ModelFileType


def _build_config(tmp_path):
    models_dir = tmp_path / "models"
    return RuntimeConfig(
        device="cpu",
        models_dir=models_dir,
        model_download_specs=DEFAULT_MODEL_DOWNLOAD_SPECS,
        required_model_types=DEFAULT_REQUIRED_MODEL_TYPES,
        outputs_dir=tmp_path / "outputs",
        ic_lora_dir=models_dir / "ic-loras",
        settings_file=tmp_path / "settings.json",
        ltx_api_base_url="https://api.ltx.video",
        force_api_generations=False,
        use_sage_attention=False,
        camera_motion_prompts={},
        default_negative_prompt="",
    )


def test_specs_cover_all_model_types():
    expected_types = set(get_args(ModelFileType))
    assert set(DEFAULT_MODEL_DOWNLOAD_SPECS.keys()) == expected_types
    assert set(MODEL_FILE_ORDER) == expected_types


def test_model_path_resolves_from_relative_path(tmp_path):
    config = _build_config(tmp_path)
    spec = config.spec_for("text_encoder")
    assert config.model_path("text_encoder") == config.models_dir / spec.relative_path


def test_downloading_path_is_derived_from_specs(tmp_path):
    config = _build_config(tmp_path)

    assert config.downloading_path("checkpoint") == config.downloading_dir
    assert config.downloading_path("zit") == config.downloading_dir / "Z-Image-Turbo"
    assert config.downloading_path("text_encoder") == config.downloading_dir / "gemma-3-12b-it-qat-q4_0-unquantized"


def test_text_encoder_always_required_when_base_nonempty():
    # LTX cloud text encoding is disabled fork-wide → the local text encoder is
    # ALWAYS required for local generation. Neither an ltx_api_key nor a stale
    # use_local_text_encoder=False (the old upgrader default) waives it.
    for has_api in (True, False):
        for use_local in (True, False):
            required = resolve_required_model_types(
                DEFAULT_REQUIRED_MODEL_TYPES, has_api_key=has_api, use_local_text_encoder=use_local
            )
            assert "text_encoder" in required, f"has_api={has_api} use_local={use_local}"


def test_required_model_types_empty_base_stays_empty():
    required = resolve_required_model_types(
        frozenset(),
        has_api_key=False,
    )
    assert required == frozenset()
