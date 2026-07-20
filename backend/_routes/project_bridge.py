"""Route handlers for /api/project — the agent bridge (read-model + actions)."""

from __future__ import annotations

from fastapi import APIRouter, Depends

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
    return ProjectCurrentResponse(project=project, publishedAt=published_at)


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
