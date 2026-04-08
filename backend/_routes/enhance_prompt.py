"""Prompt enhancement route."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from api_types import CaptionImageRequest, CaptionImageResponse
from app_handler import AppHandler
from state import get_state_service

router = APIRouter(tags=["enhance"])


class EnhancePromptRequest(BaseModel):
    prompt: str = ""
    mode: str = "text-to-video"
    model: str = "ltx-fast"
    imagePath: str | None = None


@router.post("/api/enhance-prompt")
def enhance_prompt(
    req: EnhancePromptRequest,
    handler: AppHandler = Depends(get_state_service),
):
    return handler.enhance_prompt.enhance(
        req.prompt, req.mode, req.model, image_path=req.imagePath,
    )


@router.post("/api/caption-image", response_model=CaptionImageResponse)
def caption_image(
    req: CaptionImageRequest,
    handler: AppHandler = Depends(get_state_service),
) -> CaptionImageResponse:
    prompt = handler.enhance_prompt.caption_image_for_video(
        image_path=req.imagePath,
        target_model=req.targetModel,
    )
    return CaptionImageResponse(prompt=prompt)
