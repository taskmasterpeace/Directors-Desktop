"""Text encoder patching and API embedding service."""

from __future__ import annotations

import logging
import pickle
import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, cast

import torch

from services.http_client.http_client import HTTPClient
from services.services_utils import PromptInput, TensorOrNone, sync_device
from state.app_state_types import CachedTextEncoder, TextEncodingResult

if TYPE_CHECKING:
    from state.app_state_types import AppState

logger = logging.getLogger(__name__)


class LTXTextEncoder:
    """Stateless text encoding operations with idempotent monkey-patching."""

    def __init__(self, device: torch.device, http: HTTPClient, ltx_api_base_url: str) -> None:
        self.device = device
        self.http = http
        self.ltx_api_base_url = ltx_api_base_url
        self._model_ledger_patched = False
        self._encode_text_patched = False
        # When True, the patched loader keeps the 12B Gemma encoder in system RAM
        # (no fp8, no move to GPU) so the caller can encode on CPU — the only way
        # a 24GB encoder doesn't thrash a 24GB card. Set around a CPU pre-encode.
        self._cpu_encode = False

    def install_patches(self, state_getter: Callable[[], AppState]) -> None:
        self._install_model_ledger_patch(state_getter)
        self._install_encode_text_patch(state_getter)

    def _build_fp8_text_encoder(self, ledger: object, original: Callable[..., object]) -> object:
        """Build Gemma with the ledger's fp8 quantization applied, mirroring
        ModelLedger.transformer(). The stock text_encoder() skips this, so on a
        24GB card the 24GB bf16 encoder loads full and thrashes; applying the
        fp8 policy shrinks it to ~13GB so it fits. Falls back to the plain
        encoder if there's no quantization policy or anything goes wrong."""
        quant = getattr(ledger, "quantization", None)
        builder = getattr(ledger, "text_encoder_builder", None)
        if quant is None or builder is None:
            return original(ledger)
        try:
            from dataclasses import replace as _dc_replace
            from ltx_core.loader.sd_ops import SDOps as _SDOps  # pyright: ignore[reportMissingImports]

            sd_ops = builder.model_sd_ops
            quant_sd_ops = getattr(quant, "sd_ops", None)
            if quant_sd_ops is not None:
                sd_ops = _SDOps(
                    name=f"te_fp8_{sd_ops.name}",
                    mapping=(*sd_ops.mapping, *quant_sd_ops.mapping),
                )
            fp8_builder = _dc_replace(
                builder,
                module_ops=(*builder.module_ops, *quant.module_ops),
                model_sd_ops=sd_ops,
            )
            target_device = ledger._target_device()  # type: ignore[attr-defined]  # noqa: SLF001
            return fp8_builder.build(device=target_device).eval()
        except Exception:
            logger.warning("fp8 text-encoder build failed; using full-precision encoder", exc_info=True)
            return original(ledger)

    def _install_model_ledger_patch(self, state_getter: Callable[[], AppState]) -> None:
        if self._model_ledger_patched:
            return

        try:
            from ltx_pipelines.utils import ModelLedger
            from ltx_pipelines.utils import helpers as ltx_utils

            original_text_encoder = ModelLedger.text_encoder
            original_cleanup_memory = ltx_utils.cleanup_memory

            def patched_text_encoder(self_model_ledger: ModelLedger) -> object:
                state = state_getter()
                te_state = state.text_encoder
                if te_state is None:
                    return original_text_encoder(self_model_ledger)

                if te_state.api_embeddings is not None:
                    return DummyTextEncoder()

                if te_state.cached_encoder is not None:
                    if not self._cpu_encode:
                        try:
                            te_state.cached_encoder.to(self.device)
                            sync_device(self.device)
                        except Exception:
                            logger.warning("Failed to move cached text encoder to %s", self.device, exc_info=True)
                    return te_state.cached_encoder

                # Load Gemma with the SAME fp8 quantization the transformer uses.
                # ModelLedger.transformer() appends ledger.quantization's
                # module_ops (fp8_cast -> UPCAST_DURING_INFERENCE) + sd_ops at
                # build; the stock text_encoder() does NOT, so the 24GB bf16 Gemma
                # loads at full size and thrashes a 24GB card (the "stall at 15%").
                # Applying the same policy here loads Gemma as fp8 (~13GB) -> fits.
                encoder = self._build_fp8_text_encoder(self_model_ledger, original_text_encoder)
                te_state.cached_encoder = cast(CachedTextEncoder, encoder)
                te_state.cached_encoder.to(self.device)
                sync_device(self.device)
                return te_state.cached_encoder

            def patched_cleanup_memory() -> None:
                state = state_getter()
                te_state = state.text_encoder
                if te_state is not None and te_state.cached_encoder is not None:
                    try:
                        te_state.cached_encoder.to(torch.device("cpu"))
                    except Exception:
                        logger.warning("Failed to move cached text encoder to CPU", exc_info=True)
                original_cleanup_memory()

            setattr(ModelLedger, "text_encoder", patched_text_encoder)

            for module_name in (
                "ltx_pipelines.utils.helpers",
                "ltx_pipelines.distilled",
                "ltx_pipelines.ti2vid_one_stage",
                "ltx_pipelines.ti2vid_two_stages",
                "ltx_pipelines.ic_lora",
                "ltx_pipelines.a2vid_two_stage",
                "ltx_pipelines.retake",
                "ltx_pipelines.retake_pipeline",
            ):
                try:
                    module = __import__(module_name, fromlist=["cleanup_memory"])
                    if hasattr(module, "cleanup_memory"):
                        setattr(module, "cleanup_memory", patched_cleanup_memory)
                except Exception:
                    logger.warning("Failed to patch cleanup_memory for module %s", module_name, exc_info=True)

            self._model_ledger_patched = True
            logger.info("Installed ModelLedger text encoder patch")
        except Exception as exc:
            logger.warning("Failed to patch ModelLedger: %s", exc, exc_info=True)

    def _install_encode_text_patch(self, state_getter: Callable[[], AppState]) -> None:
        if self._encode_text_patched:
            return

        try:
            from ltx_core.text_encoders import gemma as text_enc_module
            from ltx_pipelines import distilled as distilled_module

            original_encode_text = text_enc_module.encode_text

            def patched_encode_text(
                text_encoder: object,
                prompts: PromptInput,
                *args: object,
                **kwargs: object,
            ) -> list[tuple[torch.Tensor, TensorOrNone]]:
                state = state_getter()
                te_state = state.text_encoder
                if te_state is not None and te_state.api_embeddings is not None:
                    video_context = te_state.api_embeddings.video_context
                    audio_context = te_state.api_embeddings.audio_context
                    num_prompts = len(prompts) if not isinstance(prompts, str) else 1
                    out: list[tuple[torch.Tensor, TensorOrNone]] = []
                    for i in range(num_prompts):
                        if i == 0:
                            out.append((video_context, audio_context))
                        else:
                            zero_video = torch.zeros_like(video_context)
                            zero_audio = torch.zeros_like(audio_context) if audio_context is not None else None
                            out.append((zero_video, zero_audio))
                    return out

                prompt_list = [prompts] if isinstance(prompts, str) else list(prompts)
                return cast(
                    list[tuple[torch.Tensor, TensorOrNone]],
                    original_encode_text(cast(Any, text_encoder), prompt_list, *args, **kwargs),
                )

            setattr(text_enc_module, "encode_text", patched_encode_text)
            setattr(distilled_module, "encode_text", patched_encode_text)

            for module_name in (
                "ltx_pipelines.ti2vid_one_stage",
                "ltx_pipelines.ti2vid_two_stages",
                "ltx_pipelines.ic_lora",
                "ltx_pipelines.a2vid_two_stage",
                "ltx_pipelines.retake",
                "ltx_pipelines.retake_pipeline",
            ):
                try:
                    module = __import__(module_name, fromlist=["encode_text"])
                    setattr(module, "encode_text", patched_encode_text)
                except Exception:
                    logger.warning("Failed to patch encode_text for module %s", module_name, exc_info=True)

            self._encode_text_patched = True
            logger.info("Installed encode_text API embeddings patch")
        except Exception as exc:
            logger.warning("Failed to patch encode_text: %s", exc, exc_info=True)

    def get_model_id_from_checkpoint(self, checkpoint_path: str) -> str | None:
        try:
            from safetensors import safe_open

            with safe_open(checkpoint_path, framework="pt", device="cpu") as f:
                metadata = f.metadata()
                if metadata and "encrypted_wandb_properties" in metadata:
                    return metadata["encrypted_wandb_properties"]
        except Exception as exc:
            logger.warning("Could not extract model_id from checkpoint: %s", exc, exc_info=True)
        return None

    def encode_via_api(self, prompt: str, api_key: str, checkpoint_path: str, enhance_prompt: bool) -> TextEncodingResult | None:
        # Directors Desktop policy: never send prompts (or anything else) to the
        # LTX cloud API. Text encoding must use the local encoder — download it
        # via Settings if missing.
        _ = api_key, checkpoint_path, enhance_prompt
        logger.error(
            "LTX cloud prompt-embedding is disabled by policy; download the local "
            "text encoder to generate. Prompt was NOT sent anywhere. (prompt length=%d)",
            len(prompt),
        )
        return None

    def _encode_via_api_disabled(self, prompt: str, api_key: str, checkpoint_path: str, enhance_prompt: bool) -> TextEncodingResult | None:
        model_id = self.get_model_id_from_checkpoint(checkpoint_path)
        if not model_id:
            return None

        try:
            start = time.time()
            response = self.http.post(
                f"{self.ltx_api_base_url}/v1/prompt-embedding",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json_payload={
                    "prompt": prompt,
                    "model_id": model_id,
                    "enhance_prompt": enhance_prompt,
                },
                timeout=60,
            )

            if response.status_code != 200:
                logger.warning("LTX API error %s: %s", response.status_code, response.text)
                return None

            conditioning = pickle.loads(response.content)  # noqa: S301
            if not conditioning or len(conditioning) == 0:
                logger.warning("LTX API returned unexpected conditioning format")
                return None

            embeddings = conditioning[0][0]
            video_dim = 4096
            if embeddings.shape[-1] > video_dim:
                video_context = embeddings[..., :video_dim].contiguous().to(dtype=torch.bfloat16, device=self.device)
                audio_context = embeddings[..., video_dim:].contiguous().to(dtype=torch.bfloat16, device=self.device)
            else:
                video_context = embeddings.contiguous().to(dtype=torch.bfloat16, device=self.device)
                audio_context = None

            logger.info("Text encoded via API in %.1fs", time.time() - start)
            return TextEncodingResult(video_context=video_context, audio_context=audio_context)

        except Exception as exc:
            logger.warning("LTX API encoding failed: %s", exc, exc_info=True)
            return None


class DummyTextEncoder:
    pass
