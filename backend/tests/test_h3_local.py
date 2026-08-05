"""Tests for the local MiniMax H3 engine wiring (no ComfyUI/GPU required).

Covers the pure spec helpers, the ported node graph's shape, and that the model
routes to the local gpu slot (never api/fal).
"""
from pathlib import Path

from services.h3_local_client import (
    H3_LOCAL_MODEL,
    ComfyH3LocalClientImpl,
    h3_dimensions,
    h3_snap_frames,
)


def test_snap_frames_lands_on_the_17k_plus_5_grid() -> None:
    assert h3_snap_frames(5) == 124
    assert h3_snap_frames(15) == 362
    for secs in (1, 2, 4, 5, 7, 10, 12, 15):
        assert (h3_snap_frames(secs) - 5) % 17 == 0
    assert h3_snap_frames(0.01) >= 5


def test_dimensions_landscape_portrait_and_fallback() -> None:
    assert h3_dimensions("480p", "16:9") == (854, 480)
    assert h3_dimensions("480p", "9:16") == (480, 854)
    assert h3_dimensions("720p", "16:9") == (1280, 704)
    # portrait is the same pixel budget transposed (measured free)
    assert h3_dimensions("720p", "9:16") == (704, 1280)
    # unknown tier falls back to 480p rather than crashing
    assert h3_dimensions("banana", "16:9") == (854, 480)


def test_graph_selects_ref_node_int8_and_snapped_frames() -> None:
    client = ComfyH3LocalClientImpl(comfy_dir=Path("."))
    g = client._build_graph(  # type: ignore[attr-defined]  # noqa: SLF001
        prompt="x", width=854, height=480, frames=124, quant="int8",
        ref="C:/a/artist.png", first=None, last=None, seed=7,
    )
    assert g["6"]["class_type"] == "MiniMaxH3ReferenceToVideo"
    unet = g["1"]["inputs"]["unet_name"]
    assert "int8" in unet and "ref2va" in unet
    assert g["8"]["inputs"]["steps"] == 20
    assert g["6"]["inputs"]["length"] == 124


def test_graph_without_ref_uses_image_node() -> None:
    client = ComfyH3LocalClientImpl(comfy_dir=Path("."))
    g = client._build_graph(  # type: ignore[attr-defined]  # noqa: SLF001
        prompt="x", width=854, height=480, frames=124, quant="int8",
        ref=None, first=None, last=None, seed=7,
    )
    assert g["6"]["class_type"] == "MiniMaxH3ImageToVideo"
    assert "fl2va" in g["1"]["inputs"]["unet_name"]


def test_h3_local_routes_to_gpu_slot(test_state) -> None:  # type: ignore[no-untyped-def]
    # Local engine: free, user's GPU. Never the api/fal slot.
    assert test_state.determine_slot(H3_LOCAL_MODEL) == "gpu"
