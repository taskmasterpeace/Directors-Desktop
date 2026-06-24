"""Decode saved latents with a fresh VAE (no pipeline hooks)."""
import os, time
os.environ["PYTHONIOENCODING"] = "utf-8"
import torch
import numpy as np
from PIL import Image

MODEL_DIR = r"C:\Users\taskm\AppData\Local\LTXDesktop\models\FLUX.2-klein-base-9B"
LATENTS_PATH = r"D:\git\directors-desktop\backend\scripts\test_latents.pt"
OUTPUT_PATH = r"D:\git\directors-desktop\backend\scripts\flux_klein_no_lora_test.png"

print("Loading latents...", flush=True)
latents = torch.load(LATENTS_PATH, weights_only=True)
print(f"Latents shape: {latents.shape}, dtype: {latents.dtype}", flush=True)

print("Loading fresh VAE from model dir...", flush=True)
from diffusers import AutoencoderKL
import json, pathlib

# Load VAE directly from subfolder
vae_path = pathlib.Path(MODEL_DIR) / "vae"
if not vae_path.exists():
    # Try loading from the pipeline config
    from diffusers import Flux2KleinPipeline
    print("Loading full pipeline to extract VAE...", flush=True)
    pipe = Flux2KleinPipeline.from_pretrained(MODEL_DIR, torch_dtype=torch.bfloat16, low_cpu_mem_usage=True)
    vae = pipe.vae
    del pipe
else:
    print(f"Loading VAE from {vae_path}...", flush=True)
    vae = AutoencoderKL.from_pretrained(str(vae_path), torch_dtype=torch.float32)

print("Moving VAE to CPU float32...", flush=True)
vae = vae.to("cpu", dtype=torch.float32)
vae.eval()

print("Decoding latents on CPU...", flush=True)
t0 = time.time()
latents_f32 = latents.to("cpu", dtype=torch.float32)
with torch.no_grad():
    decoded = vae.decode(latents_f32, return_dict=False)[0]
print(f"Decoded in {time.time()-t0:.1f}s, shape: {decoded.shape}", flush=True)

decoded = (decoded / 2 + 0.5).clamp(0, 1)
arr = decoded[0].permute(1, 2, 0).numpy()
pil_img = Image.fromarray((arr * 255).astype(np.uint8))
pil_img.save(OUTPUT_PATH)
print(f"Saved to {OUTPUT_PATH}", flush=True)
