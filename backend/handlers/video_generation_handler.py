"""Video generation orchestration handler."""

from __future__ import annotations

import logging
import os
import tempfile
import time
import uuid
from pathlib import Path
from threading import RLock
from typing import TYPE_CHECKING, Literal

from PIL import Image

from api_types import GenerateVideoRequest, GenerateVideoResponse, ImageConditioningInput, VideoCameraMotion
from _routes._errors import HTTPError
from handlers.base import StateHandlerBase
from handlers.generation_handler import GenerationHandler
from handlers.pipelines_handler import PipelinesHandler
from handlers.text_handler import TextHandler
from server_utils.media_validation import (
    normalize_optional_path,
    validate_audio_file,
    validate_image_file,
)
from server_utils.output_naming import make_output_path
from services.interfaces import LTXAPIClient, UploadClient, VideoAPIClient, VideoTrimmer
from state.app_state_types import AppState
from state.app_settings import should_video_generate_with_ltx_api

REPLICATE_VIDEO_MODELS = {"seedance-1.5-pro"}
# minimax-h3 is fal-hosted ONLY: its open-weights license excludes the United
# States, so the hosted API is the sole compliant path for this product.
FAL_VIDEO_MODELS = {"seedance-2.0", "seedance-2.0-fast", "minimax-h3"}

if TYPE_CHECKING:
    from runtime_config.runtime_config import RuntimeConfig

logger = logging.getLogger(__name__)

