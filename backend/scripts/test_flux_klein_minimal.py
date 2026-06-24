"""Minimal FLUX Klein test — no LoRA, to isolate segfault."""
import os, sys, time
os.environ["PYTHONIOENCODING"] = "utf-8"
import torch
from diffusers import Flux2KleinPipeline

MODEL_DIR = r"C:\Users\taskm\AppData\Local\LTXDesktop\models\FLUX.2-klein-base-9B"

print("Loading pipeline...", flush=True)
pipe = Flux2KleinPipeline.from_pretrained(MODEL_DIR, torch_dtype=torch.bfloat16, low_cpu_mem_usage=True)
print("Enabling model CPU offload...", flush=True)
pipe.enable_model_cpu_offload()

print("Generating 512x512 @ 4 steps (quick test)...", flush=True)
t0 = time.time()
gen = torch.Generator("cpu").manual_seed(42)
output = pipe(
    prompt="a red cube on a white table",
    height=512, width=512,
    guidance_scale=4.0,
    num_inference_steps=4,
    generator=gen,
    output_type="latent",
    return_dict=True,
)
print(f"Inference done in {time.time()-t0:.1f}s", flush=True)
print(f"Latents type: {type(output.images)}, shape: {output.images.shape}", flush=True)

# Save latents
torch.save(output.images.cpu(), r"D:\git\directors-desktop\backend\scripts\test_latents.pt")
print("Latents saved. No VAE decode attempted.", flush=True)
