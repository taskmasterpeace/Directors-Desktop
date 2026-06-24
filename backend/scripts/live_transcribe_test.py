"""LIVE paid test: word-level transcription via the real Replicate whisper API.

Mirrors TranscriptionHandler._run_prediction / _parse_output exactly (same model, same
input, same parsing) but calls HTTPClientImpl directly to avoid the handlers-package import
cycle when run as a standalone script. Reads REPLICATE_API_TOKEN from .env (never printed).
"""

from __future__ import annotations

import base64
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # backend/ on path

from services.http_client.http_client_impl import HTTPClientImpl

_MODEL = "vaibhavs10/incredibly-fast-whisper"
_BASE = "https://api.replicate.com/v1"


def _read_replicate_key() -> str:
    env = Path(r"D:/git/directors-palette-v2/.env.local")
    for line in env.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("REPLICATE_API_TOKEN"):
            return line.partition("=")[2].strip().strip('"').strip("'")
    raise SystemExit("REPLICATE_API_TOKEN not found")


def main() -> None:
    key = _read_replicate_key()
    print(f"Replicate key loaded (len={len(key)}, masked={key[:4]}...{key[-3:]})")

    audio = Path(r"D:/git/mkm/ad-lab/output/education/voiceover-education-45s.mp3")
    if not audio.exists():
        raise SystemExit(f"audio missing: {audio}")
    print(f"audio: {audio.name} ({audio.stat().st_size} bytes)")

    b64 = base64.b64encode(audio.read_bytes()).decode("ascii")
    data_uri = f"data:audio/mpeg;base64,{b64}"
    http = HTTPClientImpl()

    # Resolve latest version (community model needs /v1/predictions + version, not the shortcut).
    mv = http.get(f"{_BASE}/models/{_MODEL}", headers={"Authorization": f"Bearer {key}"}, timeout=30)
    version = mv.json()["latest_version"]["id"]
    print(f"resolved version: {version[:16]}...")

    print("transcribing (real Replicate incredibly-fast-whisper, timestamp=word) ...")
    resp = http.post(
        f"{_BASE}/predictions",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "Prefer": "wait"},
        json_payload={"version": version, "input": {"audio": data_uri, "task": "transcribe", "timestamp": "word"}},
        timeout=300,
    )
    print(f"HTTP {resp.status_code}")
    if resp.status_code not in (200, 201):
        raise SystemExit(f"submit failed: {resp.text[:600]}")
    data = resp.json()
    print(f"keys={list(data.keys())} status={data.get('status')}")
    # poll if not done synchronously
    import time as _t
    status = data.get("status")
    get_url = (data.get("urls") or {}).get("get")
    while status not in ("succeeded", "failed", "canceled"):
        if not get_url:
            raise SystemExit(f"no poll url; raw={str(data)[:600]}")
        _t.sleep(2)
        poll = http.get(get_url, headers={"Authorization": f"Bearer {key}"}, timeout=30)
        data = poll.json()
        status = data.get("status")

    if status != "succeeded":
        raise SystemExit(f"transcription {status}: {data.get('error')}")

    out = data.get("output", {})
    chunks = out.get("chunks", []) if isinstance(out, dict) else []
    words = [
        {"text": c.get("text", "").strip(), "start": c["timestamp"][0], "end": c["timestamp"][1]}
        for c in chunks
        if isinstance(c.get("timestamp"), list) and len(c["timestamp"]) == 2 and c["timestamp"][0] is not None
    ]
    print(f"SUCCESS: {len(words)} words")
    print("first words:", " ".join(w["text"] for w in words[:18]))
    if words:
        w = words[0]
        print(f"first word timing: {w['text']!r} @ {w['start']}s-{w['end']}s")


if __name__ == "__main__":
    main()
