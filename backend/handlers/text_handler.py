"""Text encoding cache and API embedding handler."""

from __future__ import annotations

import logging
from threading import RLock
from typing import TYPE_CHECKING

from handlers.base import StateHandlerBase, with_state_lock
from state.app_state_types import AppState, TextEncodingResult

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from runtime_config.runtime_config import RuntimeConfig


class TextHandler(StateHandlerBase):
    def __init__(self, state: AppState, lock: RLock, config: RuntimeConfig) -> None:
        super().__init__(state, lock)
        self._config = config

    @with_state_lock
    def _get_cached_prompt(self, prompt: str, enhance_prompt: bool) -> TextEncodingResult | None:
        te = self.state.text_encoder
        if te is None:
            return None
        return te.prompt_cache.get((prompt.strip(), enhance_prompt))

    @with_state_lock
    def _cache_prompt(self, prompt: str, enhance_prompt: bool, result: TextEncodingResult) -> None:
        te = self.state.text_encoder
        if te is None:
            return

        max_size = self.state.app_settings.prompt_cache_size
        if max_size <= 0:
            return

        key = (prompt.strip(), enhance_prompt)
        if key in te.prompt_cache:
            del te.prompt_cache[key]
        elif len(te.prompt_cache) >= max_size:
            oldest = next(iter(te.prompt_cache))
            del te.prompt_cache[oldest]
        te.prompt_cache[key] = result

    @with_state_lock
    def _set_api_embeddings(self, result: TextEncodingResult | None) -> None:
        if self.state.text_encoder is not None:
            self.state.text_encoder.api_embeddings = result

    def clear_api_embeddings(self) -> None:
        self._set_api_embeddings(None)

    def should_use_local_encoding(self) -> bool:
        """Whether local text encoding is used.

        LTX cloud text encoding is permanently disabled fork-wide, so local is
        the ONLY encoder — a stored ``ltx_api_key`` is never a valid provider.
        (This must stay independent of the persisted ``use_local_text_encoder``
        tiebreaker: an upgrader's settings.json can carry ``false`` from the old
        API-encoder default, and honoring it would route to the dead API.)
        """
        text_encoder_dir = self._config.model_path("text_encoder")
        return text_encoder_dir.exists() and any(text_encoder_dir.iterdir())

    def precompute_local_embeddings(self, pipeline: object, prompt: str) -> bool:
        """Encode the prompt with the local Gemma encoder BEFORE diffusion runs.

        Post-fork, local Gemma-3-12B is the ONLY text encoder (LTX cloud encoding
        is policy-dead). Letting the ltx pipeline invoke it mid-``generate()``
        wedged a 12B model beside the staged 43GB transformer — it got device-split
        onto the CPU, ground one core for minutes-to-hours per prompt, and surfaced
        as the notorious "stall at 15%" (diagnosed by stack dump, 2026-08-04).

        Doing the encode here — with the GPU to ourselves, then parking the
        encoder back on CPU and injecting the embeddings — turns it into a
        seconds-long one-off. The pipeline then sees ``api_embeddings`` and uses
        its DummyTextEncoder path, so Gemma never runs during diffusion. Repeat
        prompts skip Gemma entirely via the prompt cache.

        Returns True when embeddings were injected; False falls back to the old
        in-pipeline path (e.g. fakes without a ledger), which is no worse than
        the status quo.
        """
        if not self.should_use_local_encoding():
            return False

        # A stale injection from a previous prompt must never leak into this run.
        self.clear_api_embeddings()

        cached = self._get_cached_prompt(prompt, False)
        if cached is not None:
            self._set_api_embeddings(cached)
            return True

        # DD's pipeline services (LTXFastVideoPipeline / NF4 / GGUF / A2V) wrap the
        # raw ltx pipeline at .pipeline; the ledger lives on the inner object.
        # Resolve through either shape so both wrappers and raw pipelines work.
        inner = getattr(pipeline, "pipeline", pipeline)
        ledger = getattr(inner, "model_ledger", None) or getattr(pipeline, "model_ledger", None)
        if ledger is None or not hasattr(ledger, "text_encoder"):
            logger.info("No model ledger on %s — in-pipeline text encoding will be used", type(pipeline).__name__)
            return False

        import torch

        te = self.state.text_encoder
        try:
            encoder = ledger.text_encoder()
            try:
                output = encoder.forward(prompt)
            except torch.cuda.OutOfMemoryError:
                # One retry after a cache flush; if VRAM is genuinely gone, fall
                # back rather than wedging the job.
                torch.cuda.empty_cache()
                output = encoder.forward(prompt)
            video_context = output[0]
            audio_context = output[1]
            result = TextEncodingResult(
                video_context=video_context.detach(),
                audio_context=audio_context.detach() if audio_context is not None else None,
            )
        except Exception:
            logger.warning(
                "Local prompt pre-encode failed; falling back to in-pipeline encoding",
                exc_info=True,
            )
            return False
        finally:
            # Park the encoder off the GPU so diffusion gets the whole card.
            try:
                if te is not None and te.cached_encoder is not None:
                    te.cached_encoder.to(torch.device("cpu"))
                torch.cuda.empty_cache()
            except Exception:
                logger.warning("Failed to park the text encoder on CPU", exc_info=True)

        self._cache_prompt(prompt, False, result)
        self._set_api_embeddings(result)
        return True

    def prepare_text_encoding(self, prompt: str, enhance_prompt: bool) -> None:
        """Validate settings and prepare text embeddings for a generation run.

        LTX cloud text encoding is disabled fork-wide, so the local encoder is
        the only option and must be present. Raises a prefixed RuntimeError if
        it isn't.
        """
        text_encoder_dir = self._config.model_path("text_encoder")
        local_available = text_encoder_dir.exists() and any(text_encoder_dir.iterdir())

        if not local_available:
            raise RuntimeError(
                "TEXT_ENCODER_NOT_DOWNLOADED: To generate videos, download the Local Text "
                "Encoder in Settings."
            )

        # Clears any stale API embeddings so generation uses the local encoder path.
        self._prepare_api_embeddings(prompt, enhance_prompt)

        if self.resolve_gemma_root() is None:
            raise RuntimeError(
                "TEXT_ENCODER_NOT_DOWNLOADED: The Local Text Encoder is required but could "
                "not be resolved. Re-download it in Settings."
            )

    def resolve_gemma_root(self) -> str | None:
        if not self.should_use_local_encoding():
            return None
        settings = self.state.app_settings.model_copy(deep=True)
        if settings.use_abliterated_text_encoder:
            abliterated_dir = self._config.model_path("text_encoder_abliterated")
            if abliterated_dir.exists() and any(abliterated_dir.iterdir()):
                return str(abliterated_dir)
        text_encoder_dir = self._config.model_path("text_encoder")
        return str(text_encoder_dir)

    def _prepare_api_embeddings(self, prompt: str, enhance_prompt: bool) -> TextEncodingResult | None:
        if self.should_use_local_encoding():
            self.clear_api_embeddings()
            return None

        settings = self.state.app_settings.model_copy(deep=True)
        if not settings.ltx_api_key:
            self.clear_api_embeddings()
            return None

        cached = self._get_cached_prompt(prompt, enhance_prompt)
        if cached is not None:
            self._set_api_embeddings(cached)
            return cached

        te = self.state.text_encoder
        if te is None:
            return None

        encoded = te.service.encode_via_api(
            prompt=prompt,
            api_key=settings.ltx_api_key,
            checkpoint_path=str(self._config.model_path("checkpoint")),
            enhance_prompt=enhance_prompt,
        )
        if encoded is not None:
            self._cache_prompt(prompt, enhance_prompt, encoded)
            self._set_api_embeddings(encoded)
        return encoded
