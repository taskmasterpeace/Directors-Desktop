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


class EnhanceOptionsRequest(BaseModel):
    prompt: str = ""
    model: str = "h3-local"
    # Absent = phase 1 (analyze -> direction question); set = phase 2 (variants).
    direction: str | None = None


@router.post("/api/enhance-prompt/options")
def enhance_prompt_options(
    req: EnhanceOptionsRequest,
    handler: AppHandler = Depends(get_state_service),
):
    """Director's enhance: analyze -> pick a direction -> 4 visible choices."""
    return handler.enhance_prompt.enhance_options(
        req.prompt, req.model, direction=req.direction,
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
