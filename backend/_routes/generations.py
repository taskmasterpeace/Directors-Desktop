"""Agent-native generations API — see every prompt + generation (anything a user sees)."""

from __future__ import annotations

from typing import Any, cast

from fastapi import APIRouter, Depends

from api_types import GenerationRecord, GenerationsResponse
from state import get_state_service
from app_handler import AppHandler

router = APIRouter(prefix="/api", tags=["generations"])


def _str_list(value: object) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in cast("list[Any]", value)]
    return []


@router.get("/generations", response_model=GenerationsResponse)
def route_generations(
    handler: AppHandler = Depends(get_state_service),
) -> GenerationsResponse:
    records: list[GenerationRecord] = []
    for job in handler.job_queue.get_all_jobs():
        params = job.params
        records.append(
            GenerationRecord(
                id=job.id,
                type=job.type,
                model=job.model,
                prompt=str(params.get("prompt", "")),
                status=job.status,
                result_paths=list(job.result_paths),
                reference_image_paths=_str_list(params.get("referenceImagePaths")),
                audio_reference_paths=_str_list(params.get("audioReferencePaths")),
                created_at=job.created_at,
            )
        )
    return GenerationsResponse(generations=records)
