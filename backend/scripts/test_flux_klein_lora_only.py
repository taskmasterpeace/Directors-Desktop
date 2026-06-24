"""Test FLUX Klein with LoRA — isolate if LoRA causes segfault."""
import os, time
os.environ["PYTHONIOENCODING"] = "utf-8"
import torch
from diffusers import Flux2KleinPipeline

MODEL_DIR = r"C:\Users\taskm\AppData\Local\LTXDesktop\models\FLUX.2-klein-base-9B"
LORA_PATH = r"C:\Users\taskm\Downloads\jRB4slNlO3KYd18ROU5Up_pytorch_lora_weights_comfy_converted.safetensors"
TRIGGER = "DC animation style, with bold outlines, cel-shaded & muted color palette"

print("Loading pipeline...", flush=True)
pipe = Flux2KleinPipeline.from_pretrained(MODEL_DIR, torch_dtype=torch.bfloat16, low_cpu_mem_usage=True)
pipe.enable_model_cpu_offload()

print("Loading LoRA...", flush=True)
pipe.load_lora_weights(LORA_PATH, adapter_name="dc_anim")
pipe.set_adapters(["dc_anim"], adapter_weights=[1.0])
print("LoRA loaded.", flush=True)

print("Generating 512x512 @ 4 steps with LoRA...", flush=True)
t0 = time.time()
gen = torch.Generator("cpu").manual_seed(42)
output = pipe(
    prompt=f"{TRIGGER}, a superhero on a rooftop at sunset",
    height=512, width=512,
    guidance_scale=4.0,
    num_inference_steps=4,
    generator=gen,
    output_type="latent",
    return_dict=True,
)
print(f"Inference done in {time.time()-t0:.1f}s", flush=True)
print(f"Latents shape: {output.images.shape}", flush=True)

torch.save(output.images.cpu(), r"D:\git\directors-desktop\backend\scripts\test_latents_lora.pt")
print("Latents saved successfully. No segfault!", flush=True)
