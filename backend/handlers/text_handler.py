"""Text encoding cache and API embedding handler."""

from __future__ import annotations

from threading import RLock
from typing import TYPE_CHECKING

from handlers.base import StateHandlerBase, with_state_lock
from state.app_state_types import AppState, TextEncodingResult

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
