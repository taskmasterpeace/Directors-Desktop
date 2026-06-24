"""FLUX.1 Dev image generation pipeline wrapper."""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, cast

import torch
from diffusers import BitsAndBytesConfig, FluxPipeline, PipelineQuantizationConfig  # type: ignore[reportUnknownVariableType]
from PIL.Image import Image as PILImage

from services.services_utils import ImagePipelineOutputLike, PILImageType, get_device_type

_logger = logging.getLogger(__name__)


@dataclass(slots=True)
class _FluxDevOutput:
    images: Sequence[PILImageType]


class FluxDevImagePipeline:
    """FLUX.1 Dev — text-to-image, img2img, and LoRA support.

    Uses NF4 quantization + model_cpu_offload.  Unlike Flux Klein, this
    pipeline does NOT need the destroy-after-gen workaround because Flux Dev
    uses a standard AutoencoderKL (not AutoencoderKLFlux2) which does not
    segfault on Windows/CUDA with accelerate hooks.

    LoRAs trained on Flux Dev (the standard 12B model) use 3072-dim
    attention and are NOT compatible with Klein's 4096-dim.
    """

    @staticmethod
    def create(
        model_path: str,
        device: str | None = None,
    ) -> "FluxDevImagePipeline":
        return FluxDevImagePipeline(model_path=model_path, device=device)

    def __init__(self, model_path: str, device: str | None = None) -> None:
        self._device: str | None = None
        self._model_offload_active = False
        self._lora_loaded: str | None = None
        self._model_path = model_path

        nf4_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
        )
        quant_config = PipelineQuantizationConfig(
            quant_mapping={"transformer": nf4_config},
        )

        self.pipeline = FluxPipeline.from_pretrained(  # type: ignore[reportUnknownMemberType]
            model_path,
            quantization_config=quant_config,
            torch_dtype=torch.bfloat16,
            low_cpu_mem_usage=True,
        )
        if device is not None:
            self.to(device)

    def _resolve_generator_device(self) -> str:
        if self._model_offload_active:
            return "cpu"
        if self._device is not None:
            return self._device
        execution_device = getattr(self.pipeline, "_execution_device", None)
        return get_device_type(execution_device)

    @staticmethod
    def _normalize_output(output: object) -> ImagePipelineOutputLike:
        images = getattr(output, "images", None)
        if not isinstance(images, Sequence):
            raise RuntimeError("Unexpected FLUX Dev pipeline output format: missing images sequence")

        images_list = cast(Sequence[object], images)
        validated_images: list[PILImageType] = []
        for image in images_list:
            if not isinstance(image, PILImage):
                raise RuntimeError("Unexpected FLUX Dev pipeline output: images must be PIL.Image instances")
            validated_images.append(image)

        return _FluxDevOutput(images=validated_images)

    @torch.inference_mode()
    def generate(
        self,
        prompt: str,
        height: int,
        width: int,
        guidance_scale: float,
        num_inference_steps: int,
        seed: int,
    ) -> ImagePipelineOutputLike:
        generator = torch.Generator(device=self._resolve_generator_device()).manual_seed(seed)
        pipeline = cast(Any, self.pipeline)

        steps = num_inference_steps if num_inference_steps > 4 else 28
        gs = guidance_scale if guidance_scale > 0 else 3.5

        if self._model_offload_active:
            torch.cuda.empty_cache()

        output = pipeline(
            prompt=prompt,
            height=height,
            width=width,
            guidance_scale=gs,
            num_inference_steps=steps,
            generator=generator,
            output_type="pil",
            return_dict=True,
        )
        return self._normalize_output(output)

    @torch.inference_mode()
    def img2img(
        self,
        prompt: str,
        image: PILImageType,
        strength: float,
        height: int,
        width: int,
        guidance_scale: float,
        num_inference_steps: int,
        seed: int,
    ) -> ImagePipelineOutputLike:
        generator = torch.Generator(device=self._resolve_generator_device()).manual_seed(seed)
        pipeline = cast(Any, self.pipeline)

        base_steps = num_inference_steps if num_inference_steps > 4 else 28
        effective_steps = max(1, int(base_steps * strength))
        gs = guidance_scale if guidance_scale > 0 else 3.5

        if self._model_offload_active:
            torch.cuda.empty_cache()

        output = pipeline(
            prompt=prompt,
            image=image,
            height=height,
            width=width,
            guidance_scale=gs,
            num_inference_steps=effective_steps,
            generator=generator,
            output_type="pil",
            return_dict=True,
        )
        return self._normalize_output(output)

    def to(self, device: str) -> None:
        runtime_device = get_device_type(device)
        if runtime_device in ("cuda", "mps"):
            self.pipeline.enable_model_cpu_offload()  # type: ignore[reportUnknownMemberType]
            self._model_offload_active = True
        else:
            self._model_offload_active = False
            self.pipeline.to(runtime_device)  # type: ignore[reportUnknownMemberType]
        self._device = runtime_device

    def load_lora(self, lora_path: str, weight: float = 1.0) -> None:
        if self._lora_loaded == lora_path:
            return
        if self._lora_loaded is not None:
            self.unload_lora()
        pipeline = cast(Any, self.pipeline)
        pipeline.load_lora_weights(lora_path, adapter_name="user_lora")
        pipeline.set_adapters(["user_lora"], adapter_weights=[weight])
        self._lora_loaded = lora_path

    def unload_lora(self) -> None:
        if self._lora_loaded is None:
            return
        pipeline = cast(Any, self.pipeline)
        pipeline.unload_lora_weights()
        self._lora_loaded = None
