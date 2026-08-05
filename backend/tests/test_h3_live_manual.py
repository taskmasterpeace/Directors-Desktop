"""GATED live test: renders a real H3 clip through DD's GpuJobExecutor.

This exercises the FULL DD path — queue job -> _execute_h3_local -> the ComfyUI
engine -> copy into outputs_dir -> Gallery — not just the engine in isolation.
It needs ComfyUI + the H3 weights + a 24GB GPU, so it is SKIPPED unless H3_LIVE
is set (keeps CI fast and GPU-free). Run manually:

    H3_LIVE=1 uv run pytest tests/test_h3_live_manual.py -s
"""
import os
from pathlib import Path

import pytest

from handlers.job_executors import GpuJobExecutor


@pytest.mark.skipif(not os.environ.get("H3_LIVE"), reason="needs ComfyUI + H3 weights + GPU")
def test_h3_local_renders_through_the_executor(test_state) -> None:  # type: ignore[no-untyped-def]
    job = test_state.job_queue.submit(
        job_type="video",
        model="h3-local",
        params={
            "prompt": "a neon koi fish gliding through a dark aquarium, cinematic lighting",
            "resolution": "480p",
            "duration": "5",
            "aspectRatio": "16:9",
        },
        slot="gpu",
    )
    out = GpuJobExecutor(test_state)._execute_h3_local(job)  # noqa: SLF001
    assert len(out) == 1
    result = Path(out[0])
    assert result.exists(), f"no output at {result}"
    assert result.parent == test_state.config.outputs_dir, "result not in DD outputs_dir"
    assert result.stat().st_size > 10_000, "output suspiciously small"
