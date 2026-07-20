"""Route handlers for /api/director — music-video builds (clean-room Maestro)."""

from __future__ import annotations

from typing import cast

from fastapi import APIRouter, Depends

from api_types import (
    DirectorRunPayload,
    DirectorRunResponse,
    DirectorRunsResponse,
    DirectorSectionPayload,
    DirectorShotPayload,
    DirectorStartRequest,
    DirectorTargetRequest,
)
from app_handler import AppHandler
from state import get_state_service
from state.director_store import DirectorRun

router = APIRouter(prefix="/api/director", tags=["director"])


def _sections_payload(sections: object) -> list[DirectorSectionPayload] | None:
    if not isinstance(sections, list):
        return None
    out: list[DirectorSectionPayload] = []
    for item in cast("list[object]", sections):
        if not isinstance(item, dict):
            continue
        record = cast("dict[str, object]", item)
        start = record.get("start")
        end = record.get("end")
        label = record.get("label")
        if isinstance(start, (int, float)) and isinstance(end, (int, float)) and isinstance(label, str):
            out.append(DirectorSectionPayload(start=float(start), end=float(end), label=label))
    return out or None


def _to_payload(run: DirectorRun) -> DirectorRunPayload:
    analysis = run.analysis or {}
    tempo = analysis.get("tempo_bpm")
    duration = analysis.get("duration")
    sections_payload = _sections_payload(analysis.get("sections"))
    return DirectorRunPayload(
        id=run.id,
        phase=run.phase,
        error=run.error,
        audioPath=run.audio_path,
        concept=run.concept,
        model=run.model,
        resolution=run.resolution,
        createdAt=run.created_at,
        outputPath=run.output_path,
        tempoBpm=float(tempo) if isinstance(tempo, (int, float)) else None,
        songSeconds=float(duration) if isinstance(duration, (int, float)) else None,
        sectionCount=len(sections_payload) if sections_payload is not None else None,
        sections=sections_payload,
        shots=[
            DirectorShotPayload(
                index=s.index,
                start=s.start,
                end=s.end,
                sectionLabel=s.section_label,
                shotType=s.shot_type,
                prompt=s.prompt,
                generateSeconds=s.generate_seconds,
                status=s.status,
                error=s.error,
                resultPath=s.result_path,
                phase=s.phase,
                progress=s.progress,
            )
            for s in run.shots
        ],
    )


@router.post("/start", response_model=DirectorRunResponse)
def route_start_director_run(
    request: DirectorStartRequest,
    handler: AppHandler = Depends(get_state_service),
) -> DirectorRunResponse:
    run = handler.director.start(
        audio_path=request.audioPath,
        concept=request.concept,
        model=request.model,
        resolution=request.resolution,
        reference_image_paths=request.referenceImagePaths or None,
    )
    return DirectorRunResponse(run=_to_payload(run))


@router.get("/status", response_model=DirectorRunResponse)
def route_director_status(
    runId: str | None = None,
    handler: AppHandler = Depends(get_state_service),
) -> DirectorRunResponse:
    run = handler.director.status(runId)
    return DirectorRunResponse(run=_to_payload(run) if run else None)


@router.get("/runs", response_model=DirectorRunsResponse)
def route_director_runs(
    handler: AppHandler = Depends(get_state_service),
) -> DirectorRunsResponse:
    return DirectorRunsResponse(runs=[_to_payload(r) for r in handler.director.all_runs()])


@router.post("/cancel", response_model=DirectorRunResponse)
def route_cancel_director_run(
    request: DirectorTargetRequest,
    handler: AppHandler = Depends(get_state_service),
) -> DirectorRunResponse:
    return DirectorRunResponse(run=_to_payload(handler.director.cancel(request.runId)))


@router.post("/resume", response_model=DirectorRunResponse)
def route_resume_director_run(
    request: DirectorTargetRequest,
    handler: AppHandler = Depends(get_state_service),
) -> DirectorRunResponse:
    return DirectorRunResponse(run=_to_payload(handler.director.resume(request.runId)))
