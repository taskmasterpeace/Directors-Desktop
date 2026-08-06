"""Route handlers for /api/queue/*."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from _routes._errors import HTTPError
from api_types import (
    QueueJobResponse,
    QueueReorderRequest,
    QueueStatusResponse,
    QueueSubmitRequest,
    QueueSubmitResponse,
    QueueUpdateRequest,
)
from state import get_state_service
from app_handler import AppHandler

router = APIRouter(prefix="/api/queue", tags=["queue"])


@router.post("/submit", response_model=QueueSubmitResponse)
def route_queue_submit(
    req: QueueSubmitRequest,
    handler: AppHandler = Depends(get_state_service),
) -> QueueSubmitResponse:
    slot = handler.determine_slot(req.model)
    job = handler.job_queue.submit(
        job_type=req.type,
        model=req.model,
        params={k: v for k, v in req.params.items()},
        slot=slot,
        tags=req.tags or None,
        depends_on=req.depends_on,
        auto_params=req.auto_params or None,
        batch_id=req.batch_id,
        batch_index=req.batch_index,
    )
    return QueueSubmitResponse(id=job.id, status=job.status)


@router.post("/reorder", response_model=QueueStatusResponse)
def route_queue_reorder(
    req: QueueReorderRequest,
    handler: AppHandler = Depends(get_state_service),
) -> QueueStatusResponse:
    """Rearrange queued jobs (dispatch order is list order). Ids that started
    running between drag and drop are ignored; the fresh list comes back so
    the UI reconciles instead of guessing."""
    handler.job_queue.reorder_queued(req.ordered_ids)
    return route_queue_status(handler)


@router.patch("/{job_id}", response_model=QueueSubmitResponse)
def route_queue_update(
    job_id: str,
    req: QueueUpdateRequest,
    handler: AppHandler = Depends(get_state_service),
) -> QueueSubmitResponse:
    """Edit-before-render. 409 when the job already started — a render never
    mutates mid-flight."""
    new_slot = handler.determine_slot(req.model) if req.model else None
    job = handler.job_queue.update_queued_job(
        job_id,
        params={k: v for k, v in req.params.items()} if req.params is not None else None,
        model=req.model,
        slot=new_slot,
    )
    if job is None:
        raise HTTPError(409, "Job already started (or unknown) — edits only apply while queued.")
    return QueueSubmitResponse(id=job.id, status=job.status)


@router.get("/status", response_model=QueueStatusResponse)
def route_queue_status(
    handler: AppHandler = Depends(get_state_service),
) -> QueueStatusResponse:
    jobs = handler.job_queue.get_all_jobs()
    return QueueStatusResponse(jobs=[
        QueueJobResponse(
            id=j.id, type=j.type, model=j.model, params={k: v for k, v in j.params.items()},
            status=j.status, slot=j.slot, progress=j.progress, phase=j.phase,
            result_paths=j.result_paths, error=j.error, created_at=j.created_at,
            batch_id=j.batch_id, batch_index=j.batch_index, tags=j.tags,
        )
        for j in jobs
    ])


@router.post("/cancel/{job_id}", response_model=QueueSubmitResponse)
def route_queue_cancel(
    job_id: str,
    handler: AppHandler = Depends(get_state_service),
) -> QueueSubmitResponse:
    job = handler.job_queue.get_job(job_id)
    # Only stop the running pipeline if the cancelled job is the one actually
    # running — cancelling a *queued* job must not abort the running job. Target
    # the job's own slot so a running job on the other slot is untouched.
    was_running = job is not None and job.status == "running"
    handler.job_queue.cancel_job(job_id)
    if was_running and job is not None:
        handler.generation.cancel_generation(slot=job.slot)
    job = handler.job_queue.get_job(job_id)
    status = job.status if job else "not_found"
    return QueueSubmitResponse(id=job_id, status=status)


@router.post("/clear", response_model=QueueStatusResponse)
def route_queue_clear(
    handler: AppHandler = Depends(get_state_service),
) -> QueueStatusResponse:
    handler.job_queue.clear_finished()
    return route_queue_status(handler)
