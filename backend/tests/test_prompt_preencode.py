"""The 'stall at 15%' fix: local Gemma pre-encode before diffusion.

Post-fork, local Gemma-3-12B is the only text encoder. Left to the ltx pipeline
it ran mid-generate, wedged beside the staged 43GB transformer, got device-split
onto the CPU and ground for minutes-to-hours per prompt — every local generation
appeared to hang at progress 15. The fix encodes up front with the GPU free,
injects the embeddings (api_embeddings -> DummyTextEncoder path), and parks the
encoder on CPU.
"""

from __future__ import annotations

import torch

from state.app_state_types import TextEncodingResult


class FakeEncoder:
    """Stands in for the ltx_core Gemma encoder: forward() + to()."""

    def __init__(self) -> None:
        self.forward_calls: list[str] = []
        self.devices: list[str] = []

    def forward(self, text: str) -> tuple[torch.Tensor, torch.Tensor | None, torch.Tensor]:
        self.forward_calls.append(text)
        return (torch.ones(1, 3, 4096), torch.ones(1, 3, 512), torch.ones(1, 3))

    def to(self, device: torch.device) -> "FakeEncoder":
        self.devices.append(str(device))
        return self


class FakeLedger:
    def __init__(self, encoder: FakeEncoder) -> None:
        self._encoder = encoder
        self.text_encoder_calls = 0

    def text_encoder(self) -> FakeEncoder:
        self.text_encoder_calls += 1
        return self._encoder


class FakePipelineWithLedger:
    def __init__(self) -> None:
        self.model_ledger = FakeLedger(FakeEncoder())


def _install_local_encoder(test_state) -> None:
    # should_use_local_encoding keys off the text_encoder model dir on disk.
    te_dir = test_state.config.model_path("text_encoder")
    te_dir.mkdir(parents=True, exist_ok=True)
    (te_dir / "model.safetensors").write_bytes(b"\x00")


def _te_state(test_state):
    te = test_state.state.text_encoder
    assert te is not None, "conftest wires a text encoder state"
    return te


def test_preencode_injects_embeddings_and_runs_gemma_once(test_state):
    _install_local_encoder(test_state)
    pipeline = FakePipelineWithLedger()

    ok = test_state.text.precompute_local_embeddings(pipeline, "neon rooftop")

    assert ok is True
    encoder = pipeline.model_ledger._encoder
    assert encoder.forward_calls == ["neon rooftop"]
    injected = _te_state(test_state).api_embeddings
    assert injected is not None
    assert injected.video_context.shape[-1] == 4096


def test_preencode_encodes_on_cpu_without_moving_the_encoder_to_gpu(test_state):
    """The 24GB Gemma encoder must never be moved onto a 24GB card — it encodes
    in system RAM and only the small embeddings go to the GPU. (The old design
    moved it to the GPU then parked it back; even loaded alone it pinned the card
    at ~24GB and thrashed — the stall.)"""
    _install_local_encoder(test_state)
    pipeline = FakePipelineWithLedger()

    ok = test_state.text.precompute_local_embeddings(pipeline, "cpu encode")

    assert ok is True
    encoder = pipeline.model_ledger._encoder
    assert encoder.forward_calls == ["cpu encode"], "the encode must run"
    assert not any("cuda" in d for d in encoder.devices), (
        "the 12B encoder must stay on CPU — a 24GB encoder on a 24GB card thrashes"
    )
    assert _te_state(test_state).api_embeddings is not None
    # the CPU-encode flag is set only for the duration and reset afterwards
    assert getattr(test_state.state.text_encoder.service, "_cpu_encode", False) is False


def test_repeat_prompt_skips_gemma_via_the_cache(test_state):
    _install_local_encoder(test_state)
    pipeline = FakePipelineWithLedger()

    test_state.text.precompute_local_embeddings(pipeline, "same prompt")
    test_state.text.precompute_local_embeddings(pipeline, "same prompt")

    assert pipeline.model_ledger._encoder.forward_calls == ["same prompt"], (
        "a cached prompt must not re-run a 12B encode"
    )
    assert _te_state(test_state).api_embeddings is not None


def test_new_prompt_never_reuses_the_previous_injection(test_state):
    _install_local_encoder(test_state)
    pipeline = FakePipelineWithLedger()

    test_state.text.precompute_local_embeddings(pipeline, "prompt A")
    first = _te_state(test_state).api_embeddings

    # Break the ledger so a fresh encode CANNOT happen; the stale injection from
    # prompt A must be cleared rather than silently reused for prompt B.
    pipeline.model_ledger = None  # type: ignore[assignment]
    ok = test_state.text.precompute_local_embeddings(pipeline, "prompt B")

    assert ok is False
    assert _te_state(test_state).api_embeddings is not first
    assert _te_state(test_state).api_embeddings is None


def test_wrapped_pipeline_resolves_the_inner_ledger(test_state):
    """DD's real pipeline services hold the raw ltx pipeline at .pipeline —
    the first version of this fix missed that and silently fell back to the
    stalling in-pipeline path in production while its tests stayed green."""
    _install_local_encoder(test_state)

    class Wrapper:  # shaped like LTXFastVideoPipeline
        def __init__(self) -> None:
            self.pipeline = FakePipelineWithLedger()

    wrapper = Wrapper()
    ok = test_state.text.precompute_local_embeddings(wrapper, "wrapped prompt")

    assert ok is True
    assert wrapper.pipeline.model_ledger._encoder.forward_calls == ["wrapped prompt"]


def test_pipeline_without_ledger_falls_back_harmlessly(test_state):
    _install_local_encoder(test_state)

    class Bare:  # the Fake pipelines in the suite have no ledger
        pass

    assert test_state.text.precompute_local_embeddings(Bare(), "x") is False


def test_without_local_encoder_dir_it_declines(test_state):
    pipeline = FakePipelineWithLedger()
    assert test_state.text.precompute_local_embeddings(pipeline, "x") is False
    assert pipeline.model_ledger.text_encoder_calls == 0
