"""Test FLUX Klein 9B with DC Animation Style LoRA — generates a thumbnail."""

import os
import sys
import time

os.environ["PYTHONIOENCODING"] = "utf-8"

import torch
from diffusers import Flux2KleinPipeline  # type: ignore

# ── Config ──────────────────────────────────────────────────────────────
MODEL_DIR = r"C:\Users\taskm\AppData\Local\LTXDesktop\models\FLUX.2-klein-base-9B"
LORA_PATH = r"C:\Users\taskm\Downloads\jRB4slNlO3KYd18ROU5Up_pytorch_lora_weights_comfy_converted.safetensors"
TRIGGER = "DC animation style, with bold outlines, cel-shaded & muted color palette"
PROMPT = f"{TRIGGER}, a superhero standing on a rooftop at sunset, dramatic lighting, city skyline in background"
OUTPUT_PATH = r"D:\git\directors-desktop\backend\scripts\flux_klein_lora_test.png"

WIDTH = 1024
HEIGHT = 1024
STEPS = 28
GUIDANCE = 4.0
SEED = 42
LORA_WEIGHT = 1.0

print(f"Loading FLUX.2 Klein 9B from {MODEL_DIR}...")
t0 = time.time()

pipe = Flux2KleinPipeline.from_pretrained(
    MODEL_DIR,
    torch_dtype=torch.bfloat16,
    low_cpu_mem_usage=True,
)
print(f"  Pipeline loaded in {time.time() - t0:.1f}s")

print("Enabling model CPU offload...")
pipe.enable_model_cpu_offload()

print(f"Loading LoRA from {LORA_PATH} (weight={LORA_WEIGHT})...")
t1 = time.time()
pipe.load_lora_weights(LORA_PATH, adapter_name="dc_animation")
pipe.set_adapters(["dc_animation"], adapter_weights=[LORA_WEIGHT])
print(f"  LoRA loaded in {time.time() - t1:.1f}s")

print(f"Generating {WIDTH}x{HEIGHT} @ {STEPS} steps, guidance={GUIDANCE}, seed={SEED}")
print(f"  Prompt: {PROMPT[:80]}...")
t2 = time.time()

generator = torch.Generator("cpu").manual_seed(SEED)
output = pipe(
    prompt=PROMPT,
    height=HEIGHT,
    width=WIDTH,
    guidance_scale=GUIDANCE,
    num_inference_steps=STEPS,
    generator=generator,
    output_type="latent",
    return_dict=True,
)
latents = output.images
print(f"  Inference done in {time.time() - t2:.1f}s")

# Debug: narrow down segfault location
print("[DEBUG] Step 1: Getting latents to CPU...", flush=True)
import gc
import numpy as np
from PIL import Image
t3 = time.time()

latents_cpu = latents.to("cpu")
print(f"[DEBUG] Step 1 done. Latents shape: {latents_cpu.shape}, dtype: {latents_cpu.dtype}", flush=True)

print("[DEBUG] Step 2: Saving latents to disk as backup...", flush=True)
torch.save(latents_cpu, r"D:\git\directors-desktop\backend\scripts\latents_backup.pt")
print("[DEBUG] Step 2 done.", flush=True)

print("[DEBUG] Step 3: Removing accelerate hooks...", flush=True)
try:
    from accelerate.hooks import remove_hook_from_module  # type: ignore
    remove_hook_from_module(pipe.vae, recurse=True)
    print("[DEBUG] Step 3 done - hooks removed.", flush=True)
except (ImportError, Exception) as e:
    print(f"[DEBUG] Step 3 skip - {e}", flush=True)

print("[DEBUG] Step 4: Moving VAE to CPU float32...", flush=True)
pipe.vae = pipe.vae.to("cpu", dtype=torch.float32)
pipe.vae.eval()
print("[DEBUG] Step 4 done.", flush=True)

print("[DEBUG] Step 5: Casting latents to float32...", flush=True)
latents_f32 = latents_cpu.to(dtype=torch.float32)
print(f"[DEBUG] Step 5 done. Shape: {latents_f32.shape}", flush=True)

print("[DEBUG] Step 6: VAE decode...", flush=True)
with torch.no_grad():
    decoded = pipe.vae.decode(latents_f32, return_dict=False)[0]
print(f"[DEBUG] Step 6 done. Decoded shape: {decoded.shape}", flush=True)

decoded = (decoded / 2 + 0.5).clamp(0, 1)
arr = decoded[0].permute(1, 2, 0).numpy()
pil_img = Image.fromarray((arr * 255).astype(np.uint8))
print(f"  VAE decode on CPU in {time.time() - t3:.1f}s", flush=True)

del latents_cpu, latents_f32, decoded
gc.collect()

pil_img.save(OUTPUT_PATH)
print(f"\nTotal time: {time.time() - t0:.1f}s")
print(f"Saved to: {OUTPUT_PATH}")

# Clean up
del latents, latents_gpu, decoded
torch.cuda.empty_cache()
