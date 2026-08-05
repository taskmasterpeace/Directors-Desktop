"""GATED live test: renders a real LTX-2.3 clip through DD's GpuJobExecutor.

Exercises the FULL DD backend path — queue job -> GpuJobExecutor.execute dispatch
-> _execute_ltx_local -> the ComfyUI engine -> copy into outputs_dir -> Gallery —
not just the engine in isolation. Needs ComfyUI + the LTX nvfp4 checkpoint + a
24GB GPU, so it is SKIPPED unless LTX_LIVE is set. Run manually:

    LTX_LIVE=1 uv run pytest tests/test_ltx_live_manual.py -s
"""
import os
from pathlib import Path

import pytest

from handlers.job_executors import GpuJobExecutor


@pytest.mark.skipif(not os.environ.get("LTX_LIVE"), reason="needs ComfyUI + LTX nvfp4 + GPU")
def test_ltx_local_renders_through_the_executor(test_state) -> None:  # type: ignore[no-untyped-def]
    job = test_state.job_queue.submit(
        job_type="video",
        model="ltx-comfy",
        params={
            "prompt": "a lone lighthouse on a cliff at dusk, waves crashing, cinematic",
            "resolution": "480p",
            "duration": "2",
            "aspectRatio": "16:9",
        },
        slot="gpu",
    )
    # Full public dispatch (proves model=='ltx-comfy' routes to _execute_ltx_local).
    out = GpuJobExecutor(test_state).execute(job)
    assert len(out) == 1
    result = Path(out[0])
    assert result.exists(), f"no output at {result}"
    assert result.parent == test_state.config.outputs_dir, "result not in DD outputs_dir"
    assert result.stat().st_size > 10_000, "output suspiciously small"


@pytest.mark.skipif(not os.environ.get("LTX_LIVE"), reason="needs ComfyUI + LTX nvfp4 + GPU")
def test_ltx_local_object_removal_lora_renders_through_the_executor(test_state) -> None:  # type: ignore[no-untyped-def]
    job = test_state.job_queue.submit(
        job_type="video",
        model="ltx-comfy",
        params={
            "prompt": "an empty park bench by a lake, calm, remove the people",
            "resolution": "480p",
            "duration": "2",
            "aspectRatio": "16:9",
            # The object-removal LoRA, exactly as the picker submits it.
            "modelParams": {"ltxLora": "ltx-2.3-inpaint-remover.safetensors", "ltxLoraStrength": 0.9},
        },
        slot="gpu",
    )
    out = GpuJobExecutor(test_state).execute(job)
    assert len(out) == 1
    result = Path(out[0])
    assert result.exists(), f"no output at {result}"
    assert result.parent == test_state.config.outputs_dir, "result not in DD outputs_dir"
    assert result.stat().st_size > 10_000, "output suspiciously small"
