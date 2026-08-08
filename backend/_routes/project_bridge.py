"""Route handlers for /api/project — the agent bridge (read-model + actions)."""

from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from server_utils.timeline_toc import (
    build_toc,
    chapter_detail,
    render_chapter_text,
    render_toc_text,
)
from _routes._errors import HTTPError

from api_types import (
    AgentActionReportRequest,
    AgentActionStatusResponse,
    AgentActionSubmitRequest,
    AgentActionSubmitResponse,
    AgentPendingActionsResponse,
    ProjectCurrentResponse,
    ProjectPublishRequest,
    ProjectPublishResponse,
    ProjectStoryResponse,
    ProjectTranscriptResponse,
)
from app_handler import AppHandler
from state import get_state_service

router = APIRouter(prefix="/api/project", tags=["project"])


@router.post("/publish", response_model=ProjectPublishResponse)
def route_publish_project(
    request: ProjectPublishRequest,
    handler: AppHandler = Depends(get_state_service),
) -> ProjectPublishResponse:
    published_at = handler.project_bridge.publish(request.project)
    return ProjectPublishResponse(status="ok", publishedAt=published_at)


@router.get("/current", response_model=ProjectCurrentResponse)
def route_current_project(
    handler: AppHandler = Depends(get_state_service),
) -> ProjectCurrentResponse:
    project, published_at = handler.project_bridge.current()
    return ProjectCurrentResponse(
        project=project,
        publishedAt=published_at,
        editorLive=handler.project_bridge.is_editor_live(),
    )


@router.get("/toc")
def route_project_toc(
    format: str = "json",
    chapter: int | None = None,
    handler: AppHandler = Depends(get_state_service),
) -> Any:
    """The AI-visible timeline: a compact table of contents over the open
    production (chapters, cast, sections, detected transitions), with a
    self-documenting text language for LLMs (`?format=text`) and per-chapter
    drill-down (`?chapter=N`). Read the TOC first — it costs ~1-2K tokens on a
    300-clip production — then fetch only the chapter you need."""
    project, _published_at = handler.project_bridge.current()
    if not project:
        raise HTTPError(404, "no project published — open a project in the editor first")
    if chapter is not None:
        if format == "text":
            text = render_chapter_text(project, chapter)
            if text is None:
                raise HTTPError(404, f"no chapter {chapter} on this timeline")
            return PlainTextResponse(text)
        events = chapter_detail(project, chapter)
        if events is None:
            raise HTTPError(404, f"no chapter {chapter} on this timeline")
        return {"chapter": chapter, "events": events}
    if format == "text":
        text = render_toc_text(project)
        if text is None:
            raise HTTPError(404, "the project has no timeline")
        return PlainTextResponse(text)
    toc = build_toc(project)
    if toc is None:
        raise HTTPError(404, "the project has no timeline")
    return toc


@router.get("/transcript", response_model=ProjectTranscriptResponse)
def route_project_transcript(
    handler: AppHandler = Depends(get_state_service),
) -> ProjectTranscriptResponse:
    return ProjectTranscriptResponse(words=handler.project_bridge.live_transcript())


@router.get("/story", response_model=ProjectStoryResponse)
def route_project_story(
    handler: AppHandler = Depends(get_state_service),
) -> ProjectStoryResponse:
    story_docs, cast_entries = handler.project_bridge.story()
    return ProjectStoryResponse(storyDocs=story_docs, cast=cast_entries)


@router.post("/actions", response_model=AgentActionSubmitResponse)
def route_submit_actions(
    request: AgentActionSubmitRequest,
    handler: AppHandler = Depends(get_state_service),
) -> AgentActionSubmitResponse:
    ids = handler.project_bridge.submit_actions(request.actions)
    return AgentActionSubmitResponse(ids=ids)


@router.get("/actions/pending", response_model=AgentPendingActionsResponse)
def route_pending_actions(
    handler: AppHandler = Depends(get_state_service),
) -> AgentPendingActionsResponse:
    return AgentPendingActionsResponse(actions=handler.project_bridge.pending_actions())


@router.post("/actions/report", response_model=AgentActionStatusResponse)
def route_report_actions(
    request: AgentActionReportRequest,
    handler: AppHandler = Depends(get_state_service),
) -> AgentActionStatusResponse:
    handler.project_bridge.report_results(request.results)
    return AgentActionStatusResponse(actions=handler.project_bridge.action_statuses())


@router.get("/actions/status", response_model=AgentActionStatusResponse)
def route_action_statuses(
    handler: AppHandler = Depends(get_state_service),
) -> AgentActionStatusResponse:
    return AgentActionStatusResponse(actions=handler.project_bridge.action_statuses())


class LookAtClipRequest(BaseModel):
    clipId: str


class LookAtClipResponse(BaseModel):
    caption: str


@router.post("/look-at-clip", response_model=LookAtClipResponse)
def route_look_at_clip(
    request: LookAtClipRequest,
    handler: AppHandler = Depends(get_state_service),
) -> LookAtClipResponse:
    """PERCEPTION: extract a representative frame from the clip (server-side) and
    caption it, so an agent can SEE what a dropped video/image shows before
    answering or editing. Mirrors the in-app Director's Pal ``look_at_clip``:
    resolve the clip's source, grab a frame, then run the existing caption path.
    """
    frame_path, is_temp = handler.project_bridge.resolve_clip_frame(request.clipId)
    try:
        caption = handler.enhance_prompt.caption_image_for_video(
            image_path=frame_path,
            target_model="ltx-fast",
        )
    finally:
        if is_temp:
            try:
                os.remove(frame_path)
            except OSError:
                pass
    return LookAtClipResponse(caption=caption)
