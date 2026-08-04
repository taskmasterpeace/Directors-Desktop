"""Route handlers for /api/director — music-video builds (clean-room Maestro)."""

from __future__ import annotations

from typing import cast

from fastapi import APIRouter, Depends

from api_types import (
    DirectorApproveRequest,
    DirectorPlanApproveRequest,
    DirectorRerollRequest,
    DirectorStylePayload,
    DirectorStylesResponse,
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


def _beats_payload(beats: object) -> list[float] | None:
    if not isinstance(beats, list):
        return None
    out = [float(b) for b in cast("list[object]", beats) if isinstance(b, (int, float))]
    return out or None


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
            energy = record.get("energy")
            out.append(
                DirectorSectionPayload(
                    start=float(start),
                    end=float(end),
                    label=label,
                    energy=float(energy) if isinstance(energy, (int, float)) else 0.0,
                )
            )
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
        storyboard=run.storyboard,
        approval=run.approval,
        treatment=run.treatment,
        artistName=run.artist_name,
        directorStyle=run.director_style,
        wardrobe=list(run.wardrobe),
        planReview=run.plan_review,
        aspect=run.aspect,
        beats=_beats_payload(analysis.get("beats")),
        lyricsWordCount=(
            sum(len(str(line.get("text", "")).split()) for line in run.lyrics if isinstance(line, dict))
            if run.lyrics is not None
            else None
        ),
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
                keyframePath=s.keyframe_path,
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
        treatment=request.treatment,
        artist_name=request.artistName,
        storyboard=request.storyboard,
        approval=request.approval,
        image_model=request.imageModel,
        director_style=request.directorStyle,
        wardrobe=request.wardrobe or None,
        plan_review=request.planReview,
        aspect=request.aspect,
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


@router.get("/styles", response_model=DirectorStylesResponse)
def route_director_styles() -> DirectorStylesResponse:
    from server_utils.director_styles import DIRECTOR_STYLES

    return DirectorStylesResponse(
        styles=[
            DirectorStylePayload(
                id=s.id, name=s.name, description=s.description, wardrobe=list(s.wardrobe)
            )
            for s in DIRECTOR_STYLES.values()
        ]
    )


@router.post("/plan/approve", response_model=DirectorRunResponse)
def route_approve_plan(
    request: DirectorPlanApproveRequest,
    handler: AppHandler = Depends(get_state_service),
) -> DirectorRunResponse:
    run = handler.director.approve_plan(request.runId, prompts=request.prompts or None)
    return DirectorRunResponse(run=_to_payload(run))


@router.post("/reroll", response_model=DirectorRunResponse)
def route_reroll_shots(
    request: DirectorRerollRequest,
    handler: AppHandler = Depends(get_state_service),
) -> DirectorRunResponse:
    run = handler.director.reroll_shots(request.runId, request.indices)
    return DirectorRunResponse(run=_to_payload(run))


@router.post("/storyboard/approve", response_model=DirectorRunResponse)
def route_approve_storyboard(
    request: DirectorApproveRequest,
    handler: AppHandler = Depends(get_state_service),
) -> DirectorRunResponse:
    run = handler.director.approve_storyboard(request.runId, regenerate=request.regenerate)
    return DirectorRunResponse(run=_to_payload(run))


@router.post("/resume", response_model=DirectorRunResponse)
def route_resume_director_run(
    request: DirectorTargetRequest,
    handler: AppHandler = Depends(get_state_service),
) -> DirectorRunResponse:
    return DirectorRunResponse(run=_to_payload(handler.director.resume(request.runId)))
