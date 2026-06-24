"""Comprehensive benchmark: images (NF4 + LoRA), video, and chain-extend.

Run: cd backend && uv run python scripts/benchmark_all.py

Tests all generation capabilities on RTX 4090 24GB.

Image tests run directly (standalone FLUX Klein NF4 pipeline).
Video tests require the backend server running on localhost:8000.
"""

import gc
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import torch

# --- Config ---
MODELS_DIR = "C:/Users/taskm/AppData/Local/LTXDesktop/models"
FLUX_MODEL = f"{MODELS_DIR}/FLUX.2-klein-base-9B"
LORA_PATH = f"{MODELS_DIR}/loras/jRB4slNlO3KYd18ROU5Up_pytorch_lora_weights_comfy_converted.safetensors"
OUTPUT_DIR = Path("D:/git/directors-desktop/backend/outputs/benchmarks")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

BACKEND_URL = "http://localhost:8000"


@dataclass
class BenchResult:
    name: str
    status: str = "skipped"
    total_time: float = 0.0
    peak_vram_mb: float = 0.0
    output_path: str = ""
    details: dict[str, float] = field(default_factory=dict)
    error: str = ""


results: list[BenchResult] = []


def reset_gpu():
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()


def peak_vram_mb() -> float:
    return torch.cuda.max_memory_allocated() / 1024**2


def print_header(title: str):
    print(f"\n{'='*70}")
    print(f"  {title}")
    print(f"{'='*70}")


# =============================================================
# IMAGE HELPERS
# =============================================================
def _load_flux_nf4():
    """Load FLUX Klein with NF4 quantization + CPU offload."""
    from diffusers import BitsAndBytesConfig, Flux2KleinPipeline, PipelineQuantizationConfig

    nf4_config = BitsAndBytesConfig(
        load_in_4bit=True, bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
    )
    quant_config = PipelineQuantizationConfig(quant_mapping={"transformer": nf4_config})

    pipe = Flux2KleinPipeline.from_pretrained(
        FLUX_MODEL, quantization_config=quant_config,
        torch_dtype=torch.bfloat16, low_cpu_mem_usage=True,
    )
    pipe.enable_model_cpu_offload()
    return pipe


def _decode_latents(latents):
    """Decode latents with fresh VAE on CPU."""
    from diffusers import AutoencoderKL
    import numpy as np
    from PIL import Image

    vae_path = str(Path(FLUX_MODEL) / "vae")
    vae = AutoencoderKL.from_pretrained(vae_path, torch_dtype=torch.float32)
    vae = vae.to("cpu")
    vae.eval()
    with torch.no_grad():
        decoded = vae.decode(latents.to(torch.float32), return_dict=False)[0]
    decoded = (decoded / 2 + 0.5).clamp(0, 1)
    arr = decoded[0].permute(1, 2, 0).numpy()
    pil = Image.fromarray((arr * 255).astype(np.uint8))
    del vae, decoded
    gc.collect()
    return pil


def _run_image_bench(name: str, prompt: str, w: int, h: int, steps: int = 28,
                     lora: bool = False, seed: int = 42):
    """Run a single image generation benchmark."""
    r = BenchResult(name=name)
    print_header(name)
    reset_gpu()

    try:
        t0 = time.time()
        pipe = _load_flux_nf4()
        r.details["load_s"] = time.time() - t0
        print(f"  Pipeline loaded: {r.details['load_s']:.1f}s")

        if lora:
            t_lora = time.time()
            pipe.load_lora_weights(LORA_PATH, adapter_name="user_lora")
            pipe.set_adapters(["user_lora"], adapter_weights=[1.0])
            r.details["lora_load_s"] = time.time() - t_lora
            print(f"  LoRA loaded: {r.details['lora_load_s']:.1f}s")

        gen = torch.Generator(device="cpu").manual_seed(seed)
        t1 = time.time()
        output = pipe(
            prompt=prompt, height=h, width=w, guidance_scale=4.0,
            num_inference_steps=steps, generator=gen,
            output_type="latent", return_dict=True,
        )
        latents = output.images.to("cpu")
        r.details["inference_s"] = time.time() - t1
        print(f"  Inference ({steps} steps): {r.details['inference_s']:.1f}s")

        del pipe
        gc.collect()
        torch.cuda.empty_cache()

        t2 = time.time()
        pil = _decode_latents(latents)
        r.details["decode_s"] = time.time() - t2
        del latents

        safe_name = name.lower().replace(" ", "_").replace("(", "").replace(")", "").replace("+", "")
        out = str(OUTPUT_DIR / f"{safe_name}.png")
        pil.save(out)
        r.output_path = out

        r.peak_vram_mb = peak_vram_mb()
        r.total_time = sum(r.details.values())
        r.status = "pass"
        print(f"  Decode: {r.details['decode_s']:.1f}s | Total: {r.total_time:.1f}s | VRAM: {r.peak_vram_mb:.0f} MB")
    except Exception as e:
        r.status = "fail"
        r.error = str(e)
        print(f"  FAILED: {e}")
        import traceback
        traceback.print_exc()

    results.append(r)
    reset_gpu()


