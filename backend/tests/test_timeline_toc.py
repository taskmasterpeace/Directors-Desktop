"""The AI-visible timeline: TOC, chapter detection, the LLM text language."""
from __future__ import annotations

from typing import Any

from server_utils.timeline_toc import (
    build_toc,
    chapter_detail,
    render_chapter_text,
    render_toc_text,
)


def _clip(cid: str, t0: float, dur: float, track: int, kind: str = "audio",
          entity: str | None = None, text: str = "", engine: str | None = None,
          takes: int = 0) -> dict[str, Any]:
    asset: dict[str, Any] = {"id": f"asset-{cid}", "prompt": text}
    if entity or engine:
        asset["origin"] = {"app": "dramatis", "entity": entity, "text": text,
                           "engine": engine, "lineId": cid}
    if takes:
        asset["takes"] = [{"url": "u", "path": "p", "createdAt": 1}] * takes
    return {"id": f"clip-{cid}", "type": kind, "startTime": t0, "duration": dur,
            "trackIndex": track, "asset": asset, "importedName": text}


def _project(clips: list[dict[str, Any]], markers: list[dict[str, Any]] | None = None,
             tracks: int = 8) -> dict[str, Any]:
    return {
        "name": "Test Production",
        "activeTimelineId": "tl-1",
        "timelines": [{
            "id": "tl-1", "name": "Part I",
            "tracks": [{"name": f"T{i}", "kind": "video" if i < 3 else "audio"} for i in range(tracks)],
            "clips": clips,
            "markers": markers or [],
            "subtitles": [],
        }],
    }


def test_chapters_come_from_chapterish_range_markers() -> None:
    project = _project(
        [_clip("a", 1, 5, 3, entity="narrator", text="Once upon a time.")],
        markers=[
            {"id": "m1", "time": 0, "duration": 60, "title": "Chapter One", "color": "amber"},
            {"id": "m2", "time": 60, "duration": 30, "title": "Chapter Two"},
            {"id": "m3", "time": 10, "duration": 20, "title": "verse"},  # section, not chapter
            {"id": "m4", "time": 5, "title": "point marker"},            # no duration — ignored
        ],
    )
    toc = build_toc(project)
    assert toc is not None
    assert [c["title"] for c in toc["chapters"]] == ["Chapter One", "Chapter Two"]
    assert toc["chaptersSynthesized"] is False
    assert [s["title"] for s in toc["sections"]] == ["Chapter One", "verse", "Chapter Two"]


def test_no_markers_synthesizes_one_honest_chapter() -> None:
    toc = build_toc(_project([_clip("a", 0, 10, 3, entity="narrator", text="hello")]))
    assert toc is not None
    assert toc["chaptersSynthesized"] is True
    assert len(toc["chapters"]) == 1
    assert toc["chapters"][0]["end"] == 10.0


def test_cast_thirty_speakers_all_counted_and_ranked() -> None:
    clips = []
    for i in range(30):
        # speaker i gets i+1 lines — spk29 is the lead
        for j in range(i + 1):
            clips.append(_clip(f"s{i}-{j}", i * 40 + j, 1, 3 + (i % 5),
                               entity=f"spk{i}", text=f"line {j}"))
    toc = build_toc(_project(clips))
    assert toc is not None
    assert len(toc["cast"]) == 30
    assert toc["cast"][0] == {"entity": "spk29", "lines": 30, "trackIndexes": [7]}
    assert toc["cast"][-1]["lines"] == 1


def test_transition_candidates_are_audio_gaps_only() -> None:
    clips = [
        _clip("a", 0, 10, 3, entity="narrator", text="first"),
        _clip("b", 16, 10, 3, entity="narrator", text="after a 6s gap"),
        # a video clip bridging the gap must NOT hide the audio silence
        _clip("v", 8, 12, 0, kind="video", text="b-roll"),
        _clip("c", 27, 3, 3, entity="narrator", text="small 1s gap ignored"),
    ]
    toc = build_toc(_project(clips))
    assert toc is not None
    assert toc["transitionCandidates"] == [{"at": 10.0, "seconds": 6.0}]


