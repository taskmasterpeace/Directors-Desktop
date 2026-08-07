"""Director's Pal — a thin OpenRouter chat/tool-calling proxy.

The agent LOOP runs in the renderer, which owns the tool implementations (queue,
project/agent-bridge actions, perception via frame-extract + caption). This
handler only forwards ONE messages+tools chat turn to OpenRouter using the
server-side key and returns the model's reply (content + any tool_calls) — so
the key never reaches the renderer, and Director's Pal can drive the whole app
without a second LLM integration.
"""
from __future__ import annotations

import logging
from threading import RLock
from typing import Any, cast

from _routes._errors import HTTPError
from handlers.base import StateHandlerBase
from services.interfaces import HTTPClient, HttpTimeoutError
from state.app_state_types import AppState

logger = logging.getLogger(__name__)

# Multimodal + supports tool-calling; same id the prompt enhancer settled on
# (the older gemini-2.0-flash id was de-listed from OpenRouter).
ASSISTANT_MODEL = "google/gemini-2.5-flash"


class AssistantHandler(StateHandlerBase):
    def __init__(self, state: AppState, lock: RLock, http: HTTPClient) -> None:
        super().__init__(state, lock)
        self._http = http

    def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        *,
        model: str | None = None,
        temperature: float = 0.4,
        max_tokens: int = 1024,
    ) -> dict[str, Any]:
        """Run ONE tool-calling turn against OpenRouter.

        Returns ``{"message": <assistant message>, "finish_reason": str|None}``
        where the message carries ``content`` and, when the model wants to act,
        ``tool_calls`` — which the renderer executes and feeds back on the next
        turn.
        """
        api_key = self.state.app_settings.openrouter_api_key.strip()
        if not api_key:
            raise HTTPError(
                400,
                "OPENROUTER_API_KEY_REQUIRED: Director's Pal needs an OpenRouter key. "
                "Add one in Settings → API Keys.",
            )

        payload: dict[str, Any] = {
            "model": model or ASSISTANT_MODEL,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        try:
            response = self._http.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_key}",
                },
                json_payload=payload,
                timeout=60,
            )
        except HttpTimeoutError as exc:
            raise HTTPError(504, "Director's Pal timed out talking to OpenRouter") from exc
        except Exception as exc:  # noqa: BLE001 — surface any transport error as 500
            raise HTTPError(500, str(exc)) from exc

        if response.status_code != 200:
            raise HTTPError(response.status_code, f"OpenRouter error: {response.text}")

        raw: object = response.json()
        if not isinstance(raw, dict):
            raise HTTPError(500, "OPENROUTER_PARSE_ERROR")
        data = cast("dict[str, Any]", raw)
        choices_raw = data.get("choices")
        if not isinstance(choices_raw, list) or not choices_raw:
            raise HTTPError(500, "OPENROUTER_PARSE_ERROR")
        choices = cast("list[Any]", choices_raw)
        first: Any = choices[0]
        if not isinstance(first, dict):
            raise HTTPError(500, "OPENROUTER_PARSE_ERROR")
        choice = cast("dict[str, Any]", first)
        message = choice.get("message")
        if not isinstance(message, dict):
            raise HTTPError(500, "OPENROUTER_PARSE_ERROR")
        finish_reason = choice.get("finish_reason")
        return {
            "message": cast("dict[str, Any]", message),
            "finish_reason": finish_reason if isinstance(finish_reason, str) else None,
        }
