"""Drop-a-file local LTX LoRA discovery: scan, sidecars, junk tolerance."""
from __future__ import annotations

import json
from pathlib import Path

from server_utils.ltx_local_loras import (
    list_local_ltx_loras,
    safe_lora_file,
    set_lora_thumbnail,
)


def _make_dir(tmp_path: Path) -> Path:
    d = tmp_path / "loras"
    d.mkdir()
    (d / "CozyFelt.safetensors").write_bytes(b"weights")
    (d / "CozyFelt.txt").write_text("F3ltCut0u7, felt cutout style\nsecond line ignored", encoding="utf-8")
    (d / "Plain.safetensors").write_bytes(b"weights")
    (d / "notes.md").write_text("junk", encoding="utf-8")
    return d


class TestScan:
    def test_lists_safetensors_with_sidecars(self, tmp_path):
        d = _make_dir(tmp_path)
        (d / "CozyFelt.png").write_bytes(b"\x89PNG")
        entries = list_local_ltx_loras(d)
        assert [e["file"] for e in entries] == ["CozyFelt.safetensors", "Plain.safetensors"]
        felt = entries[0]
        assert felt["name"] == "CozyFelt"
        assert felt["trigger"] == "F3ltCut0u7, felt cutout style"
        assert felt["thumbnail"] and felt["thumbnail"].endswith("CozyFelt.png")
        plain = entries[1]
        assert plain["thumbnail"] is None and plain["trigger"] is None

    def test_thumbnails_subdir_is_second_candidate(self, tmp_path):
        d = _make_dir(tmp_path)
        (d / "thumbnails").mkdir()
        (d / "thumbnails" / "Plain.jpg").write_bytes(b"jpg")
        entries = list_local_ltx_loras(d)
        plain = next(e for e in entries if e["name"] == "Plain")
        assert plain["thumbnail"].endswith("Plain.jpg")

    def test_json_sidecar_trigger_keys(self, tmp_path):
        d = _make_dir(tmp_path)
        (d / "Plain.json").write_text(json.dumps({"trigger_phrase": "plainstyle"}), encoding="utf-8")
        entries = list_local_ltx_loras(d)
        plain = next(e for e in entries if e["name"] == "Plain")
        assert plain["trigger"] == "plainstyle"

    def test_broken_sidecar_degrades_that_field_only(self, tmp_path):
        d = _make_dir(tmp_path)
        (d / "Plain.json").write_text("{not json", encoding="utf-8")
        entries = list_local_ltx_loras(d)
        plain = next(e for e in entries if e["name"] == "Plain")
        assert plain["trigger"] is None  # listing survives

    def test_missing_dir_returns_empty(self, tmp_path):
        assert list_local_ltx_loras(tmp_path / "nope") == []

    def test_top_level_files_are_family_ltx(self, tmp_path):
        d = _make_dir(tmp_path)
        assert all(e["family"] == "ltx" for e in list_local_ltx_loras(d))

    def test_family_subdirs_scan_with_prefix_and_own_sidecars(self, tmp_path):
        d = _make_dir(tmp_path)
        h3 = d / "h3"
        h3.mkdir()
        (h3 / "TurboStyle.safetensors").write_bytes(b"weights")
        (h3 / "TurboStyle.txt").write_text("turbo trigger", encoding="utf-8")
        (h3 / "TurboStyle.png").write_bytes(b"\x89PNG")
        entries = list_local_ltx_loras(d)
        turbo = next(e for e in entries if e["name"] == "TurboStyle")
        assert turbo["family"] == "h3"
        assert turbo["file"] == "h3/TurboStyle.safetensors"  # stageable by name
        assert turbo["trigger"] == "turbo trigger"
        assert turbo["thumbnail"].endswith("TurboStyle.png")
        # LTX files stay bare — the original convention is untouched.
        assert next(e for e in entries if e["name"] == "CozyFelt")["file"] == "CozyFelt.safetensors"


class TestThumbnailAdopt:
    def test_adopts_image_as_stem_png(self, tmp_path):
        d = _make_dir(tmp_path)
        img = tmp_path / "render.png"
        img.write_bytes(b"\x89PNG imagey bytes")
        out = set_lora_thumbnail(d, "CozyFelt.safetensors", str(img))
        assert out is not None and out.endswith("CozyFelt.png")
        assert (d / "CozyFelt.png").read_bytes() == img.read_bytes()
        entries = list_local_ltx_loras(d)
        assert entries[0]["thumbnail"] == out

    def test_refuses_unknown_lora_and_traversal(self, tmp_path):
        d = _make_dir(tmp_path)
        img = tmp_path / "render.png"
        img.write_bytes(b"png")
        assert set_lora_thumbnail(d, "Ghost.safetensors", str(img)) is None
        assert set_lora_thumbnail(d, "../CozyFelt.safetensors", str(img)) is None
        assert set_lora_thumbnail(d, "CozyFelt.safetensors", str(tmp_path / "gone.png")) is None

    def test_safe_lora_file(self):
        assert safe_lora_file("CozyFelt.safetensors")
        assert not safe_lora_file("a/b.safetensors")
        assert not safe_lora_file("a\\b.safetensors")
        assert not safe_lora_file("notaweights.txt")
        assert not safe_lora_file("..\\up.safetensors")


class TestRoutes:
    def test_ltx_local_listing_route(self, client, test_state):
        # The handler's store points at a tmp models dir in tests — just assert
        # the route answers with the entries envelope.
        r = client.get("/api/lora/ltx-local")
        assert r.status_code == 200
        assert "entries" in r.json()

    def test_thumbnail_route_rejects_unknown(self, client):
        r = client.post("/api/lora/ltx-local/thumbnail", json={
            "file": "Ghost.safetensors", "imagePath": "Z:/nope.png",
        })
        assert r.status_code == 400
