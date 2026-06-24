"""LIVE practice: the image→video (i2v) handoff the transcript chain depends on.

Uploads a still image to fal, then runs Seedance i2v with it as the FIRST FRAME (the same
handoff the queue does when the transcript chain feeds a generated image into a video job).
Reads FAL_KEY from directors-palette-v2/.env.local (never printed).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.http_client.http_client_impl import HTTPClientImpl
from services.upload_client.fal_upload_client_impl import FalUploadClientImpl
from services.fal_video_client.fal_video_client_impl import FalVideoClientImpl


def _read_fal_key() -> str:
    env = Path(r"D:/git/directors-palette-v2/.env.local")
    for line in env.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("FAL_KEY"):
            return line.partition("=")[2].strip().strip('"').strip("'")
    raise SystemExit("FAL_KEY not found")


def main() -> None:
    key = _read_fal_key()
    print(f"FAL key loaded (len={len(key)})")

    # Reuse the synthetic landscape from the ref test, or make one.
    from PIL import Image, ImageDraw

    img_path = Path(__file__).parent / "live_ref_landscape.png"
    if not img_path.exists():
        img = Image.new("RGB", (768, 432))
        d = ImageDraw.Draw(img)
        for y in range(432):
            t = y / 432
            d.line([(0, y), (768, y)], fill=(int(90 + 120 * t), int(150 + 80 * t), 235))
        d.rectangle([0, 300, 768, 432], fill=(70, 140, 70))
        d.ellipse([600, 50, 700, 150], fill=(255, 240, 180))
        img.save(img_path)
    print(f"first-frame image: {img_path.name} ({img_path.stat().st_size} bytes)")

    http = HTTPClientImpl()
    url = FalUploadClientImpl(http=http).upload(
        api_key=key, data=img_path.read_bytes(), content_type="image/png", file_name=img_path.name
    )
    print(f"uploaded -> {url[:64]}...")

    print("running seedance-2.0-fast IMAGE-TO-VIDEO (image as first frame, 480p, 4s) …")
    video = FalVideoClientImpl(http=http).generate_video(
        api_key=key,
        model="seedance-2.0-fast",
        prompt="gentle clouds drift across the sky, sun shining over a calm green field",
        duration=4,
        resolution="480p",
        aspect_ratio="16:9",
        generate_audio=False,
        first_frame=url,  # i2v handoff
    )
    out = Path(__file__).parent / "live_i2v_result.mp4"
    out.write_bytes(video)
    print(f"SUCCESS: i2v produced {out.name} ({len(video)} bytes)")


if __name__ == "__main__":
    main()
