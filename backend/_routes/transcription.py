"""Route for POST /api/transcribe (word-level transcription)."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from api_types import (
    TranscribeRequest,
    TranscribeResponse,
    TranscriptToPromptRequest,
    TranscriptToPromptResponse,
)
from state import get_state_service
from app_handler import AppHandler

router = APIRouter(prefix="/api", tags=["transcription"])


@router.post("/transcribe", response_model=TranscribeResponse)
def route_transcribe(
    req: TranscribeRequest,
    handler: AppHandler = Depends(get_state_service),
) -> TranscribeResponse:
    return handler.transcription.transcribe(req)


@router.post("/transcript/to-prompt", response_model=TranscriptToPromptResponse)
def route_transcript_to_prompt(
    req: TranscriptToPromptRequest,
    handler: AppHandler = Depends(get_state_service),
) -> TranscriptToPromptResponse:
    result = handler.enhance_prompt.transcript_to_prompt(
        req.text,
        req.targetModel,
        full_story=req.fullStory,
        story_aware=req.storyAware,
        media_type=req.mediaType,
        mode=req.mode,
        lyrics=req.lyrics,
    )
    return TranscriptToPromptResponse(prompt=result.get("enhancedPrompt", ""))