# =============================================================
# VIDEO HELPERS (via HTTP API)
# =============================================================
def _check_backend():
    """Check if the backend server is running."""
    import urllib.request
    try:
        resp = urllib.request.urlopen(f"{BACKEND_URL}/api/health", timeout=3)
        return resp.status == 200
    except Exception:
        return False


def _submit_video_job(prompt: str, width: int, height: int, num_frames: int,
                      seed: int = 42, num_steps: int = 30,
                      image_path: str | None = None, frame_idx: int | None = None):
    """Submit a video generation job and wait for completion. Returns (output_path, elapsed_seconds)."""
    import urllib.request

    body: dict = {
        "prompt": prompt,
        "negativePrompt": "",
        "width": width,
        "height": height,
        "numFrames": num_frames,
        "frameRate": 24,
        "numInferenceSteps": num_steps,
        "guidanceScale": 3.5,
        "seed": seed,
        "outputFormat": "mp4",
    }
    if image_path:
        body["imagePath"] = image_path
    if frame_idx is not None:
        body["frameIdx"] = frame_idx

    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{BACKEND_URL}/api/queue/submit",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    resp = urllib.request.urlopen(req, timeout=10)
    job_id = json.loads(resp.read())["jobId"]

    # Poll for completion
    t0 = time.time()
    while True:
        time.sleep(2)
        resp = urllib.request.urlopen(f"{BACKEND_URL}/api/queue/status?jobId={job_id}", timeout=5)
        status = json.loads(resp.read())
        state = status.get("status", "unknown")
        phase = status.get("phase", "")
        elapsed = time.time() - t0

        if state == "completed":
            output_path = status.get("outputPath", "")
            return output_path, elapsed
        elif state == "error":
            raise RuntimeError(f"Job failed: {status.get('error', 'unknown')}")
        elif elapsed > 600:
            raise RuntimeError(f"Job timed out after {elapsed:.0f}s (phase: {phase})")

        if int(elapsed) % 10 == 0:
            print(f"    [{elapsed:.0f}s] phase={phase} state={state}")


def _run_video_bench(name: str, prompt: str, width: int, height: int,
                     num_frames: int, seed: int = 42):
    """Run a single video generation benchmark via API."""
    r = BenchResult(name=name)
    print_header(name)

    try:
        t0 = time.time()
        output_path, elapsed = _submit_video_job(
            prompt=prompt, width=width, height=height,
            num_frames=num_frames, seed=seed,
        )
        r.details["total_s"] = elapsed
        r.total_time = elapsed
        r.output_path = output_path
        r.status = "pass"
        print(f"  Completed in {elapsed:.1f}s | Output: {output_path}")
    except Exception as e:
        r.status = "fail"
        r.error = str(e)
        print(f"  FAILED: {e}")

    results.append(r)


