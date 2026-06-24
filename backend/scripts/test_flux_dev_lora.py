"""Test Flux Dev with norbes LoRA - standalone script."""

import gc
import time
import torch
from pathlib import Path

LORA_PATH = r"D:\git\AI-Toolkit-Easy-Install\AI-Toolkit\output\norbes_flux_test\norbes_flux_test.safetensors"
OUTPUT_DIR = Path(__file__).parent / "flux_dev_outputs"
OUTPUT_DIR.mkdir(exist_ok=True)

# Model ID - will download on first run (~12GB with NF4)
MODEL_ID = "black-forest-labs/FLUX.1-dev"

PROMPTS = [
    "norbes, professional headshot portrait, studio lighting, sharp focus, 8k photograph",
    "norbes, casual outdoor portrait, natural sunlight, bokeh background, candid smile",
    "norbes, cinematic close-up, dramatic side lighting, film grain, moody atmosphere",
]


def main() -> None:
    from diffusers import FluxPipeline, BitsAndBytesConfig, PipelineQuantizationConfig  # type: ignore

    print("Loading Flux Dev with NF4 quantization...")
    t0 = time.time()

    nf4_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
    )
    quant_config = PipelineQuantizationConfig(
        quant_mapping={"transformer": nf4_config},
    )

    pipe = FluxPipeline.from_pretrained(
        MODEL_ID,
        quantization_config=quant_config,
        torch_dtype=torch.bfloat16,
        low_cpu_mem_usage=True,
    )
    print(f"Model loaded in {time.time() - t0:.1f}s")

    pipe.enable_model_cpu_offload()

    # Load LoRA
    print(f"Loading LoRA from {LORA_PATH}")
    pipe.load_lora_weights(LORA_PATH, adapter_name="norbes")
    pipe.set_adapters(["norbes"], adapter_weights=[1.0])
    print("LoRA loaded")

    for i, prompt in enumerate(PROMPTS):
        print(f"\nGenerating image {i+1}/{len(PROMPTS)}: {prompt[:60]}...")
        t1 = time.time()

        generator = torch.Generator(device="cpu").manual_seed(42 + i)
        result = pipe(
            prompt=prompt,
            height=1024,
            width=1024,
            guidance_scale=3.5,
            num_inference_steps=28,
            generator=generator,
            output_type="pil",
        )

        img = result.images[0]
        out_path = OUTPUT_DIR / f"norbes_test_{i+1}.png"
        img.save(str(out_path))
        print(f"Saved to {out_path} ({time.time() - t1:.1f}s)")

        gc.collect()
        torch.cuda.empty_cache()

    print(f"\nAll done! Images saved to {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
