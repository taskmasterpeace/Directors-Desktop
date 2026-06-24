"""Route handlers for /api/library/* (characters, styles, references)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Query, UploadFile

from api_types import (
    AudioReferenceCreate,
    AudioReferenceListResponse,
    AudioReferenceResponse,
    CharacterCreate,
    CharacterListResponse,
    CharacterResponse,
    CharacterUpdate,
    LibraryReferenceCategory,
    ReferenceCreate,
    ReferenceListResponse,
    ReferenceResponse,
    StatusResponse,
    StyleCreate,
    StyleListResponse,
    StyleResponse,
)
from app_handler import AppHandler
from state import get_state_service
from state.library_store import AudioReference, Character, Reference, Style

router = APIRouter(prefix="/api/library", tags=["library"])


def _character_response(c: Character) -> CharacterResponse:
    return CharacterResponse(
        id=c.id,
        name=c.name,
        role=c.role,
        description=c.description,
        reference_image_paths=c.reference_image_paths,
        created_at=c.created_at,
    )


def _style_response(s: Style) -> StyleResponse:
    return StyleResponse(
        id=s.id,
        name=s.name,
        description=s.description,
        reference_image_path=s.reference_image_path,
        created_at=s.created_at,
    )


def _reference_response(r: Reference) -> ReferenceResponse:
    return ReferenceResponse(
        id=r.id,
        name=r.name,
        category=r.category,
        image_path=r.image_path,
        created_at=r.created_at,
    )


def _audio_response(a: AudioReference) -> AudioReferenceResponse:
    return AudioReferenceResponse(
        id=a.id,
        name=a.name,
        file_path=a.file_path,
        source=a.source,
        duration_seconds=a.duration_seconds,
        created_at=a.created_at,
    )


# ------------------------------------------------------------------
# Characters
# ------------------------------------------------------------------


@router.get("/characters", response_model=CharacterListResponse)
def route_list_characters(
    handler: AppHandler = Depends(get_state_service),
) -> CharacterListResponse:
    items = handler.library.list_characters()
    return CharacterListResponse(characters=[_character_response(c) for c in items])


@router.post("/characters", response_model=CharacterResponse)
def route_create_character(
    req: CharacterCreate,
    handler: AppHandler = Depends(get_state_service),
) -> CharacterResponse:
    result = handler.library.create_character(
        name=req.name,
        role=req.role,
        description=req.description,
        reference_image_paths=req.reference_image_paths,
    )
    return _character_response(result)


@router.put("/characters/{character_id}", response_model=CharacterResponse)
def route_update_character(
    character_id: str,
    req: CharacterUpdate,
    handler: AppHandler = Depends(get_state_service),
) -> CharacterResponse:
    result = handler.library.update_character(
        character_id,
        name=req.name,
        role=req.role,
        description=req.description,
        reference_image_paths=req.reference_image_paths,
    )
    return _character_response(result)


@router.delete("/characters/{character_id}", response_model=StatusResponse)
def route_delete_character(
    character_id: str,
    handler: AppHandler = Depends(get_state_service),
) -> StatusResponse:
    handler.library.delete_character(character_id)
    return StatusResponse(status="ok")


# ------------------------------------------------------------------
# Styles
# ------------------------------------------------------------------


@router.get("/styles", response_model=StyleListResponse)
def route_list_styles(
    handler: AppHandler = Depends(get_state_service),
) -> StyleListResponse:
    items = handler.library.list_styles()
    return StyleListResponse(styles=[_style_response(s) for s in items])


@router.post("/styles", response_model=StyleResponse)
def route_create_style(
    req: StyleCreate,
    handler: AppHandler = Depends(get_state_service),
) -> StyleResponse:
    result = handler.library.create_style(
        name=req.name,
        description=req.description,
        reference_image_path=req.reference_image_path,
    )
    return _style_response(result)


@router.delete("/styles/{style_id}", response_model=StatusResponse)
def route_delete_style(
    style_id: str,
    handler: AppHandler = Depends(get_state_service),
) -> StatusResponse:
    handler.library.delete_style(style_id)
    return StatusResponse(status="ok")


# ------------------------------------------------------------------
# References
# ------------------------------------------------------------------


@router.get("/references", response_model=ReferenceListResponse)
def route_list_references(
    category: LibraryReferenceCategory | None = Query(default=None),
    handler: AppHandler = Depends(get_state_service),
) -> ReferenceListResponse:
    items = handler.library.list_references(category)
    return ReferenceListResponse(references=[_reference_response(r) for r in items])


@router.post("/references", response_model=ReferenceResponse)
def route_create_reference(
    req: ReferenceCreate,
    handler: AppHandler = Depends(get_state_service),
) -> ReferenceResponse:
    result = handler.library.create_reference(
        name=req.name,
        category=req.category,
        image_path=req.image_path,
    )
    return _reference_response(result)


@router.delete("/references/{reference_id}", response_model=StatusResponse)
def route_delete_reference(
    reference_id: str,
    handler: AppHandler = Depends(get_state_service),
) -> StatusResponse:
    handler.library.delete_reference(reference_id)
    return StatusResponse(status="ok")


# ------------------------------------------------------------------
# Audio references (Seedance 2.0 audio refs; sources: upload / timeline / library)
# ------------------------------------------------------------------


@router.get("/audio", response_model=AudioReferenceListResponse)
def route_list_audio(
    handler: AppHandler = Depends(get_state_service),
) -> AudioReferenceListResponse:
    items = handler.library.list_audio()
    return AudioReferenceListResponse(audio=[_audio_response(a) for a in items])


@router.post("/audio", response_model=AudioReferenceResponse)
def route_create_audio(
    req: AudioReferenceCreate,
    handler: AppHandler = Depends(get_state_service),
) -> AudioReferenceResponse:
    result = handler.library.create_audio(
        name=req.name,
        file_path=req.file_path,
        source=req.source,
        duration_seconds=req.duration_seconds,
    )
    return _audio_response(result)


@router.post("/audio/upload", response_model=AudioReferenceResponse)
async def route_upload_audio(
    file: UploadFile = File(...),
    handler: AppHandler = Depends(get_state_service),
) -> AudioReferenceResponse:
    data = await file.read()
    result = handler.library.upload_audio(filename=file.filename or "audio", data=data)
    return _audio_response(result)


@router.delete("/audio/{audio_id}", response_model=StatusResponse)
def route_delete_audio(
    audio_id: str,
    handler: AppHandler = Depends(get_state_service),
) -> StatusResponse:
    handler.library.delete_audio(audio_id)
    return StatusResponse(status="ok")