# =============================================================
# MAIN
# =============================================================
def main():
    print("\n" + "#" * 70)
    print("#  DIRECTORS DESKTOP - FULL CAPABILITY BENCHMARK")
    print(f"#  GPU: {torch.cuda.get_device_name(0)}")
    print(f"#  VRAM: {torch.cuda.get_device_properties(0).total_memory / 1024**3:.0f} GB")
    print(f"#  PyTorch: {torch.__version__}")
    print("#" * 70)

    sys.path.insert(0, str(Path(__file__).parent.parent))
    os.environ.setdefault("LTX_APP_DATA_DIR", "C:/Users/taskm/AppData/Local/LTXDesktop")

    backend_up = _check_backend()
    if not backend_up:
        print("\n  NOTE: Backend server not running — video tests will be skipped.")
        print("  Start the app (pnpm dev) to include video benchmarks.\n")

    # ===== IMAGE BENCHMARKS =====
    print("\n\n>>> IMAGE BENCHMARKS (FLUX Klein 9B NF4)")

    _run_image_bench(
        "FLUX txt2img 512x512",
        "A photorealistic portrait of a woman with golden hour lighting, shallow depth of field",
        512, 512,
    )

    _run_image_bench(
        "FLUX txt2img 768x768",
        "A photorealistic portrait of a woman with golden hour lighting, shallow depth of field",
        768, 768,
    )

    _run_image_bench(
        "FLUX txt2img 1024x1024",
        "A cinematic shot of a futuristic city at golden hour, towering skyscrapers with holographic billboards",
        1024, 1024,
    )

    _run_image_bench(
        "FLUX txt2img 1024x1536 portrait",
        "A full-body fashion photograph, model in elegant dress, studio lighting, clean background",
        1024, 1536,
    )

    _run_image_bench(
        "FLUX txt2img 1024x1024 + LoRA",
        "DC animation style,with bold outlines,cel-shaded & muted color palette, A powerful superhero standing on a city rooftop at sunset, dramatic lighting, cape flowing in the wind",
        1024, 1024, lora=True,
    )

    _run_image_bench(
        "FLUX txt2img 1024x1024 fast 12 steps",
        "A beautiful landscape with mountains and a lake at sunset, golden light",
        1024, 1024, steps=12,
    )

    # ===== VIDEO BENCHMARKS =====
    if backend_up:
        print("\n\n>>> VIDEO BENCHMARKS (LTX 2.3 via API)")

        _run_video_bench(
            "LTX video 512p 2s (49 frames)",
            "A drone shot flying over a tropical beach at sunset, crystal clear water",
            960, 544, 49,
        )

        _run_video_bench(
            "LTX video 512p 4s (97 frames)",
            "A cinematic timelapse of clouds rolling over mountains, golden light breaking through",
            960, 544, 97,
        )

        _run_video_bench(
            "LTX video 512p 8s (193 frames)",
            "A cinematic timelapse of clouds rolling over a mountain range, epic scale, golden hour",
            960, 544, 193,
        )

        _run_video_bench(
            "LTX video 720p 4s (97 frames)",
            "A drone shot flying over a futuristic city at night, neon lights, cinematic",
            1280, 704, 97,
        )
    else:
        for name in [
            "LTX video 512p 2s (49 frames)",
            "LTX video 512p 4s (97 frames)",
            "LTX video 512p 8s (193 frames)",
            "LTX video 720p 4s (97 frames)",
        ]:
            r = BenchResult(name=name, status="skipped", error="Backend not running")
            results.append(r)
            print(f"\n  SKIPPED: {name} (backend not running)")

    # ===== SUMMARY =====
    print("\n\n")
    print("#" * 70)
    print("#  BENCHMARK RESULTS SUMMARY")
    print("#" * 70)
    print(f"\n  {'Test':<50} {'Status':>6} {'Time':>9} {'VRAM':>9}")
    print("  " + "-" * 76)
    for r in results:
        icon = "PASS" if r.status == "pass" else "FAIL" if r.status == "fail" else "SKIP"
        t = f"{r.total_time:.1f}s" if r.total_time > 0 else "-"
        v = f"{r.peak_vram_mb:.0f}MB" if r.peak_vram_mb > 0 else "-"
        print(f"  {r.name:<50} {icon:>6} {t:>9} {v:>9}")
        if r.error and r.status == "fail":
            print(f"    Error: {r.error}")

    # Detail breakdown for passed tests
    print(f"\n\n  DETAILED TIMINGS:")
    print("  " + "-" * 76)
    for r in results:
        if r.status == "pass" and r.details:
            print(f"\n  {r.name}:")
            for k, v in r.details.items():
                print(f"    {k}: {v:.1f}")
            if r.output_path:
                print(f"    output: {r.output_path}")

    # Save JSON report
    report_path = str(OUTPUT_DIR / "benchmark_report.json")
    report = {
        "gpu": torch.cuda.get_device_name(0),
        "vram_gb": round(torch.cuda.get_device_properties(0).total_memory / 1024**3),
        "pytorch": torch.__version__,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "results": [
            {
                "name": r.name,
                "status": r.status,
                "total_time": r.total_time,
                "peak_vram_mb": r.peak_vram_mb,
                "output_path": r.output_path,
                "details": r.details,
                "error": r.error,
            }
            for r in results
        ],
    }
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)
    print(f"\n\n  Report saved to: {report_path}")
    print(f"  Outputs in: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