class VideoGenerationHandler(StateHandlerBase):
    def __init__(
        self,
        state: AppState,
        lock: RLock,
        generation_handler: GenerationHandler,
        pipelines_handler: PipelinesHandler,
        text_handler: TextHandler,
        ltx_api_client: LTXAPIClient,
        video_api_client: VideoAPIClient,
        fal_video_client: VideoAPIClient,
        upload_client: UploadClient,
        video_trimmer: VideoTrimmer,
        outputs_dir: Path,
        config: RuntimeConfig,
        camera_motion_prompts: dict[str, str],
        default_negative_prompt: str,
    ) -> None:
        super().__init__(state, lock)
        self._generation = generation_handler
        self._pipelines = pipelines_handler
        self._text = text_handler
        self._ltx_api_client = ltx_api_client
        self._video_api_client = video_api_client
        self._fal_video_client = fal_video_client
        self._upload_client = upload_client
        self._video_trimmer = video_trimmer
        self._outputs_dir = outputs_dir
        self._config = config
        self._camera_motion_prompts = camera_motion_prompts
        self._default_negative_prompt = default_negative_prompt

    def generate(self, req: GenerateVideoRequest) -> GenerateVideoResponse:
        if req.videoReferencePaths and req.model not in FAL_VIDEO_MODELS:
            raise HTTPError(400, "Video references require Seedance 2.0.")

        if req.model in REPLICATE_VIDEO_MODELS:
            return self._generate_via_replicate(req)

        if req.model in FAL_VIDEO_MODELS:
            return self._generate_via_fal(req)

        if should_video_generate_with_ltx_api(
            force_api_generations=self._config.force_api_generations,
            settings=self.state.app_settings,
        ):
            return self._generate_forced_api(req)

        if self._generation.is_generation_running():
            raise HTTPError(409, "Generation already in progress")

        resolution = req.resolution

        duration = int(float(req.duration))
        fps = int(float(req.fps))

        audio_path = normalize_optional_path(req.audioPath)
        if audio_path:
            return self._generate_a2v(req, duration, fps, audio_path=audio_path)

        logger.info("Resolution %s - using fast pipeline", resolution)

        RESOLUTION_MAP_16_9: dict[str, tuple[int, int]] = {
            # The pipeline rounds dims to /64 (see round(x/64)*64 below), so "480p"
            # uses 832x448 — the closest 64-aligned 480p-class size. 864x480 would
            # silently render as 896x512, i.e. not 480p at all.
            "480p": (832, 448),
            "540p": (960, 544),
            "720p": (1280, 704),
            "1080p": (1920, 1088),
        }

        def get_16_9_size(res: str) -> tuple[int, int]:
            return RESOLUTION_MAP_16_9.get(res, (960, 544))

        def get_9_16_size(res: str) -> tuple[int, int]:
            w, h = get_16_9_size(res)
            return h, w

        match req.aspectRatio:
            case "9:16":
                width, height = get_9_16_size(resolution)
            case "16:9":
                width, height = get_16_9_size(resolution)

        num_frames = self._compute_num_frames(duration, fps)

        image = None
        image_path = normalize_optional_path(req.imagePath)
        if image_path:
            image = self._prepare_image(image_path, width, height)
            logger.info("Image: %s -> %sx%s", image_path, width, height)

        last_frame_image = None
        last_frame_path = normalize_optional_path(req.lastFramePath)
        if last_frame_path:
            last_frame_image = self._prepare_image(last_frame_path, width, height)
            logger.info("Last frame: %s -> %sx%s", last_frame_path, width, height)

        generation_id = self._make_generation_id()
        seed = self._resolve_seed()

        try:
            self._pipelines.load_gpu_pipeline(
                "fast", should_warm=False,
                lora_path=req.loraPath, lora_weight=req.loraWeight,
            )
            self._generation.start_generation(generation_id)

            output_path = self.generate_video(
                prompt=req.prompt,
                image=image,
                last_frame_image=last_frame_image,
                height=height,
                width=width,
                num_frames=num_frames,
                fps=fps,
                seed=seed,
                camera_motion=req.cameraMotion,
                negative_prompt=req.negativePrompt,
                lora_path=req.loraPath,
                lora_weight=req.loraWeight,
            )

            self._maybe_conform_exact(output_path, req)
            self._generation.complete_generation(output_path)
            return GenerateVideoResponse(status="complete", video_path=output_path)

        except Exception as e:
            self._generation.fail_generation(str(e))
            if "cancelled" in str(e).lower():
                logger.info("Generation cancelled by user")
                return GenerateVideoResponse(status="cancelled")

            raise HTTPError(500, str(e)) from e

    def generate_video(
        self,
        prompt: str,
        image: Image.Image | None,
        height: int,
        width: int,
        num_frames: int,
        fps: float,
        seed: int,
        camera_motion: VideoCameraMotion,
        negative_prompt: str,
        last_frame_image: Image.Image | None = None,
        lora_path: str | None = None,
        lora_weight: float = 1.0,
    ) -> str:
        t_total_start = time.perf_counter()
        gen_mode = "i2v" if image is not None else "t2v"
        logger.info("[%s] Generation started (model=fast, %dx%d, %d frames, %d fps)", gen_mode, width, height, num_frames, int(fps))

        if self._generation.is_generation_cancelled():
            raise RuntimeError("Generation was cancelled")

        if not self._config.model_path("checkpoint").exists():
            raise RuntimeError("Models not downloaded. Please download the AI models first using the Model Status menu.")

        total_steps = 8

        self._generation.update_progress("preparing_gpu", 3, 0, total_steps)
        t_load_start = time.perf_counter()
        pipeline_state = self._pipelines.load_gpu_pipeline(
            "fast",
            should_warm=False,
            on_phase=lambda phase: self._generation.update_progress(phase, 5, 0, total_steps),
            lora_path=lora_path,
            lora_weight=lora_weight,
        )
        t_load_end = time.perf_counter()
        logger.info("[%s] Pipeline load: %.2fs", gen_mode, t_load_end - t_load_start)

        self._generation.update_progress("encoding_text", 10, 0, total_steps)

        enhanced_prompt = prompt + self._camera_motion_prompts.get(camera_motion, "")

        images: list[ImageConditioningInput] = []
        temp_image_path: str | None = None
        temp_last_frame_path: str | None = None
        if image is not None:
            temp_image_path = tempfile.NamedTemporaryFile(suffix=".png", delete=False).name
            image.save(temp_image_path)
            images.append(ImageConditioningInput(path=temp_image_path, frame_idx=0, strength=1.0))
        if last_frame_image is not None:
            temp_last_frame_path = tempfile.NamedTemporaryFile(suffix=".png", delete=False).name
            last_frame_image.save(temp_last_frame_path)
            # Condition the last frame of the generated video on this image.
            # frame_idx is a latent frame index. The VAE temporal compression is
            # 8x, so latent_frames = (num_frames - 1) // 8 + 1. We want the
            # start of the last latent frame: latent_frames - 1.
            latent_frames = (num_frames - 1) // 8 + 1
            last_latent_idx = latent_frames - 1
            images.append(ImageConditioningInput(path=temp_last_frame_path, frame_idx=last_latent_idx, strength=1.0))

        output_path = self._make_output_path(model="ltx-fast", prompt=prompt)

        try:
            settings = self.state.app_settings
            use_api_encoding = not self._text.should_use_local_encoding()
            if image is not None:
                enhance = use_api_encoding and settings.prompt_enhancer_enabled_i2v
            else:
                enhance = use_api_encoding and settings.prompt_enhancer_enabled_t2v

            encoding_method = "api" if use_api_encoding else "local"
            t_text_start = time.perf_counter()
            self._text.prepare_text_encoding(enhanced_prompt, enhance_prompt=enhance)
            # Pre-encode with the local Gemma encoder while the GPU is ours and
            # report it as its own phase. Left to the pipeline, this encode ran
            # wedged beside the staged transformer — device-split onto the CPU —
            # and was the real identity of the legendary "stall at 15%".
            self._generation.update_progress("encoding_prompt", 12, 0, total_steps)
            self._text.precompute_local_embeddings(pipeline_state.pipeline, enhanced_prompt)
            t_text_end = time.perf_counter()
            logger.info("[%s] Text encoding (%s): %.2fs", gen_mode, encoding_method, t_text_end - t_text_start)

            self._generation.update_progress("inference", 15, 0, total_steps)

            height = round(height / 64) * 64
            width = round(width / 64) * 64

            t_inference_start = time.perf_counter()
            pipeline_state.pipeline.generate(
                prompt=enhanced_prompt,
                seed=seed,
                height=height,
                width=width,
                num_frames=num_frames,
                frame_rate=fps,
                images=images,
                output_path=str(output_path),
            )
            t_inference_end = time.perf_counter()
            logger.info("[%s] Inference: %.2fs", gen_mode, t_inference_end - t_inference_start)

            if self._generation.is_generation_cancelled():
                if output_path.exists():
                    output_path.unlink()
                raise RuntimeError("Generation was cancelled")

            t_total_end = time.perf_counter()
            logger.info("[%s] Total generation: %.2fs (load=%.2fs, text=%.2fs, inference=%.2fs)",
                        gen_mode, t_total_end - t_total_start,
                        t_load_end - t_load_start, t_text_end - t_text_start, t_inference_end - t_inference_start)

            self._generation.update_progress("complete", 100, total_steps, total_steps)
            return str(output_path)
        finally:
            self._text.clear_api_embeddings()
            if temp_image_path and os.path.exists(temp_image_path):
                os.unlink(temp_image_path)
            if temp_last_frame_path and os.path.exists(temp_last_frame_path):
                os.unlink(temp_last_frame_path)

    def generate_long_video(
        self,
        prompt: str,
        image_path: str,
        target_duration: int,
        resolution: str = "512p",
        aspect_ratio: str = "16:9",
        fps: int = 24,
        segment_duration: int = 4,
        camera_motion: VideoCameraMotion = "none",
        lora_path: str | None = None,
        lora_weight: float = 1.0,
        exact_duration: bool = False,
    ) -> str:
        """Generate a long video by chaining I2V + extend segments.

        1. Generate initial segment from source image (I2V)
        2. Extract last frame, generate next segment conditioned on it
        3. Repeat until target_duration is reached
        4. Concatenate all segments (trimming first frame of extensions)
        """
        RESOLUTION_MAP_16_9: dict[str, tuple[int, int]] = {
            "480p": (832, 448),
            "512p": (960, 544), "540p": (960, 544),
            "720p": (1280, 704), "1080p": (1920, 1088),
        }

        def get_size(res: str, ar: str) -> tuple[int, int]:
            w, h = RESOLUTION_MAP_16_9.get(res, (960, 544))
            return (h, w) if ar == "9:16" else (w, h)

        width, height = get_size(resolution, aspect_ratio)
        num_segments = max(1, (target_duration + segment_duration - 1) // segment_duration)
        logger.info("[long] Starting %ds video: %d segments of %ds (%dx%d)",
                    target_duration, num_segments, segment_duration, width, height)

        ffmpeg_path = self._find_ffmpeg()
        segment_paths: list[str] = []
        temp_files: list[str] = []

        try:
            # --- Segment 1: I2V from source image ---
            image = self._prepare_image(image_path, width, height)
            num_frames = self._compute_num_frames(segment_duration, fps)
            seed = self._resolve_seed()

            generation_id = self._make_generation_id()
            self._pipelines.load_gpu_pipeline(
                "fast", should_warm=False,
                lora_path=lora_path, lora_weight=lora_weight,
            )
            self._generation.start_generation(generation_id)

            try:
                self._generation.update_progress("generating_segment", 5, 1, num_segments)
                seg1_path = self.generate_video(
                    prompt=prompt, image=image, height=height, width=width,
                    num_frames=num_frames, fps=float(fps), seed=seed,
                    camera_motion=camera_motion, negative_prompt="",
                    lora_path=lora_path, lora_weight=lora_weight,
                )
                segment_paths.append(seg1_path)
                logger.info("[long] Segment 1/%d complete: %s", num_segments, seg1_path)
            except Exception:
                self._generation.fail_generation("Segment 1 failed")
                raise

            # --- Segments 2..N: extend from last frame ---
            for seg_idx in range(2, num_segments + 1):
                if self._generation.is_generation_cancelled():
                    raise RuntimeError("Generation was cancelled")

                prev_path = segment_paths[-1]
                last_frame = self._extract_last_frame(prev_path, ffmpeg_path)
                temp_files.append(last_frame)

                last_frame_image = Image.open(last_frame).convert("RGB")
                seed = self._resolve_seed()

                self._generation.update_progress(
                    "generating_segment", int(15 + 70 * seg_idx / num_segments),
                    seg_idx, num_segments,
                )

                seg_path = self.generate_video(
                    prompt=prompt, image=None, last_frame_image=last_frame_image,
                    height=height, width=width, num_frames=num_frames, fps=float(fps),
                    seed=seed, camera_motion=camera_motion, negative_prompt="",
                    lora_path=lora_path, lora_weight=lora_weight,
                )
                segment_paths.append(seg_path)
                logger.info("[long] Segment %d/%d complete: %s", seg_idx, num_segments, seg_path)

            # --- Concatenate segments ---
            self._generation.update_progress("concatenating", 90, num_segments, num_segments)
            output_path = self._make_output_path(model="ltx-fast-long", prompt=prompt)

            self._concatenate_segments(
                segment_paths, str(output_path), ffmpeg_path, fps,
            )
            logger.info("[long] Final video: %s (%d segments)", output_path, len(segment_paths))

            if exact_duration:
                self._conform_exact_output(str(output_path), float(target_duration))
            self._generation.complete_generation(str(output_path))
            return str(output_path)

        except Exception as e:
            if "cancelled" not in str(e).lower():
                self._generation.fail_generation(str(e))
            raise
        finally:
            # Clean up the last-frame PNGs and the intermediate segment mp4s.
            # On success the segments have already been concatenated into the
            # final output; on failure they are partial and unwanted either way.
            for f in [*temp_files, *segment_paths]:
                try:
                    if os.path.exists(f):
                        os.unlink(f)
                except OSError as exc:
                    logger.warning("[long] Failed to remove temp file %s: %s", f, exc)

    @staticmethod
    def _find_ffmpeg() -> str:
        """Find ffmpeg binary — bundled with imageio-ffmpeg."""
        try:
            import imageio_ffmpeg
            return imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            pass
        raise RuntimeError("ffmpeg not found. Install imageio-ffmpeg.")

    @staticmethod
    def _extract_last_frame(video_path: str, ffmpeg_path: str) -> str:
        """Extract the last frame of a video to a temp PNG."""
        import subprocess

        out = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
        out.close()
        subprocess.run(
            [ffmpeg_path, "-y", "-sseof", "-0.05", "-i", video_path,
             "-frames:v", "1", "-update", "1", out.name],
            capture_output=True, check=True,
        )
        return out.name

    @staticmethod
    def _concatenate_segments(
        segment_paths: list[str], output_path: str, ffmpeg_path: str, fps: int,
    ) -> None:
        """Concatenate video segments into one file."""
        import subprocess

        if len(segment_paths) == 1:
            import shutil
            shutil.copy2(segment_paths[0], output_path)
            return

        # Use concat demuxer — simple and reliable.
        concat_file = tempfile.NamedTemporaryFile(
            mode="w", suffix=".txt", delete=False,
        )
        try:
            for seg in segment_paths:
                # ffmpeg concat demuxer needs forward slashes or escaped backslashes
                safe_path = seg.replace("\\", "/")
                concat_file.write(f"file '{safe_path}'\n")
            concat_file.close()

            cmd = [
                ffmpeg_path, "-y",
                "-f", "concat", "-safe", "0",
                "-i", concat_file.name,
                "-c", "copy",
                output_path,
            ]
            subprocess.run(cmd, capture_output=True, check=True)
        finally:
            if os.path.exists(concat_file.name):
                os.unlink(concat_file.name)

    def _generate_a2v(
        self, req: GenerateVideoRequest, duration: int, fps: int, *, audio_path: str
    ) -> GenerateVideoResponse:
        if req.model != "pro":
            logger.warning("A2V local requested with model=%s; A2V always uses pro pipeline", req.model)
        validated_audio_path = validate_audio_file(audio_path)
        audio_path_str = str(validated_audio_path)

        RESOLUTION_MAP: dict[str, tuple[int, int]] = {
            "480p": (832, 448),
            "540p": (960, 576),
            "720p": (1280, 704),
            "1080p": (1920, 1088),
        }
        width, height = RESOLUTION_MAP.get(req.resolution, (960, 576))

        num_frames = self._compute_num_frames(duration, fps)

        image = None
        temp_image_path: str | None = None
        temp_last_frame_path: str | None = None
        image_path = normalize_optional_path(req.imagePath)
        if image_path:
            image = self._prepare_image(image_path, width, height)

        last_frame_image = None
        last_frame_path = normalize_optional_path(req.lastFramePath)
        if last_frame_path:
            last_frame_image = self._prepare_image(last_frame_path, width, height)

        seed = self._resolve_seed()

        generation_id = self._make_generation_id()

        try:
            a2v_state = self._pipelines.load_a2v_pipeline()
            self._generation.start_generation(generation_id)

            enhanced_prompt = req.prompt + self._camera_motion_prompts.get(req.cameraMotion, "")
            neg = req.negativePrompt if req.negativePrompt else self._default_negative_prompt

            images: list[ImageConditioningInput] = []
            if image is not None:
                temp_image_path = tempfile.NamedTemporaryFile(suffix=".png", delete=False).name
                image.save(temp_image_path)
                images.append(ImageConditioningInput(path=temp_image_path, frame_idx=0, strength=1.0))
            if last_frame_image is not None:
                temp_last_frame_path = tempfile.NamedTemporaryFile(suffix=".png", delete=False).name
                last_frame_image.save(temp_last_frame_path)
                images.append(ImageConditioningInput(path=temp_last_frame_path, frame_idx=0, strength=1.0))

            output_path = self._make_output_path(model="ltx-pro", prompt=req.prompt)

            total_steps = 11  # distilled: 8 steps (stage 1) + 3 steps (stage 2)

            a2v_settings = self.state.app_settings
            a2v_use_api = not self._text.should_use_local_encoding()
            if image is not None:
                a2v_enhance = a2v_use_api and a2v_settings.prompt_enhancer_enabled_i2v
            else:
                a2v_enhance = a2v_use_api and a2v_settings.prompt_enhancer_enabled_t2v

            self._generation.update_progress("loading_model", 5, 0, total_steps)
            self._generation.update_progress("encoding_text", 10, 0, total_steps)
            self._text.prepare_text_encoding(enhanced_prompt, enhance_prompt=a2v_enhance)
            # Same pre-encode as i2v/t2v: never let the pipeline run Gemma beside
            # the staged transformer (the "stall at 15%" root cause).
            self._text.precompute_local_embeddings(a2v_state.pipeline, enhanced_prompt)
            self._generation.update_progress("inference", 15, 0, total_steps)

            a2v_state.pipeline.generate(
                prompt=enhanced_prompt,
                negative_prompt=neg,
                seed=seed,
                height=height,
                width=width,
                num_frames=num_frames,
                frame_rate=fps,
                num_inference_steps=total_steps,
                images=images,
                audio_path=audio_path_str,
                audio_start_time=max(0.0, req.audioStartTime),
                audio_max_duration=req.audioMaxDuration,
                output_path=str(output_path),
            )

            if self._generation.is_generation_cancelled():
                if output_path.exists():
                    output_path.unlink()
                raise RuntimeError("Generation was cancelled")

            self._maybe_conform_exact(str(output_path), req)
            self._generation.update_progress("complete", 100, total_steps, total_steps)
            self._generation.complete_generation(str(output_path))
            return GenerateVideoResponse(status="complete", video_path=str(output_path))

        except Exception as e:
            self._generation.fail_generation(str(e))
            if "cancelled" in str(e).lower():
                logger.info("Generation cancelled by user")
                return GenerateVideoResponse(status="cancelled")
            raise HTTPError(500, str(e)) from e
        finally:
            self._text.clear_api_embeddings()
            if temp_image_path and os.path.exists(temp_image_path):
                os.unlink(temp_image_path)
            if temp_last_frame_path and os.path.exists(temp_last_frame_path):
                os.unlink(temp_last_frame_path)

    def _prepare_image(self, image_path: str, width: int, height: int) -> Image.Image:
        validated_path = validate_image_file(image_path)
        try:
            img = Image.open(validated_path).convert("RGB")
        except Exception:
            raise HTTPError(400, f"Invalid image file: {image_path}") from None
        img_w, img_h = img.size
        target_ratio = width / height
        img_ratio = img_w / img_h
        if img_ratio > target_ratio:
            new_h = height
            new_w = int(img_w * (height / img_h))
        else:
            new_w = width
            new_h = int(img_h * (width / img_w))
        resized = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
        left = (new_w - width) // 2
        top = (new_h - height) // 2
        return resized.crop((left, top, left + width, top + height))

    @staticmethod
    def _make_generation_id() -> str:
        return uuid.uuid4().hex[:8]

    @staticmethod
    def _compute_num_frames(duration: int, fps: int) -> int:
        n = ((duration * fps) // 8) * 8 + 1
        return max(n, 9)

    def _resolve_seed(self) -> int:
        settings = self.state.app_settings
        if settings.seed_locked:
            logger.info("Using locked seed: %s", settings.locked_seed)
            return settings.locked_seed
        return int(time.time()) % 2147483647

    @staticmethod
    def _image_to_data_uri(image_path: str | None) -> str | None:
        """Validate a local image and encode it as a base64 data URI for cloud APIs."""
        normalized = normalize_optional_path(image_path)
        if normalized is None:
            return None
        validated = validate_image_file(normalized)
        import base64

        raw = validated.read_bytes()
        b64 = base64.b64encode(raw).decode("ascii")
        ext = validated.suffix.lstrip(".").lower()
        mime = "image/png" if ext == "png" else "image/jpeg"
        return f"data:{mime};base64,{b64}"

    @staticmethod
    def _audio_to_data_uri(audio_path: str | None) -> str | None:
        """Encode a local audio file as a base64 data URI for cloud audio references."""
        normalized = normalize_optional_path(audio_path)
        if normalized is None:
            return None
        audio_file = Path(normalized)
        if not audio_file.exists():
            return None
        import base64

        raw = audio_file.read_bytes()
        b64 = base64.b64encode(raw).decode("ascii")
        ext = audio_file.suffix.lstrip(".").lower()
        mime = {
            "mp3": "audio/mpeg",
            "wav": "audio/wav",
            "m4a": "audio/mp4",
            "ogg": "audio/ogg",
            "flac": "audio/flac",
        }.get(ext, "audio/mpeg")
        return f"data:{mime};base64,{b64}"

    _AUDIO_MIME = {
        "mp3": "audio/mpeg",
        "wav": "audio/wav",
        "m4a": "audio/mp4",
        "ogg": "audio/ogg",
        "flac": "audio/flac",
    }

    _VIDEO_MIME = {
        "mp4": "video/mp4",
        "mov": "video/quicktime",
        "webm": "video/webm",
        "m4v": "video/x-m4v",
    }

    def _upload_reference(
        self, api_key: str, path: str, *, kind: Literal["image", "audio", "video"]
    ) -> str | None:
        """Upload a local reference image/audio/video to fal storage and return its hosted URL.

        References are hosted (not inlined as base64) so the request body stays small —
        critical for audio and video, which can be megabytes each.
        """
        normalized = normalize_optional_path(path)
        if normalized is None:
            return None
        file = Path(normalized)
        if not file.exists():
            return None
        ext = file.suffix.lstrip(".").lower()
        if kind == "audio":
            content_type = self._AUDIO_MIME.get(ext, "audio/mpeg")
        elif kind == "video":
            content_type = self._VIDEO_MIME.get(ext)
            if content_type is None:
                raise HTTPError(400, f"Unsupported video reference format: .{ext}")
        else:
            validate_image_file(normalized)  # security: confirm it's a real image
            content_type = "image/png" if ext == "png" else "image/jpeg"
        return self._upload_client.upload(
            api_key=api_key,
            data=file.read_bytes(),
            content_type=content_type,
            file_name=file.name,
        )

    def _make_output_path(self, *, model: str, prompt: str) -> Path:
        return make_output_path(self._outputs_dir, model=model, prompt=prompt, ext="mp4")

    def _generate_via_replicate(self, req: GenerateVideoRequest) -> GenerateVideoResponse:
        if self._generation.is_generation_running():
            raise HTTPError(409, "Generation already in progress")

        generation_id = self._make_generation_id()
        self._generation.start_api_generation(generation_id)

        try:
            self._generation.update_progress("validating_request", 5, None, None)

            api_key = self.state.app_settings.replicate_api_key.strip()
            if not api_key:
                raise HTTPError(400, "REPLICATE_API_KEY_NOT_CONFIGURED")

            duration = self._parse_forced_numeric_field(req.duration, "INVALID_FORCED_API_DURATION")
            aspect_ratio = req.aspectRatio.strip() if req.aspectRatio else "16:9"
            resolution = req.resolution or "720p"
            generate_audio = self._parse_audio_flag(req.audio)

            if self._generation.is_generation_cancelled():
                raise RuntimeError("Generation was cancelled")

            # Seedance 1.5 image-to-video: start frame -> image, end frame -> last_frame_image.
            first_frame_uri = self._image_to_data_uri(req.imagePath)
            last_frame_uri = self._image_to_data_uri(req.lastFramePath)

            self._generation.update_progress("inference", 20, None, None)
            video_bytes = self._video_api_client.generate_video(
                api_key=api_key,
                model=req.model,
                prompt=req.prompt,
                duration=duration,
                resolution=resolution,
                aspect_ratio=aspect_ratio,
                generate_audio=generate_audio,
                first_frame=first_frame_uri,
                last_frame=last_frame_uri,
                seed=self._resolve_seed(),
                camera_fixed=(req.cameraMotion == "static"),
                should_cancel=self._generation.is_generation_cancelled,
            )
            self._generation.update_progress("downloading_output", 85, None, None)

            if self._generation.is_generation_cancelled():
                raise RuntimeError("Generation was cancelled")

            output_path = self._write_forced_api_video(video_bytes, model=req.model, prompt=req.prompt)
            self._maybe_conform_exact(str(output_path), req)
            self._generation.update_progress("complete", 100, None, None)
            self._generation.complete_generation(str(output_path))
            return GenerateVideoResponse(status="complete", video_path=str(output_path))
        except HTTPError as e:
            self._generation.fail_generation(e.detail)
            raise
        except Exception as e:
            self._generation.fail_generation(str(e))
            if "cancelled" in str(e).lower():
                logger.info("Generation cancelled by user")
                return GenerateVideoResponse(status="cancelled")
            raise HTTPError(500, str(e)) from e

    def _generate_via_fal(self, req: GenerateVideoRequest) -> GenerateVideoResponse:
        if self._generation.is_generation_running():
            raise HTTPError(409, "Generation already in progress")

        generation_id = self._make_generation_id()
        self._generation.start_api_generation(generation_id)

        try:
            self._generation.update_progress("validating_request", 5, None, None)

            api_key = self.state.app_settings.fal_api_key.strip()
            if not api_key:
                raise HTTPError(400, "FAL_API_KEY_NOT_CONFIGURED")

            duration = self._parse_forced_numeric_field(req.duration, "INVALID_FORCED_API_DURATION")
            aspect_ratio = req.aspectRatio.strip() if req.aspectRatio else "16:9"
            resolution = req.resolution or "720p"
            generate_audio = self._parse_audio_flag(req.audio)

            if self._generation.is_generation_cancelled():
                raise RuntimeError("Generation was cancelled")

            first_frame_uri = self._image_to_data_uri(req.imagePath)
            last_frame_uri = self._image_to_data_uri(req.lastFramePath)

            # Omni-reference validation (mirror fal's rules; never silently drop).
            if req.audioReferencePaths and not req.referenceImagePaths:
                raise HTTPError(400, "Add at least one reference image to use audio references.")
            if len(req.referenceImagePaths) > 9:
                raise HTTPError(400, "Seedance 2.0 supports at most 9 reference images.")
            if len(req.audioReferencePaths) > 3:
                raise HTTPError(400, "Seedance 2.0 supports at most 3 audio references.")
            if len(req.videoReferencePaths) > 3:
                raise HTTPError(400, "Seedance 2.0 supports at most 3 video references.")
            # Enforce the <=15s reference contract locally — a fast 400 beats
            # minutes of upload followed by a confusing provider-side failure.
            for ref_path in req.videoReferencePaths:
                normalized_ref = normalize_optional_path(ref_path)
                if normalized_ref is None or not Path(normalized_ref).exists():
                    continue  # missing files are skipped by the upload loop below
                try:
                    ref_seconds = self._video_trimmer.probe_duration(normalized_ref)
                except Exception as exc:
                    raise HTTPError(
                        400, f"Could not read video reference: {Path(normalized_ref).name}"
                    ) from exc
                if ref_seconds > 15.5:
                    raise HTTPError(400, "Video references must be 15 seconds or shorter.")

            # Reference arrays are uploaded to hosted URLs (never inlined as base64).
            reference_images: list[str] = []
            for path in req.referenceImagePaths:
                url = self._upload_reference(api_key, path, kind="image")
                if url is not None:
                    reference_images.append(url)
            reference_audio: list[str] = []
            for path in req.audioReferencePaths:
                url = self._upload_reference(api_key, path, kind="audio")
                if url is not None:
                    reference_audio.append(url)
            reference_videos: list[str] = []
            for path in req.videoReferencePaths:
                url = self._upload_reference(api_key, path, kind="video")
                if url is not None:
                    reference_videos.append(url)

            self._generation.update_progress("inference", 20, None, None)
            video_bytes = self._fal_video_client.generate_video(
                api_key=api_key,
                model=req.model,
                prompt=req.prompt,
                duration=duration,
                resolution=resolution,
                aspect_ratio=aspect_ratio,
                generate_audio=generate_audio,
                first_frame=first_frame_uri,
                last_frame=last_frame_uri,
                reference_images=reference_images or None,
                reference_audio=reference_audio or None,
                reference_videos=reference_videos or None,
                seed=self._resolve_seed(),
                should_cancel=self._generation.is_generation_cancelled,
            )
            self._generation.update_progress("downloading_output", 85, None, None)

            if self._generation.is_generation_cancelled():
                raise RuntimeError("Generation was cancelled")

            output_path = self._write_forced_api_video(video_bytes, model=req.model, prompt=req.prompt)
            self._maybe_conform_exact(str(output_path), req)
            self._generation.update_progress("complete", 100, None, None)
            self._generation.complete_generation(str(output_path))
            return GenerateVideoResponse(status="complete", video_path=str(output_path))
        except HTTPError as e:
            self._generation.fail_generation(e.detail)
            raise
        except Exception as e:
            self._generation.fail_generation(str(e))
            if "cancelled" in str(e).lower():
                logger.info("Generation cancelled by user")
                return GenerateVideoResponse(status="cancelled")
            raise HTTPError(500, str(e)) from e

    def _generate_forced_api(self, req: GenerateVideoRequest) -> GenerateVideoResponse:
        # Defense in depth: routing can no longer reach this path
        # (should_video_generate_with_ltx_api is hard False), but if anything
        # ever re-enables it, refuse rather than send data to LTX/Lightricks.
        raise HTTPError(
            400,
            "LTX_API_DISABLED: this build never sends data to the LTX cloud API. "
            "Use local generation, Seedance (Replicate/fal), or Directors Palette.",
        )

    def _write_forced_api_video(self, video_bytes: bytes, *, model: str, prompt: str) -> Path:
        output_path = self._make_output_path(model=model, prompt=prompt)
        output_path.write_bytes(video_bytes)
        return output_path

    def _conform_exact_output(self, output_path: str, seconds: float) -> None:
        """Trim the output to exactly ``seconds`` when it came back longer.
        Providers round durations up into their supported ranges (Seedance 1.5:
        4-12s, 2.0: 4-15s; local LTX rounds to frame batches), so a 3s request
        can come back 4s+ — this hands back precisely what was asked for,
        audio included."""
        if seconds <= 0:
            return
        # Probe failure must NOT discard a completed (possibly paid) generation:
        # some valid MP4 containers (fragmented/odd-moov) play fine but imageio-ffmpeg
        # can't read a duration banner from them. If we can't measure it, deliver as-is.
        try:
            actual = self._video_trimmer.probe_duration(output_path)
        except Exception:
            logger.warning(
                "Exact-duration probe failed; delivering output untrimmed", exc_info=True
            )
            return
        if actual <= seconds + 0.05:
            return
        self._generation.update_progress("conforming_duration", 97, None, None)
        try:
            self._video_trimmer.trim_to(output_path, seconds)
        except Exception:
            # The video is fine, just longer than asked — deliver it rather than
            # discarding a completed (possibly paid) generation over a trim error.
            logger.warning(
                "Exact-duration trim failed; delivering %.2fs output untrimmed", actual, exc_info=True
            )

    def _maybe_conform_exact(self, output_path: str, req: GenerateVideoRequest) -> None:
        if not req.exactDuration:
            return
        try:
            seconds = float(req.duration)
        except (TypeError, ValueError):
            return
        self._conform_exact_output(output_path, seconds)

    @staticmethod
    def _parse_forced_numeric_field(raw_value: str, error_detail: str) -> int:
        try:
            return int(float(raw_value))
        except (TypeError, ValueError):
            raise HTTPError(400, error_detail) from None

    @staticmethod
    def _parse_audio_flag(audio_value: str | bool) -> bool:
        if isinstance(audio_value, bool):
            return audio_value
        normalized = audio_value.strip().lower()
        return normalized in {"1", "true", "yes", "on"}
