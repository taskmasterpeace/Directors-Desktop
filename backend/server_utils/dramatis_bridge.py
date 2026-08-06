"""Read side of the Audio Movie Studio (dramatis) integration.

Dramatis renders full-cast audio for a manuscript — every line attributed to a
character voice, SFX placed at word onsets, ambience beds, score — and its mix
stage emits ``dd-elements.json`` per chapter: the UN-mixed timeline (absolute
media paths + times for every element). This module is pure filesystem reads
over that layout so the Story Stage view can browse books and the editor can
place elements as separate clips. No subprocesses here: the Studio process is
Electron's job, renders are the Studio's job.

Layout consumed (all relative to the dramatis root):
    books/<id>/book.json                     project: cast, voices, chapters
    out/<id>/ch-NN/dd-elements.json          per-chapter un-mixed timeline
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, cast

JsonDict = dict[str, Any]

# Auto-discovery candidates when no root is configured.
DEFAULT_ROOTS = (Path("D:/git/dramatis"),)

_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def resolve_root(setting: str) -> Path | None:
    """The configured root if it looks like a dramatis install, else the first
    default candidate that does. None when nothing qualifies."""
    candidates = (Path(setting),) if setting.strip() else DEFAULT_ROOTS
    for cand in candidates:
        if (cand / "books").is_dir():
            return cand
    return None


def _read_json(p: Path) -> JsonDict | None:
    try:
        data: Any = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return cast(JsonDict, data) if isinstance(data, dict) else None


def _dicts(value: Any) -> list[JsonDict]:
    """The list-of-objects accessor every dramatis collection uses; anything
    that is not a dict is dropped (junk tolerance, never a crash)."""
    if not isinstance(value, list):
        return []
    return [cast(JsonDict, item) for item in cast(list[Any], value) if isinstance(item, dict)]


def chapter_dirname(n: int) -> str:
    return f"ch-{n:02d}"


def safe_id(book_id: str) -> bool:
    """Route params become path segments — refuse anything that could escape
    the books/out tree (traversal, separators, empty)."""
    return bool(_SAFE_ID.match(book_id)) and ".." not in book_id


def _chapter_states(root: Path, book_dir: str, cfg: JsonDict) -> list[JsonDict]:
    book_json = root / "books" / book_dir / "book.json"
    try:
        book_mtime = book_json.stat().st_mtime
    except OSError:
        book_mtime = 0.0
    chapters: list[JsonDict] = []
    for i, ch in enumerate(_dicts(cfg.get("chapters")), start=1):
        dd = root / "out" / book_dir / chapter_dirname(i) / "dd-elements.json"
        rendered = dd.is_file()
        stale = False
        lines: int | None = None
        cues: int | None = None
        duration: Any = None
        if rendered:
            # Rendered before the book config last changed = the export shows
            # an older cut. Still importable — staleness is a fact, not a block.
            stale = dd.stat().st_mtime < book_mtime
            data = _read_json(dd) or {}
            lines = len(_dicts(data.get("lines")))
            cues = len(_dicts(data.get("cues")))
            duration = data.get("durationSec")
        chapters.append({
            "number": i,
            "heading": str(ch.get("heading") or f"Chapter {i}"),
            "scenes": len(_dicts(ch.get("scenes"))),
            "cueSpecs": len(_dicts(ch.get("cues"))),
            "musicSpecs": len(_dicts(ch.get("music"))),
            "rendered": rendered,
            "stale": stale,
            "lines": lines,
            "cues": cues,
            "durationSec": duration,
        })
    return chapters


def scan_books(root: Path) -> list[JsonDict]:
    """Bookshelf: every books/<id>/book.json with per-chapter artifact state."""
    books: list[JsonDict] = []
    books_dir = root / "books"
    try:
        entries = sorted(books_dir.iterdir())
    except OSError:
        return books
    for bdir in entries:
        cfg = _read_json(bdir / "book.json")
        if cfg is None:
            continue
        entities = _dicts(cfg.get("entities"))
        characters = [e for e in entities if e.get("kind") == "character"]
        books.append({
            "id": str(cfg.get("id") or bdir.name),
            "dir": bdir.name,
            "title": str(cfg.get("title") or bdir.name),
            "author": cfg.get("author"),
            "entities": len(entities),
            "characters": len(characters),
            "chapters": _chapter_states(root, bdir.name, cfg),
        })
    return books


# Engines that run on the user's own machine. Anything else is flagged as
# premium so the UI can tell the truth about cost (local = $0, 0 pts).
LOCAL_ENGINES = {"kokoro", "qwen3"}
# ElevenLabs list price the Studio pre-flight uses (USD per 1k characters).
ELEVENLABS_USD_PER_1K_CHARS = 0.22


def read_book(root: Path, book_dir: str) -> JsonDict | None:
    """Full book detail: cast with visuals + per-engine voice coverage, hint
    counts (the hero-line dial), chapter states, and an honest cost sketch."""
    cfg = _read_json(root / "books" / book_dir / "book.json")
    if cfg is None:
        return None
    voices_raw = cfg.get("voices")
    voices: JsonDict = cast(JsonDict, voices_raw) if isinstance(voices_raw, dict) else {}
    engines = [name for name, table in voices.items() if isinstance(table, dict)]
    entities: list[JsonDict] = []
    for e in _dicts(cfg.get("entities")):
        eid = str(e.get("id") or "")
        entity_voices: JsonDict = {}
        for eng in engines:
            table = cast(JsonDict, voices[eng])
            voice = table.get(eid)
            if isinstance(voice, dict):
                entity_voices[eng] = cast(JsonDict, voice)
        entities.append({
            "id": eid,
            "kind": e.get("kind"),
            "names": e.get("names") or [],
            "visual": e.get("visual"),
            "voices": entity_voices,
        })
    hints = _dicts(cfg.get("hints"))
    hero_hints = [h for h in hints if h.get("emotion")]
    # The hero-line dial: emotion hints route lines to ElevenLabs under the
    # hybrid profile. Char counts live in the manuscript, not book.json, so
    # this is a per-line estimate (~90 chars avg measured across the sample
    # books) — the Studio pre-flight owns the exact number.
    est_hero_chars = len(hero_hints) * 90
    return {
        "id": str(cfg.get("id") or book_dir),
        "dir": book_dir,
        "title": str(cfg.get("title") or book_dir),
        "author": cfg.get("author"),
        "style": cfg.get("style"),
        "engines": engines,
        "entities": entities,
        "hints": len(hints),
        "heroLines": len(hero_hints),
        "cost": {
            "localUsd": 0.0,
            "localPts": 0,
            "heroEstUsd": round(est_hero_chars / 1000 * ELEVENLABS_USD_PER_1K_CHARS, 2),
            "note": "kokoro/qwen3/SFX/score run on this machine — free. Hero lines only cost when the hybrid profile routes them to ElevenLabs (your key).",
        },
        "chapters": _chapter_states(root, book_dir, cfg),
    }


def read_export(root: Path, book_dir: str, chapter: int) -> JsonDict | None:
    """dd-elements.json with every media path existence-checked. Missing media
    is FLAGGED (missing: true + summary counts), never silently dropped — the
    loader downstream places placeholders so the timeline shape survives."""
    dd = root / "out" / book_dir / chapter_dirname(chapter) / "dd-elements.json"
    data = _read_json(dd)
    if data is None:
        return None
    missing = 0
    total = 0

    def check(item: JsonDict, key: str) -> None:
        nonlocal missing, total
        total += 1
        path = item.get(key)
        ok = isinstance(path, str) and Path(path).is_file()
        if not ok:
            item["missing"] = True
            missing += 1

    for line in _dicts(data.get("lines")):
        check(line, "wav")
    for group, key in (("cues", "file"), ("beds", "file"), ("music", "file")):
        for item in _dicts(data.get(group)):
            check(item, key)
    data["media"] = {"total": total, "missing": missing}
    # The manifest's own `chapter` field is the chapter TITLE; the takes API
    # addresses chapters by 1-based ordinal, so the ordinal rides along here.
    data["chapterNumber"] = chapter
    book_json = root / "books" / book_dir / "book.json"
    try:
        data["stale"] = dd.stat().st_mtime < book_json.stat().st_mtime
    except OSError:
        data["stale"] = False
    return data
