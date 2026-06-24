"""Full FLUX Klein + LoRA test: inference then separate VAE decode."""
import os, sys, time, gc
os.environ["PYTHONIOENCODING"] = "utf-8"
import torch
import numpy as np
from PIL import Image
from diffusers import Flux2KleinPipeline, AutoencoderKL

MODEL_DIR = r"C:\Users\taskm\AppData\Local\LTXDesktop\models\FLUX.2-klein-base-9B"
LORA_PATH = r"C:\Users\taskm\Downloads\jRB4slNlO3KYd18ROU5Up_pytorch_lora_weights_comfy_converted.safetensors"
TRIGGER = "DC animation style, with bold outlines, cel-shaded & muted color palette"
PROMPT = f"{TRIGGER}, a superhero standing on a rooftop at sunset, dramatic lighting, city skyline in background"
OUTPUT = r"D:\git\directors-desktop\backend\scripts\flux_klein_lora_result.png"

# ── Phase 1: Inference ──
print("=== Phase 1: Loading pipeline ===", flush=True)
pipe = Flux2KleinPipeline.from_pretrained(MODEL_DIR, torch_dtype=torch.bfloat16, low_cpu_mem_usage=True)
pipe.enable_model_cpu_offload()

print("Loading LoRA...", flush=True)
pipe.load_lora_weights(LORA_PATH, adapter_name="dc_anim")
pipe.set_adapters(["dc_anim"], adapter_weights=[1.0])

print(f"Generating 1024x1024 @ 28 steps...", flush=True)
t0 = time.time()
gen = torch.Generator("cpu").manual_seed(42)
output = pipe(
    prompt=PROMPT,
    height=1024, width=1024,
    guidance_scale=4.0,
    num_inference_steps=28,
    generator=gen,
    output_type="latent",
    return_dict=True,
)
t_inference = time.time() - t0
print(f"Inference: {t_inference:.1f}s", flush=True)

# Save latents IMMEDIATELY to CPU before touching anything else
latents = output.images.to("cpu")
print(f"Latents saved to CPU: {latents.shape}", flush=True)

# ── Phase 2: Cleanup pipeline to free VRAM ──
print("=== Phase 2: Cleaning up pipeline ===", flush=True)
del pipe, output
gc.collect()
torch.cuda.empty_cache()

# ── Phase 3: Fresh VAE decode ──
print("=== Phase 3: VAE decode (fresh load, no hooks) ===", flush=True)
t1 = time.time()
vae_path = os.path.join(MODEL_DIR, "vae")
vae = AutoencoderKL.from_pretrained(vae_path, torch_dtype=torch.float32)
vae = vae.to("cpu")
vae.eval()

latents_f32 = latents.to(dtype=torch.float32)
with torch.no_grad():
    decoded = vae.decode(latents_f32, return_dict=False)[0]

decoded = (decoded / 2 + 0.5).clamp(0, 1)
arr = decoded[0].permute(1, 2, 0).numpy()
pil_img = Image.fromarray((arr * 255).astype(np.uint8))
t_decode = time.time() - t1
print(f"VAE decode: {t_decode:.1f}s", flush=True)

pil_img.save(OUTPUT)
print(f"\nTotal: {t_inference + t_decode:.1f}s (inference {t_inference:.1f}s + decode {t_decode:.1f}s)", flush=True)
print(f"Saved: {OUTPUT}", flush=True)
