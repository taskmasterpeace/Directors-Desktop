"""Story Stage routes: dramatis bookshelf, book detail, un-mixed chapter export."""
from __future__ import annotations

from fastapi import APIRouter, Depends

from _routes._errors import HTTPError
from app_handler import AppHandler
from server_utils.dramatis_bridge import JsonDict
from state import get_state_service

router = APIRouter(tags=["dramatis"])


@router.get("/api/dramatis/status")
def dramatis_status(handler: AppHandler = Depends(get_state_service)) -> JsonDict:
    return handler.dramatis.status()


@router.get("/api/dramatis/book/{book_dir}")
def dramatis_book(book_dir: str, handler: AppHandler = Depends(get_state_service)) -> JsonDict:
    book = handler.dramatis.book(book_dir)
    if book is None:
        raise HTTPError(404, f"No dramatis book '{book_dir}' (or no dramatis install found)")
    return book


@router.get("/api/dramatis/export/{book_dir}/{chapter}")
def dramatis_export(
    book_dir: str, chapter: int, handler: AppHandler = Depends(get_state_service),
) -> JsonDict:
    data = handler.dramatis.export(book_dir, chapter)
    if data is None:
        raise HTTPError(
            404,
            f"No dd-elements export for {book_dir} ch-{chapter:02d} — render the chapter in the Studio first",
        )
    return data
