"""Live smoke test for the Seedance cloud video clients.

Runs REAL generations against Replicate (Seedance 1.5) and, if a fal key is set,
fal (Seedance 2.0), using the actual production client + HTTP layer. Keeps it cheap
(2s clips). Run from backend/:  uv run python scripts/live_seedance_test.py
"""

from __future__ import annotations

import base64
import json
import sys
import time
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image, ImageDraw

from services.http_client.http_client_impl import HTTPClientImpl
from services.video_api_client.replicate_video_client_impl import ReplicateVideoClientImpl
from services.fal_video_client.fal_video_client_impl import FalVideoClientImpl

OUT = Path(__file__).resolve().parent / "live_out"
OUT.mkdir(exist_ok=True)
SETTINGS = Path.home() / "AppData" / "Local" / "LTXDesktop" / "settings.json"


def _keys() -> dict[str, str]:
    data = json.loads(SETTINGS.read_text(encoding="utf-8"))
    return {
        "replicate": (data.get("replicate_api_key") or "").strip(),
        "fal": (data.get("fal_api_key") or "").strip(),
    }


def _frame(label: str, cx: int, cy: int) -> str:
    """A 1280x720 dark frame with a labeled white ball — distinct start vs end."""
    img = Image.new("RGB", (1280, 720), (12, 14, 28))
    d = ImageDraw.Draw(img)
    d.ellipse([cx - 90, cy - 90, cx + 90, cy + 90], fill=(240, 240, 255))
    d.text((40, 40), label, fill=(180, 200, 255))
    buf = BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _save(name: str, blob: bytes) -> None:
    p = OUT / name
    p.write_bytes(blob)
    head = blob[:12]
    is_mp4 = b"ftyp" in head or head[4:8] == b"ftyp"
    print(f"  -> wrote {p}  ({len(blob):,} bytes)  mp4_header={is_mp4}")


def test_replicate_first_last(key: str) -> None:
    print("\n[Seedance 1.5 / Replicate] first + last frame, 2s ...")
    client = ReplicateVideoClientImpl(http=HTTPClientImpl())
    start = _frame("START", 220, 560)   # ball lower-left
    end = _frame("END", 1060, 160)      # ball upper-right
    t0 = time.monotonic()
    blob = client.generate_video(
        api_key=key,
        model="seedance-1.5-pro",
        prompt="a glowing orb smoothly arcs from the lower-left to the upper-right, cinematic",
        duration=5,
        resolution="720p",
        aspect_ratio="16:9",
        generate_audio=False,
        first_frame=start,
        last_frame=end,
        seed=12345,
    )
    print(f"  done in {time.monotonic() - t0:.1f}s")
    _save("seedance15_first_last.mp4", blob)


def test_replicate_t2v(key: str) -> None:
    print("\n[Seedance 1.5 / Replicate] text-to-video, 2s ...")
    client = ReplicateVideoClientImpl(http=HTTPClientImpl())
    t0 = time.monotonic()
    blob = client.generate_video(
        api_key=key,
        model="seedance-1.5-pro",
        prompt="a calm ocean at sunset, gentle waves, cinematic",
        duration=5,
        resolution="720p",
        aspect_ratio="16:9",
        generate_audio=False,
        seed=777,
    )
    print(f"  done in {time.monotonic() - t0:.1f}s")
    _save("seedance15_t2v.mp4", blob)


def test_fal(key: str) -> None:
    print("\n[Seedance 2.0 / fal] first + last frame, 4s ...")
    client = FalVideoClientImpl(http=HTTPClientImpl())
    start = _frame("START", 220, 560)
    end = _frame("END", 1060, 160)
    t0 = time.monotonic()
    blob = client.generate_video(
        api_key=key,
        model="seedance-2.0",
        prompt="a glowing orb smoothly arcs from the lower-left to the upper-right, cinematic",
        duration=4,
        resolution="720p",
        aspect_ratio="16:9",
        generate_audio=False,
        first_frame=start,
        last_frame=end,
        seed=12345,
    )
    print(f"  done in {time.monotonic() - t0:.1f}s")
    _save("seedance20_first_last.mp4", blob)


def main() -> None:
    keys = _keys()
    if keys["replicate"]:
        try:
            test_replicate_first_last(keys["replicate"])
        except Exception as exc:
            print(f"  REPLICATE first/last FAILED: {type(exc).__name__}: {exc}")
        try:
            test_replicate_t2v(keys["replicate"])
        except Exception as exc:
            print(f"  REPLICATE t2v FAILED: {type(exc).__name__}: {exc}")
    else:
        print("No Replicate key configured — skipping Seedance 1.5 live test.")

    if keys["fal"]:
        try:
            test_fal(keys["fal"])
        except Exception as exc:
            print(f"  FAL FAILED: {type(exc).__name__}: {exc}")
    else:
        print("\nNo fal key configured — skipping Seedance 2.0 live test.")


if __name__ == "__main__":
    main()
