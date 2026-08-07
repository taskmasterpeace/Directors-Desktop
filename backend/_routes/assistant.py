"""Director's Pal assistant route — thin OpenRouter chat/tool-calling proxy.

The renderer runs the agent loop and owns the tools; this endpoint just forwards
one turn (messages + optional tool schemas) to OpenRouter with the server-side
key and returns the model's reply.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app_handler import AppHandler
from state import get_state_service

router = APIRouter(tags=["assistant"])


class AssistantChatRequest(BaseModel):
    messages: list[dict[str, Any]]
    tools: list[dict[str, Any]] | None = None
    model: str | None = None
    temperature: float = 0.4
    maxTokens: int = 1024


@router.post("/api/assistant/chat")
def assistant_chat(
    req: AssistantChatRequest,
    handler: AppHandler = Depends(get_state_service),
) -> dict[str, Any]:
    return handler.assistant.chat(
        req.messages,
        req.tools,
        model=req.model,
        temperature=req.temperature,
        max_tokens=req.maxTokens,
    )
