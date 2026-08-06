"""Local video LoRAs: drop a .safetensors into the loras dir and it shows
up in the picker — with a thumbnail and trigger words when sidecars exist.

LoRAs are architecture-specific, so the dir is ENGINE-SCOPED by subfolder:
    loras/*.safetensors        LTX-2.3 LoRAs (family "ltx" — the original convention)
    loras/h3/*.safetensors     MiniMax H3 LoRAs (family "h3")
    loras/flux/*.safetensors   Flux image LoRAs (family "flux")
Each listing entry carries its ``family`` and each picker filters to its own
engine — an H3 file can never appear pickable on the LTX engine.

Sidecar convention (all optional, all beside the weights file, any family):
    CozyFelt.safetensors      the LoRA itself
    CozyFelt.png/.jpg/...     thumbnail (or thumbnails/CozyFelt.*)
    CozyFelt.txt              trigger words (first line)
    CozyFelt.json             {"trigger_phrase" | "default_caption" | "instance_prompt"}

Pure filesystem reads, junk-tolerant — a broken sidecar degrades that one
field, never the listing.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, cast

_THUMB_EXTS = (".png", ".jpg", ".jpeg", ".webp")
_TRIGGER_KEYS = ("trigger_phrase", "default_caption", "instance_prompt")
_SAFE_FILE = re.compile(r"^[^\\/]+\.safetensors$", re.IGNORECASE)


def safe_lora_file(name: str) -> bool:
    """Bare *.safetensors filename only — route params become paths."""
    return bool(_SAFE_FILE.match(name)) and ".." not in name


def _sidecar_thumbnail(loras_dir: Path, stem: str) -> str | None:
    for ext in _THUMB_EXTS:
        for cand in (loras_dir / f"{stem}{ext}", loras_dir / "thumbnails" / f"{stem}{ext}"):
            if cand.is_file():
                return str(cand)
    return None


def _sidecar_trigger(loras_dir: Path, stem: str) -> str | None:
    txt = loras_dir / f"{stem}.txt"
    if txt.is_file():
        try:
            first = txt.read_text(encoding="utf-8", errors="replace").strip().splitlines()
            if first and first[0].strip():
                return first[0].strip()[:300]
        except OSError:
            pass
    js = loras_dir / f"{stem}.json"
    if js.is_file():
        try:
            raw: Any = json.loads(js.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if isinstance(raw, dict):
            data = cast("dict[str, Any]", raw)
            for key in _TRIGGER_KEYS:
                value = data.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()[:300]
    return None


_FAMILY_SUBDIRS = ("h3", "flux")


def _scan_family(scan_dir: Path, family: str, file_prefix: str) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    try:
        files = sorted(scan_dir.iterdir())
    except OSError:
        return entries
    for f in files:
        if f.suffix.lower() != ".safetensors" or not f.is_file():
            continue
        try:
            size = f.stat().st_size
        except OSError:
            size = 0
        entries.append({
            "file": f"{file_prefix}{f.name}",
            "name": f.stem,
            "sizeBytes": size,
            "family": family,
            "thumbnail": _sidecar_thumbnail(scan_dir, f.stem),
            "trigger": _sidecar_trigger(scan_dir, f.stem),
        })
    return entries


def list_local_ltx_loras(loras_dir: Path) -> list[dict[str, Any]]:
    """Every *.safetensors in the dir, with resolved sidecars and its engine
    family: top-level files are LTX (the original convention — their bare file
    name doubles as the ComfyUI lora_name, so nothing downstream changes),
    while ``h3/`` and ``flux/`` subfolders hold other architectures. Family
    subdir entries carry a ``<family>/`` prefix on ``file`` so a future engine
    can stage them by name the same way."""
    entries = _scan_family(loras_dir, "ltx", "")
    for family in _FAMILY_SUBDIRS:
        entries.extend(_scan_family(loras_dir / family, family, f"{family}/"))
    return entries


def set_lora_thumbnail(loras_dir: Path, lora_file: str, image_path: str) -> str | None:
    """Copy an image beside the LoRA as <stem>.png (the sidecar convention).
    Returns the new thumbnail path, or None when inputs don't qualify."""
    if not safe_lora_file(lora_file):
        return None
    if not (loras_dir / lora_file).is_file():
        return None
    src = Path(image_path)
    if not src.is_file():
        return None
    dst = loras_dir / f"{Path(lora_file).stem}.png"
    try:
        dst.write_bytes(src.read_bytes())
    except OSError:
        return None
    return str(dst)
