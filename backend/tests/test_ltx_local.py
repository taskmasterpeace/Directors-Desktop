"""Tests for the local LTX-2.3 (ComfyUI) engine wiring (no ComfyUI/GPU required).

Covers the pure spec helpers, the official-blueprint node graph's shape, and that
the model routes to the local gpu slot (never api). These validate STRUCTURE only
— a real ComfyUI render is what gates the engine being offered in the UI.
"""
from pathlib import Path

from services.ltx_comfy_client import (
    LTX_COMFY_MODEL,
    LTX_DISTILLED_LORA,
    ComfyLTXClientImpl,
    ltx_dimensions,
    ltx_snap_frames,
)


def test_snap_frames_lands_on_the_8k_plus_1_grid() -> None:
    # LTX temporal VAE compression is 8x -> EmptyLTXVLatentVideo length must be 8k+1.
    for secs in (0.5, 1, 2, 4, 5, 7, 10, 12, 15):
        n = ltx_snap_frames(secs)
        assert (n - 1) % 8 == 0, f"{secs}s -> {n} is not 8k+1"
    assert ltx_snap_frames(0.01) >= 9  # never degenerate
    assert ltx_snap_frames(5) == 113
    assert ltx_snap_frames(15) == 353


def test_dimensions_are_32_aligned_landscape_portrait_and_fallback() -> None:
    for res in ("480p", "720p"):
        for aspect in ("16:9", "9:16"):
            w, h = ltx_dimensions(res, aspect)
            assert w % 32 == 0 and h % 32 == 0, f"{res}/{aspect} -> {w}x{h} not /32"
    assert ltx_dimensions("480p", "16:9") == (832, 480)
    assert ltx_dimensions("480p", "9:16") == (480, 832)
    assert ltx_dimensions("720p", "16:9") == (1280, 704)
    assert ltx_dimensions("720p", "9:16") == (704, 1280)
    # unknown tier falls back to 480p rather than crashing
    assert ltx_dimensions("banana", "16:9") == (832, 480)


def _assert_links_resolve(graph: dict[str, object]) -> None:
    """Every [node_id, slot] reference must point at a node that exists."""
    for node in graph.values():
        inputs = node["inputs"] if isinstance(node, dict) else {}
        for value in inputs.values():
            if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
                assert value[0] in graph, f"dangling link to node {value[0]!r}"


def test_t2v_graph_has_distilled_lora_and_save_and_no_image_node() -> None:
    client = ComfyLTXClientImpl(comfy_dir=Path("."))
    g = client._build_graph(  # type: ignore[attr-defined]  # noqa: SLF001
        prompt="a cat", negative_prompt="", width=832, height=480, frames=113,
        reference_image_path=None, lora_name=None, lora_strength=1.0, seed=7,
    )
    class_types = {n["class_type"] for n in g.values()}
    assert "CheckpointLoaderSimple" in class_types
    assert "LTXAVTextEncoderLoader" in class_types
    assert "SaveVideo" in class_types
    # distilled speed LoRA always applied
    assert g["4"]["class_type"] == "LoraLoaderModelOnly"
    assert g["4"]["inputs"]["lora_name"] == LTX_DISTILLED_LORA
    # T2V: no image-conditioning nodes
    assert "LoadImage" not in class_types
    assert g["8"]["inputs"]["length"] == 113
    _assert_links_resolve(g)


def test_i2v_graph_adds_image_conditioning_and_extra_lora_stacks() -> None:
    client = ComfyLTXClientImpl(comfy_dir=Path("."))
    g = client._build_graph(  # type: ignore[attr-defined]  # noqa: SLF001
        prompt="a cat", negative_prompt="ugly", width=832, height=480, frames=113,
        reference_image_path="C:/a/ref.png", lora_name="my-style.safetensors",
        lora_strength=0.8, seed=3,
    )
    class_types = {n["class_type"] for n in g.values()}
    assert "LoadImage" in class_types
    assert "LTXVImgToVideoInplace" in class_types
    # extra LoRA stacks on top of the distilled one
    assert g["4b"]["inputs"]["lora_name"] == "my-style.safetensors"
    assert g["4b"]["inputs"]["strength_model"] == 0.8
    # the guider consumes the stacked (second) LoRA's model output
    assert g["14"]["inputs"]["model"] == ["4b", 0]
    _assert_links_resolve(g)


def test_ltx_comfy_routes_to_gpu_slot(test_state) -> None:  # type: ignore[no-untyped-def]
    # Local engine: free, user's GPU. Never the api slot.
    assert test_state.determine_slot(LTX_COMFY_MODEL) == "gpu"
