"""Generate looping videos from images using LTX 2.3 DistilledPipeline + ping-pong.

Uses the distilled model (8+3 steps) for fast image-to-video, then reverses and
concatenates to create a seamless ping-pong loop.

Usage:
    cd backend
    .venv/Scripts/python.exe scripts/generate_loops.py \
        --input-dir "D:/path/to/images" \
        --output-dir "D:/path/to/output" \
        --prompt "Slow subtle cinematic movement, gentle atmospheric drift"
"""

from __future__ import annotations

import argparse
import glob
import logging
import os
import subprocess
import sys
import tempfile
import time

import torch

import ltx_core.loader  # must come first to avoid circular import
from ltx_core.quantization import QuantizationPolicy
from ltx_core.model.video_vae import TilingConfig, get_video_chunks_number
from ltx_pipelines.distilled import DistilledPipeline
from ltx_pipelines.utils.args import ImageConditioningInput
from ltx_pipelines.utils.media_io import encode_video

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Generate looping videos from images (fast distilled + ping-pong)")
    p.add_argument("--input-dir", required=True, help="Directory of input images (.png/.jpg)")
    p.add_argument("--output-dir", required=True, help="Directory for output .mp4 files")
    p.add_argument("--prompt", default="Slow subtle cinematic movement, gentle atmospheric drift")
    p.add_argument("--num-frames", type=int, default=97, help="Total frames for forward clip (must be 8k+1)")
    p.add_argument("--height", type=int, default=448, help="Output height (divisible by 64)")
    p.add_argument("--width", type=int, default=768, help="Output width (divisible by 64)")
    p.add_argument("--fps", type=float, default=24.0)
    p.add_argument("--seed", type=int, default=42)
    return p.parse_args()


def pingpong_with_ffmpeg(forward_path: str, output_path: str) -> None:
    """Create a seamless ping-pong loop: forward + reversed (minus duplicate frames)."""
    cmd = [
        "ffmpeg", "-y",
        "-i", forward_path,
        "-filter_complex",
        "[0:v]split[fwd][rev];[rev]reverse[reversed];[fwd][reversed]concat=n=2:v=1:a=0[out]",
        "-map", "[out]",
        "-c:v", "libx264", "-crf", "18", "-preset", "fast",
        "-pix_fmt", "yuv420p",
        output_path,
    ]
    subprocess.run(cmd, check=True, capture_output=True)


@torch.inference_mode()
def main() -> None:
    args = parse_args()

    models_dir = os.path.join(os.environ.get("LOCALAPPDATA", ""), "LTXDesktop", "models")

    distilled_ckpt = os.path.join(models_dir, "ltx-2.3-22b-distilled.safetensors")
    upsampler = os.path.join(models_dir, "ltx-2.3-spatial-upscaler-x2-1.0.safetensors")
    gemma_root = os.path.join(models_dir, "gemma-3-12b-it-qat-q4_0-unquantized")

    for name, path in [("distilled_ckpt", distilled_ckpt), ("upsampler", upsampler), ("gemma_root", gemma_root)]:
        if not os.path.exists(path):
            logger.error("Missing %s: %s", name, path)
            sys.exit(1)

    # Collect images
    images = sorted(
        glob.glob(os.path.join(args.input_dir, "*.png"))
        + glob.glob(os.path.join(args.input_dir, "*.jpg"))
        + glob.glob(os.path.join(args.input_dir, "*.jpeg"))
    )
    if not images:
        logger.error("No images found in %s", args.input_dir)
        sys.exit(1)

    os.makedirs(args.output_dir, exist_ok=True)
    logger.info("Found %d images, output -> %s", len(images), args.output_dir)
    logger.info("Settings: %dx%d, %d frames (%.1fs forward, %.1fs ping-pong loop)",
                args.width, args.height, args.num_frames,
                args.num_frames / args.fps, args.num_frames * 2 / args.fps)

    device = torch.device("cuda")

    logger.info("Loading DistilledPipeline (FP8)...")
    t0 = time.perf_counter()
    pipeline = DistilledPipeline(
        distilled_checkpoint_path=distilled_ckpt,
        spatial_upsampler_path=upsampler,
        gemma_root=gemma_root,
        loras=[],
        device=device,
        quantization=QuantizationPolicy.fp8_cast(),
    )
    logger.info("Pipeline loaded in %.1fs", time.perf_counter() - t0)

    tiling_config = TilingConfig.default()
    video_chunks = get_video_chunks_number(args.num_frames, tiling_config)

    for i, img_path in enumerate(images):
        name = os.path.splitext(os.path.basename(img_path))[0]
        out_path = os.path.join(args.output_dir, f"{name}_loop.mp4")

        if os.path.exists(out_path):
            logger.info("[%d/%d] Skipping %s (already exists)", i + 1, len(images), name)
            continue

        logger.info("[%d/%d] Generating loop for %s...", i + 1, len(images), name)
        t1 = time.perf_counter()

        keyframes = [
            ImageConditioningInput(path=img_path, frame_idx=0, strength=0.95),
        ]

        try:
            video, audio = pipeline(
                prompt=args.prompt,
                seed=args.seed,
                height=args.height,
                width=args.width,
                num_frames=args.num_frames,
                frame_rate=args.fps,
                images=keyframes,
                tiling_config=tiling_config,
            )

            # Write forward clip to temp file
            fwd_path = tempfile.mktemp(suffix=".mp4")
            encode_video(
                video=video,
                fps=args.fps,
                audio=audio,
                output_path=fwd_path,
                video_chunks_number=video_chunks,
            )

            gen_elapsed = time.perf_counter() - t1
            logger.info("[%d/%d] Forward clip done in %.1fs, creating ping-pong...", i + 1, len(images), gen_elapsed)

            # Create ping-pong loop
            pingpong_with_ffmpeg(fwd_path, out_path)
            os.unlink(fwd_path)

            elapsed = time.perf_counter() - t1
            logger.info("[%d/%d] Done: %s (%.1fs total)", i + 1, len(images), out_path, elapsed)

        except Exception:
            logger.exception("[%d/%d] FAILED: %s", i + 1, len(images), name)
            continue

    logger.info("All done!")


if __name__ == "__main__":
    main()