def test_chapter_summary_counts_takes_and_speakers() -> None:
    clips = [
        _clip("a", 1, 4, 3, entity="narrator", text="calm", engine="kokoro"),
        _clip("b", 6, 3, 4, entity="mr_white", text="Hark at the wind,", engine="qwen3", takes=2),
        _clip("v", 2, 5, 0, kind="video", text="scene still"),
    ]
    toc = build_toc(_project(clips, markers=[
        {"id": "m1", "time": 0, "duration": 20, "title": "Chapter One"},
    ]))
    assert toc is not None
    s = toc["chapters"][0]["summary"]
    assert s["clips"] == 3
    assert s["byKind"] == {"audio": 2, "video": 1}
    assert s["speakers"][0] in ("narrator", "mr_white")
    assert s["clipsWithExtraTakes"] == 1


def test_text_language_is_self_documenting_and_carries_stable_ids() -> None:
    project = _project(
        [
            _clip("a", 1, 4, 3, entity="narrator", text="Without, the night was cold and wet.", engine="kokoro"),
            _clip("b", 6, 3, 4, entity="mr_white", text="Hark at the wind,", engine="qwen3"),
        ],
        markers=[{"id": "m1", "time": 0, "duration": 20, "title": "Chapter One", "color": "amber"}],
    )
    text = render_toc_text(project)
    assert text is not None
    assert "PRODUCTION TOC v1" in text
    assert "CHAPTERS" in text and "Chapter One" in text and "(m1)" in text
    assert "CAST" in text and "narrator" in text
    assert "EDITING" in text and "move_clip" in text and "/api/project/actions" in text
    # The TOC is the cheap read: it must never inline per-line dialogue.
    assert "Hark at the wind" not in text

    detail = render_chapter_text(project, 1)
    assert detail is not None
    assert "clip-b" in detail and "qwen3" in detail and "Hark at the wind," in detail
    assert "[0:06.0–0:09.0]" in detail


def test_toc_stays_cheap_on_a_big_production() -> None:
    clips = [
        _clip(f"l{i}", i * 4.0, 3.5, 3 + (i % 6), entity=f"spk{i % 8}",
              text=f"Line number {i} with a reasonably long sentence in it.", engine="qwen3")
        for i in range(300)
    ]
    markers = [
        {"id": f"ch{k}", "time": k * 300.0, "duration": 300.0, "title": f"Chapter {k + 1}"}
        for k in range(4)
    ]
    text = render_toc_text(_project(clips, markers=markers))
    assert text is not None
    # ~1-2K tokens ceiling: chars are a stable proxy (≈4 chars/token → <8KB)
    assert len(text) < 8000, f"TOC text ballooned to {len(text)} chars"


def test_chapter_detail_bounds_and_missing_project() -> None:
    project = _project([_clip("a", 1, 4, 3, entity="narrator", text="x")])
    assert chapter_detail(project, 2) is None
    assert build_toc({"timelines": []}) is None
    assert render_toc_text({"timelines": []}) is None


def test_toc_route_serves_json_text_and_404s(client, test_state) -> None:  # type: ignore[no-untyped-def]
    r = client.get("/api/project/toc")
    assert r.status_code == 404  # nothing published yet

    project = _project(
        [_clip("a", 1, 4, 3, entity="narrator", text="hello there", engine="kokoro")],
        markers=[{"id": "m1", "time": 0, "duration": 10, "title": "Chapter One"}],
    )
    pub = client.post("/api/project/publish", json={"project": project})
    assert pub.status_code == 200

    toc = client.get("/api/project/toc").json()
    assert toc["chapters"][0]["title"] == "Chapter One"

    text = client.get("/api/project/toc?format=text")
    assert text.status_code == 200
    assert text.headers["content-type"].startswith("text/plain")
    assert "PRODUCTION TOC v1" in text.text

    detail = client.get("/api/project/toc?chapter=1&format=text")
    assert detail.status_code == 200 and "clip-a" in detail.text
    assert client.get("/api/project/toc?chapter=9").status_code == 404
