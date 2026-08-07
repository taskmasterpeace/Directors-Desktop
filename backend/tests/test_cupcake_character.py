"""Tests for the cupcake character image engine wiring (no ComfyUI/GPU/network required).

Structure-only, mirroring test_ltx_local.py: the proven SDXL + InstantID + IPAdapter graph's
shape, the model-chain order (IPAdapter -> InstantID -> sampler), and that the model routes to
the local gpu slot. A real remote render on cupcake is what gates the engine in the UI.
"""
from pathlib import Path

from services.cupcake_character_client import (
    CUPCAKE_CHARACTER_MODEL,
    CupcakeCharacterClientImpl,
)


def _assert_links_resolve(graph: dict[str, object]) -> None:
    for node in graph.values():
        inputs = node["inputs"] if isinstance(node, dict) else {}
        for value in inputs.values():
            if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
                assert value[0] in graph, f"dangling link to node {value[0]!r}"


def _client() -> CupcakeCharacterClientImpl:
    return CupcakeCharacterClientImpl(base_url="http://192.168.1.249:8188", outputs_dir=Path("."))


def test_graph_has_identity_style_and_save_nodes() -> None:
    g = _client()._build_graph(  # type: ignore[attr-defined]  # noqa: SLF001
        prompt="on a rooftop", negative_prompt="", face_image="face.png", style_image="style.png",
        width=1024, height=1024, seed=7, instantid_weight=0.65, ipadapter_weight=0.72, steps=30,
    )
    class_types = {n["class_type"] for n in g.values()}
    # identity branch (face) + style/look branch (IPAdapter) + SDXL base + save
    assert "CheckpointLoaderSimple" in class_types
    assert "ApplyInstantID" in class_types
    assert "IPAdapter" in class_types
    assert "SaveImage" in class_types
    _assert_links_resolve(g)


def test_model_chain_is_ipadapter_then_instantid_then_sampler() -> None:
    g = _client()._build_graph(  # type: ignore[attr-defined]  # noqa: SLF001
        prompt="x", negative_prompt="y", face_image="f.png", style_image="s.png",
        width=1024, height=1024, seed=1, instantid_weight=0.7, ipadapter_weight=0.8, steps=30,
    )
    # IPAdapter conditions the base model; InstantID consumes IPAdapter's output; sampler uses InstantID's.
    assert g["22"]["inputs"]["model"] == ["1", 0]
    assert g["8"]["inputs"]["model"] == ["22", 0]
    assert g["10"]["inputs"]["model"] == ["8", 0]
    # the two reference images feed the two branches
    assert g["5"]["inputs"]["image"] == "f.png"
    assert g["21"]["inputs"]["image"] == "s.png"
    # weights thread through
    assert g["8"]["inputs"]["weight"] == 0.7
    assert g["22"]["inputs"]["weight"] == 0.8


def test_cupcake_character_routes_to_gpu_slot(test_state) -> None:  # type: ignore[no-untyped-def]
    # Local-engine model (runs on the cupcake box, not a paid cloud). Never the api slot.
    assert test_state.determine_slot(CUPCAKE_CHARACTER_MODEL) == "gpu"
