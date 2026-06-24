"""LIVE paid test: Seedance 2.0 reference-to-video via the real production client code.

Reads the user's FAL_KEY from directors-palette-v2/.env.local (never printed), uploads a
reference image through FalUploadClientImpl, then runs reference-to-video through
FalVideoClientImpl. This exercises the exact Phase-1 path: upload -> image_urls -> output.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # backend/ on path

from services.http_client.http_client_impl import HTTPClientImpl
from services.upload_client.fal_upload_client_impl import FalUploadClientImpl
from services.fal_video_client.fal_video_client_impl import FalVideoClientImpl


def _read_fal_key() -> str:
    env = Path(r"D:/git/directors-palette-v2/.env.local")
    for line in env.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("FAL_KEY"):
            _, _, value = line.partition("=")
            return value.strip().strip('"').strip("'")
    raise SystemExit("FAL_KEY not found")


def main() -> None:
    key = _read_fal_key()
    print(f"FAL key loaded (len={len(key)}, masked={key[:4]}...{key[-3:]})")

    # Synthesize a clearly-benign landscape reference (avoids fal's people/content filter).
    from PIL import Image, ImageDraw

    ref_image = Path(__file__).parent / "live_ref_landscape.png"
    img = Image.new("RGB", (768, 432))
    draw = ImageDraw.Draw(img)
    for y in range(432):  # sky gradient
        t = y / 432
        draw.line([(0, y), (768, y)], fill=(int(90 + 120 * t), int(150 + 80 * t), 235))
    draw.rectangle([0, 300, 768, 432], fill=(70, 140, 70))  # green field
    draw.ellipse([600, 50, 700, 150], fill=(255, 240, 180))  # sun
    img.save(ref_image)
    print(f"reference image: {ref_image.name} ({ref_image.stat().st_size} bytes, synthetic landscape)")

    http = HTTPClientImpl()
    uploader = FalUploadClientImpl(http=http)
    video_client = FalVideoClientImpl(http=http)

    print("1/2 uploading reference image to fal storage ...")
    url = uploader.upload(
        api_key=key, data=ref_image.read_bytes(), content_type="image/png", file_name=ref_image.name
    )
    print(f"    -> hosted URL: {url[:70]}...")

    print("2/2 submitting seedance-2.0-fast reference-to-video (480p, 4s) and polling ...")
    video_bytes = video_client.generate_video(
        api_key=key,
        model="seedance-2.0-fast",
        prompt="gentle clouds drift across the sky over a green field, sun shining, calm cinematic landscape",
        duration=4,
        resolution="480p",
        aspect_ratio="16:9",
        generate_audio=False,
        reference_images=[url],
    )

    out = Path(__file__).parent / "live_ref_to_video_result.mp4"
    out.write_bytes(video_bytes)
    print(f"SUCCESS: wrote {out.name} ({len(video_bytes)} bytes)")
    if len(video_bytes) < 10_000:
        print("WARNING: output suspiciously small", file=sys.stderr)


if __name__ == "__main__":
    main()
