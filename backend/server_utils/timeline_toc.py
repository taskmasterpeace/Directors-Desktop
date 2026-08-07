"""The AI-visible timeline: a table of contents over the open production.

Robert's directive (2026-08-07): "have the timeline be visible to an AI …
same principle as a table of contents that tells you where certain things
are … a language large language models can really understand, and hints for
editing the timeline."

Design: an agent reads the WHOLE map in one cheap pass (the TOC), then
drills into one chapter for time-coded detail. Every entry carries the
STABLE ids the rest of the bridge speaks (clip ids for the action queue,
asset origins for provenance), so what the agent reads is directly
actionable. The text format is self-documenting — its header explains the
grammar, and the EDITING section teaches the action queue with an example
built from this very timeline.

Pure functions over the renderer's published project snapshot — no state,
fully unit-testable.
"""
from __future__ import annotations

from typing import Any, cast

# One chapter per range marker whose title reads chapter-like; every range
# marker is still listed as a section regardless.
_CHAPTERISH = ("chapter", "part ", "act ", "book ")
# An audio-coverage hole at least this long reads as a transition candidate.
GAP_SECONDS = 4.0
_SNIPPET = 72


def _dicts(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [cast(dict[str, Any], v) for v in cast(list[object], value) if isinstance(v, dict)]


def _num(value: object, default: float = 0.0) -> float:
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return float(value)
    return default


def _text(value: object) -> str:
    return value if isinstance(value, str) else ""


def _fmt_time(seconds: float) -> str:
    m = int(seconds // 60)
    s = seconds - m * 60
    return f"{m}:{s:04.1f}"


def _snippet(text: str, limit: int = _SNIPPET) -> str:
    t = " ".join(text.split())
    return t if len(t) <= limit else t[: limit - 1] + "…"


def _active_timeline(project: dict[str, Any]) -> dict[str, Any] | None:
    timelines = _dicts(project.get("timelines"))
    if not timelines:
        return None
    active_id = project.get("activeTimelineId")
    for t in timelines:
        if t.get("id") == active_id:
            return t
    return timelines[0]


def _clip_speaker(clip: dict[str, Any]) -> str | None:
    asset = clip.get("asset")
    if isinstance(asset, dict):
        origin = cast(dict[str, Any], asset).get("origin")
        if isinstance(origin, dict):
            entity = cast(dict[str, Any], origin).get("entity")
            if isinstance(entity, str) and entity:
                return entity
    return None


def _clip_origin(clip: dict[str, Any]) -> dict[str, Any] | None:
    asset = clip.get("asset")
    if isinstance(asset, dict):
        origin = cast(dict[str, Any], asset).get("origin")
        if isinstance(origin, dict):
            return cast(dict[str, Any], origin)
    return None


def _clip_label(clip: dict[str, Any]) -> str:
    origin = _clip_origin(clip)
    if origin:
        text = _text(origin.get("text")) or _text(origin.get("prompt"))
        if text:
            return text
    name = _text(clip.get("importedName"))
    if name:
        return name
    asset = clip.get("asset")
    if isinstance(asset, dict):
        return _text(cast(dict[str, Any], asset).get("prompt"))
    return ""


def _duration(timeline: dict[str, Any]) -> float:
    end = 0.0
    for clip in _dicts(timeline.get("clips")):
        end = max(end, _num(clip.get("startTime")) + _num(clip.get("duration")))
    for marker in _dicts(timeline.get("markers")):
        end = max(end, _num(marker.get("time")) + _num(marker.get("duration")))
    return end


def _audio_gaps(timeline: dict[str, Any], total: float) -> list[dict[str, Any]]:
    """Holes in AUDIO coverage — chapter-transition candidates on productions
    whose structure lives in the sound (audiobooks). Video-only stretches do
    not count as gaps."""
    spans = sorted(
        (
            (_num(c.get("startTime")), _num(c.get("startTime")) + _num(c.get("duration")))
            for c in _dicts(timeline.get("clips"))
            if c.get("type") == "audio"
        ),
    )
    if not spans:
        return []
    gaps: list[dict[str, Any]] = []
    cursor = spans[0][1]
    for start, end in spans[1:]:
        if start - cursor >= GAP_SECONDS:
            gaps.append({"at": round(cursor, 2), "seconds": round(start - cursor, 2)})
        cursor = max(cursor, end)
    if total - cursor >= GAP_SECONDS:
        gaps.append({"at": round(cursor, 2), "seconds": round(total - cursor, 2)})
    return gaps


def build_toc(project: dict[str, Any]) -> dict[str, Any] | None:
    """The machine TOC. None when the project has no timeline at all."""
    timeline = _active_timeline(project)
    if timeline is None:
        return None
    clips = _dicts(timeline.get("clips"))
    markers = _dicts(timeline.get("markers"))
    tracks = _dicts(timeline.get("tracks"))
    total = _duration(timeline)

    sections: list[dict[str, Any]] = [
        {
            "id": _text(m.get("id")),
            "title": _text(m.get("title")),
            "start": round(_num(m.get("time")), 2),
            "end": round(_num(m.get("time")) + _num(m.get("duration")), 2),
            "color": _text(m.get("color")) or None,
        }
        for m in markers
        if _num(m.get("duration")) > 0
    ]
    sections.sort(key=lambda s: _num(s["start"]))

    chapters: list[dict[str, Any]] = [
        s for s in sections if _text(s["title"]).lower().startswith(_CHAPTERISH)
    ]
    synthesized = False
    if not chapters:
        # No explicit chapters: the whole timeline is one chapter, honestly
        # labeled as synthesized so an agent doesn't invent structure.
        synthesized = True
        chapters = [{
            "id": "toc-full", "title": _text(timeline.get("name")) or "Full timeline",
            "start": 0.0, "end": round(total, 2), "color": None,
        }]

    speakers: dict[str, dict[str, Any]] = {}
    for clip in clips:
        who = _clip_speaker(clip)
        if not who:
            continue
        entry = speakers.setdefault(who, {"lines": 0, "trackIndexes": set()})
        entry["lines"] += 1
        entry["trackIndexes"].add(int(_num(clip.get("trackIndex"), -1)))

    def _summary(start: float, end: float) -> dict[str, Any]:
        inside = [c for c in clips if start <= _num(c.get("startTime")) < end]
        by_kind: dict[str, int] = {}
        who: dict[str, int] = {}
        takes = 0
        missing = 0
        for c in inside:
            kind = _text(c.get("type")) or "?"
            by_kind[kind] = by_kind.get(kind, 0) + 1
            s = _clip_speaker(c)
            if s:
                who[s] = who.get(s, 0) + 1
            asset = c.get("asset")
            if isinstance(asset, dict):
                t = cast(dict[str, Any], asset).get("takes")
                if isinstance(t, list) and len(cast(list[object], t)) > 1:
                    takes += 1
            if _text(c.get("importedName")).startswith("MISSING"):
                missing += 1
        return {
            "clips": len(inside),
            "byKind": by_kind,
            "speakers": sorted(who, key=lambda k: -who[k]),
            "clipsWithExtraTakes": takes,
            "missingMedia": missing,
        }

    for ch in chapters:
        ch["summary"] = _summary(_num(ch["start"]), _num(ch["end"]) or total)

    return {
        "version": 1,
        "project": _text(project.get("name")),
        "timeline": _text(timeline.get("name")),
        "durationSec": round(total, 2),
        "counts": {"clips": len(clips), "markers": len(markers), "tracks": len(tracks),
                   "subtitles": len(_dicts(timeline.get("subtitles")))},
        "tracks": [
            {"index": i, "name": _text(t.get("name")), "kind": _text(t.get("kind")) or None}
            for i, t in enumerate(tracks)
        ],
        "cast": [
            {"entity": name, "lines": info["lines"],
             "trackIndexes": sorted(cast(set[int], info["trackIndexes"]))}
            for name, info in sorted(speakers.items(), key=lambda kv: -cast(int, kv[1]["lines"]))
        ],
        "chapters": chapters,
        "chaptersSynthesized": synthesized,
        "sections": sections,
        "transitionCandidates": _audio_gaps(timeline, total),
    }


def chapter_detail(project: dict[str, Any], index: int) -> list[dict[str, Any]] | None:
    """Time-ordered events inside chapter `index` (1-based), each with its
    stable clip id, speaker/kind, provenance and a text snippet."""
    toc = build_toc(project)
    if toc is None or not (1 <= index <= len(toc["chapters"])):
        return None
    ch = toc["chapters"][index - 1]
    start, end = _num(ch["start"]), _num(ch["end"]) or _num(toc["durationSec"])
    timeline = _active_timeline(project)
    assert timeline is not None
    events: list[dict[str, Any]] = []
    for clip in _dicts(timeline.get("clips")):
        t0 = _num(clip.get("startTime"))
        if not (start <= t0 < end):
            continue
        origin = _clip_origin(clip) or {}
        events.append({
            "clipId": _text(clip.get("id")),
            "kind": _text(clip.get("type")),
            "trackIndex": int(_num(clip.get("trackIndex"), -1)),
            "start": round(t0, 2),
            "end": round(t0 + _num(clip.get("duration")), 2),
            "speaker": _clip_speaker(clip),
            "text": _snippet(_clip_label(clip)),
            "engine": _text(origin.get("engine")) or None,
            "sourceId": _text(origin.get("lineId")) or _text(origin.get("beatId")) or None,
        })
    events.sort(key=lambda e: (e["start"], e["trackIndex"]))
    return events


# ── the text language ────────────────────────────────────────────────────────

_EDIT_HELP = """EDITING — POST /api/project/actions {"actions":[…]}, poll /api/project/actions/status
  kinds: move_clip{clipId,startTime[,trackIndex]} · trim_clip{clipId,trimStart,trimEnd: ABSOLUTE
  source-media seconds} · delete_clip{clipId} · add_marker{time,title[,duration,color]} ·
  update_marker/delete_marker{markerId} · captions_from_transcript{} · generate_and_place{prompt,…} ·
  regenerate_with_reference{clipId, referenceImagePaths?[], videoReferencePaths?[],
    referenceFromClips?[{clipId,atSeconds?,cropRect?{x,y,w,h 0..1},as?:image|video}], note?}: re-render an
    existing clip to match references — lands as a NEW TAKE (original retained), clip-length capped at 15s.
    referenceFromClips builds a reference straight from ANOTHER clip (a frame or ≤15s window, optionally
    cropped), e.g. "redo clip 12 to match a close crop of clip 8" — no pre-existing file needed
  Actions apply through the user's undo stack; linked A/V moves together; assets are never deleted."""


def render_toc_text(project: dict[str, Any]) -> str | None:
    toc = build_toc(project)
    if toc is None:
        return None
    lines: list[str] = []
    lines.append(f"# PRODUCTION TOC v1 — {toc['project'] or 'untitled'} / {toc['timeline']}")
    c = toc["counts"]
    lines.append(
        f"# {_fmt_time(_num(toc['durationSec']))} · {c['tracks']} tracks · {c['clips']} clips"
        f" · {c['markers']} markers · {c['subtitles']} subtitles"
    )
    lines.append("# Times are M:SS.s. Ids in (parens) are stable across this session — use them")
    lines.append("# with the EDITING actions below. Chapter detail: GET /api/project/toc?chapter=N&format=text")
    lines.append("")

    if toc["tracks"]:
        lines.append("TRACKS")
        for t in toc["tracks"]:
            kind = f" ({t['kind']})" if t.get("kind") else ""
            lines.append(f"  {t['index']}: {t['name']}{kind}")
        lines.append("")

    if toc["cast"]:
        lines.append("CAST (by line count)")
        for m in toc["cast"]:
            lanes = ",".join(str(i) for i in m["trackIndexes"])
            lines.append(f"  {m['entity']} — {m['lines']} lines (track {lanes})")
        lines.append("")

    label = "CHAPTERS (synthesized — no chapter markers on the timeline yet)" if toc["chaptersSynthesized"] else "CHAPTERS"
    lines.append(label)
    for i, ch in enumerate(toc["chapters"], 1):
        s = ch["summary"]
        kinds = " ".join(f"{k}:{v}" for k, v in sorted(cast(dict[str, int], s["byKind"]).items()))
        who = ", ".join(cast(list[str], s["speakers"])[:6])
        extra = f" · {s['clipsWithExtraTakes']} clips w/ takes" if s["clipsWithExtraTakes"] else ""
        miss = f" · MISSING media: {s['missingMedia']}" if s["missingMedia"] else ""
        lines.append(
            f"  {i}. [{_fmt_time(_num(ch['start']))}–{_fmt_time(_num(ch['end']))}] \"{ch['title']}\""
            f" ({ch['id']}) — {s['clips']} clips ({kinds})"
            + (f" · speakers: {who}" if who else "") + extra + miss
        )
    other = [s for s in toc["sections"] if s not in toc["chapters"]]
    if other:
        lines.append("")
        lines.append("SECTIONS (other range markers)")
        for s in other:
            lines.append(f"  [{_fmt_time(_num(s['start']))}–{_fmt_time(_num(s['end']))}] \"{s['title']}\" ({s['id']})")
    if toc["transitionCandidates"]:
        lines.append("")
        lines.append("TRANSITIONS DETECTED (audio-coverage gaps — chapter-boundary candidates)")
        for g in toc["transitionCandidates"]:
            lines.append(f"  [{_fmt_time(_num(g['at']))}] {g['seconds']}s of silence")
    lines.append("")
    lines.append(_EDIT_HELP)
    return "\n".join(lines)


def render_chapter_text(project: dict[str, Any], index: int) -> str | None:
    events = chapter_detail(project, index)
    if events is None:
        return None
    toc = build_toc(project)
    assert toc is not None
    ch = toc["chapters"][index - 1]
    lines = [f"# CHAPTER {index} — \"{ch['title']}\" [{_fmt_time(_num(ch['start']))}–{_fmt_time(_num(ch['end']))}]"]
    lines.append("# one event per line: [start–end] track speaker/kind (clipId · source · engine) \"text\"")
    for e in events:
        who = e["speaker"] or e["kind"]
        ident = " · ".join(x for x in (e["clipId"], e["sourceId"], e["engine"]) if x)
        text = f' "{e["text"]}"' if e["text"] else ""
        lines.append(f"  [{_fmt_time(_num(e['start']))}–{_fmt_time(_num(e['end']))}] t{e['trackIndex']} {who} ({ident}){text}")
    return "\n".join(lines)
