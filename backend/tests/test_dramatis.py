"""Story Stage bridge: dramatis bookshelf, book detail, un-mixed export reads.

Everything here drives the real bridge code over a real (tmp) filesystem tree
that mirrors dramatis's books/ + out/ layout — no fakes needed because the
bridge is pure reads."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

from server_utils.dramatis_bridge import (
    read_book,
    read_export,
    resolve_root,
    safe_id,
    scan_books,
)


def _write_json(p: Path, data: dict) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data), encoding="utf-8")


def _make_root(tmp_path: Path) -> Path:
    root = tmp_path / "dramatis"
    book = {
        "id": "monkeys-paw",
        "title": "The Monkey's Paw",
        "author": "W. W. Jacobs",
        "entities": [
            {"id": "narrator", "kind": "narrator", "names": []},
            {"id": "mr_white", "kind": "character", "names": ["Mr. White"],
             "visual": "Elderly Englishman by the fire."},
        ],
        "voices": {
            "kokoro": {"narrator": {"voice": "bm_george"}, "mr_white": {"voice": "am_eric"}},
            "qwen3": {"mr_white": {"design": "gruff, warm, weathered"}},
        },
        "hints": [
            {"match": "Hark at the wind", "emotion": {"unease": 0.6}},
            {"match": "plain hint no emotion"},
        ],
        "chapters": [
            {"heading": "Part I", "scenes": [{"id": "s1"}], "cues": [{"id": "c1"}], "music": []},
            {"heading": "Part II", "scenes": [], "cues": [], "music": []},
        ],
    }
    _write_json(root / "books" / "monkeys-paw" / "book.json", book)

    wav = root / "out" / "cache" / "line0.wav"
    wav.parent.mkdir(parents=True, exist_ok=True)
    wav.write_bytes(b"RIFF")
    sfx = root / "out" / "cache" / "cue0.wav"
    sfx.write_bytes(b"RIFF")
    export = {
        "version": 1,
        "book": "monkeys-paw",
        "chapter": "Part I",
        "durationSec": 638.82,
        "stemGains": {"ambience": -16, "sfx": -6, "music": -20},
        "entities": book["entities"],
        "scenes": [{"id": "s1", "start": 1.0, "end": 96.9, "visual": "Parlour at night", "ambience": "silence"}],
        "lines": [
            {"id": "lin_0000", "entity": "narrator", "start": 1.0, "dur": 24.9,
             "text": "Without, the night was cold and wet.", "wav": str(wav)},
            {"id": "lin_0001", "entity": "mr_white", "start": 26.3, "dur": 3.1,
             "text": "Hark at the wind.", "wav": str(root / "out" / "cache" / "GONE.wav")},
        ],
        "cues": [
            {"id": "p1-fire", "sfx": "fireplace fire crackling", "at": 7.8, "dur": 18.0,
             "file": str(sfx), "confidence": 0.94, "gainDb": -15},
        ],
        "beds": [],
        "music": [],
    }
    _write_json(root / "out" / "monkeys-paw" / "ch-01" / "dd-elements.json", export)
    return root


class TestResolveRoot:
    def test_configured_root_wins_when_valid(self, tmp_path):
        root = _make_root(tmp_path)
        assert resolve_root(str(root)) == root

    def test_invalid_configured_root_resolves_none(self, tmp_path):
        assert resolve_root(str(tmp_path / "nope")) is None

    def test_blank_setting_falls_back_to_defaults_only(self, tmp_path):
        # Blank setting scans DEFAULT_ROOTS — whatever this machine has, the
        # result must be a books/ dir or None, never a bogus path.
        got = resolve_root("")
        assert got is None or (got / "books").is_dir()


class TestScanBooks:
    def test_bookshelf_reports_chapter_artifact_state(self, tmp_path):
        root = _make_root(tmp_path)
        books = scan_books(root)
        assert len(books) == 1
        b = books[0]
        assert b["id"] == "monkeys-paw"
        assert b["characters"] == 1
        ch1, ch2 = b["chapters"]
        assert ch1["rendered"] is True and ch1["lines"] == 2 and ch1["cues"] == 1
        assert ch1["durationSec"] == 638.82
        assert ch2["rendered"] is False and ch2["lines"] is None

    def test_stale_export_flagged_when_book_config_newer(self, tmp_path):
        root = _make_root(tmp_path)
        dd = root / "out" / "monkeys-paw" / "ch-01" / "dd-elements.json"
        old = time.time() - 3600
        os.utime(dd, (old, old))
        books = scan_books(root)
        assert books[0]["chapters"][0]["stale"] is True

    def test_junk_book_dir_skipped(self, tmp_path):
        root = _make_root(tmp_path)
        (root / "books" / "broken").mkdir()
        (root / "books" / "broken" / "book.json").write_text("not json", encoding="utf-8")
        assert [b["id"] for b in scan_books(root)] == ["monkeys-paw"]


class TestReadBook:
    def test_cast_carries_visuals_and_voice_coverage(self, tmp_path):
        root = _make_root(tmp_path)
        book = read_book(root, "monkeys-paw")
        assert book is not None
        white = next(e for e in book["entities"] if e["id"] == "mr_white")
        assert white["visual"] == "Elderly Englishman by the fire."
        assert set(white["voices"]) == {"kokoro", "qwen3"}
        narrator = next(e for e in book["entities"] if e["id"] == "narrator")
        assert set(narrator["voices"]) == {"kokoro"}

    def test_cost_card_is_honest(self, tmp_path):
        root = _make_root(tmp_path)
        book = read_book(root, "monkeys-paw")
        assert book is not None
        assert book["heroLines"] == 1  # only the emotion-carrying hint
        assert book["cost"]["localUsd"] == 0.0
        assert book["cost"]["localPts"] == 0
        assert book["cost"]["heroEstUsd"] > 0

    def test_missing_book_is_none(self, tmp_path):
        root = _make_root(tmp_path)
        assert read_book(root, "ghost") is None


class TestReadExport:
    def test_missing_media_flagged_never_dropped(self, tmp_path):
        root = _make_root(tmp_path)
        data = read_export(root, "monkeys-paw", 1)
        assert data is not None
        assert len(data["lines"]) == 2  # the broken line is still there
        gone = next(l for l in data["lines"] if l["id"] == "lin_0001")
        assert gone.get("missing") is True
        ok = next(l for l in data["lines"] if l["id"] == "lin_0000")
        assert "missing" not in ok
        assert data["media"] == {"total": 3, "missing": 1}

    def test_unrendered_chapter_is_none(self, tmp_path):
        root = _make_root(tmp_path)
        assert read_export(root, "monkeys-paw", 2) is None


class TestSafeId:
    def test_normal_ids_pass(self):
        assert safe_id("monkeys-paw")
        assert safe_id("the-signal-man")

    def test_traversal_and_separators_refused(self):
        for bad in ("..", "../books", "a/b", "a\\b", "", ".hidden".replace(".hidden", "..hidden.."), "-lead"):
            assert not safe_id(bad), bad


class TestRoutes:
    def test_status_reports_unavailable_for_bogus_root(self, client):
        r = client.post("/api/settings", json={"dramatis_root": "Z:/definitely/not/here"})
        assert r.status_code == 200
        r = client.get("/api/dramatis/status")
        assert r.status_code == 200
        body = r.json()
        assert body["available"] is False
        assert body["books"] == []
        assert body["configuredRoot"] == "Z:/definitely/not/here"

    def test_status_and_export_over_real_tree(self, client, tmp_path):
        root = _make_root(tmp_path)
        r = client.post("/api/settings", json={"dramatis_root": str(root)})
        assert r.status_code == 200
        body = client.get("/api/dramatis/status").json()
        assert body["available"] is True and len(body["books"]) == 1
        book = client.get("/api/dramatis/book/monkeys-paw")
        assert book.status_code == 200
        assert book.json()["title"] == "The Monkey's Paw"
        export = client.get("/api/dramatis/export/monkeys-paw/1")
        assert export.status_code == 200
        assert export.json()["media"]["missing"] == 1

    def test_unrendered_export_404s_with_guidance(self, client, tmp_path):
        root = _make_root(tmp_path)
        client.post("/api/settings", json={"dramatis_root": str(root)})
        r = client.get("/api/dramatis/export/monkeys-paw/2")
        assert r.status_code == 404
        # The app's HTTPError handler serializes as {"error": ...}
        assert "render the chapter" in r.json()["error"].lower()
