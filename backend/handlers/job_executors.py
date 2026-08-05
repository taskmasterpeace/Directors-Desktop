"""Job executors that bridge the queue system to existing generation handlers."""

from __future__ import annotations

import logging
import os
import shutil
import threading
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

from api_types import GenerateImageRequest, GenerateVideoRequest

if TYPE_CHECKING:
    from app_handler import AppHandler
    from state.job_queue import QueueJob

logger = logging.getLogger(__name__)


def _str_list(value: object) -> list[str]:
    """Coerce an opaque queue-param value into a list of strings.

    A bare string becomes a one-element list — pipeline dependency substitution
    ($dep.result_paths[0]) writes a single path string into list-typed params.
    """
    if isinstance(value, list):
        return [str(item) for item in cast("list[Any]", value)]
    if isinstance(value, str) and value:
        return [value]
    return []


def _param_dict(value: object) -> dict[str, object]:
    """Coerce an opaque queue-param value into a string-keyed dict."""
    if isinstance(value, dict):
        return {str(key): item for key, item in cast("dict[Any, Any]", value).items()}
    return {}


def _prepare_video_params(handler: AppHandler, params: dict[str, Any]) -> dict[str, Any]:
    """Apply the Director's Palette prompt language and resolve reference images.

    1. Expand ``[shot directive]`` tokens (and legacy ``@CharacterName`` text mentions).
    2. Attach character/reference images as REFERENCE images (Seedance 2.0 omni-reference) —
       NEVER as the start frame. The explicit ``imagePath`` stays a separate start-frame control.
    """
    from server_utils.prompt_language import expand_prompt, resolve_reference_mentions

    result: dict[str, Any] = dict(params)

    prompt = result.get("prompt")
    referenced_ids: list[str] = []
    mention_ref_paths: list[str] = []
    if isinstance(prompt, str) and prompt:
        characters = handler.library.list_characters()
        # Resolve @name/@category reference mentions BEFORE expansion rewrites the text.
        mention_ref_paths = resolve_reference_mentions(prompt, handler.library.list_references())
        expanded, referenced_ids = expand_prompt(prompt, characters)
        result["prompt"] = expanded

    ref_paths: list[str] = [p for p in _str_list(result.get("referenceImagePaths")) if p]
    for path in mention_ref_paths:
        if path not in ref_paths:
            ref_paths.append(path)

    character_ids = list(referenced_ids)
    explicit_char = result.get("character_id") or result.get("characterId")
    if explicit_char:
        character_ids.append(str(explicit_char))
    reference_id = result.get("reference_id") or result.get("referenceId")

    for cid in character_ids:
        for path in handler.library.resolve_reference_paths(character_id=cid):
            if path not in ref_paths:
                ref_paths.append(path)
    if reference_id:
        for path in handler.library.resolve_reference_paths(reference_id=str(reference_id)):
            if path not in ref_paths:
                ref_paths.append(path)

    if ref_paths:
        result["referenceImagePaths"] = ref_paths
    return result


class _ProgressSyncer:
    """Copies progress from GenerationHandler to the job queue in a background thread."""

    def __init__(self, handler: AppHandler, job_id: str) -> None:
        self._handler = handler
        self._job_id = job_id
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=2)

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                prog = self._handler.generation.get_generation_progress()
                if prog.phase and prog.phase not in ("", "idle"):
                    self._handler.job_queue.update_job(
                        self._job_id,
                        phase=prog.phase,
                        progress=prog.progress,
                    )
            except Exception:
                pass
            self._stop.wait(0.3)


class GpuJobExecutor:
    """Executes GPU-slot jobs using existing generation handlers."""

    def __init__(self, handler: AppHandler) -> None:
        self._handler = handler

    def execute(self, job: QueueJob) -> list[str]:
        syncer = _ProgressSyncer(self._handler, job.id)
        syncer.start()
        try:
            if job.type == "image":
                result = self._execute_image(job)
            elif job.type == "video":
                if job.model == "h3-local":
                    result = self._execute_h3_local(job)
                elif job.model == "ltx-comfy":
                    result = self._execute_ltx_local(job)
                else:
                    result = self._execute_video(job)
            elif job.type == "long_video":
                result = self._execute_long_video(job)
            else:
                raise ValueError(f"Unknown job type: {job.type}")
            self._try_upload_to_r2(job, result)
            return result
        finally:
            syncer.stop()

    def _try_upload_to_r2(self, job: QueueJob, result_paths: list[str]) -> None:
        """Upload results to R2 if configured."""
        settings = self._handler.state.app_settings
        if not settings.auto_upload_to_r2:
            return
        if not (settings.r2_access_key_id and settings.r2_endpoint):
            return

        from services.r2_client.r2_client_impl import R2ClientImpl

        client = R2ClientImpl(
            access_key_id=settings.r2_access_key_id,
            secret_access_key=settings.r2_secret_access_key,
            endpoint=settings.r2_endpoint,
            bucket=settings.r2_bucket,
            public_url=settings.r2_public_url,
        )

        for path in result_paths:
            try:
                ext = Path(path).suffix
                content_type = "video/mp4" if ext == ".mp4" else "image/png"
                remote_key = f"videos/{job.id}{ext}"
                client.upload_file(local_path=path, remote_key=remote_key, content_type=content_type)
            except Exception as exc:
                logger.warning("R2 upload failed for %s: %s", path, exc)

    def _execute_image(self, job: QueueJob) -> list[str]:
        params = job.params
        req = GenerateImageRequest(
            prompt=str(params.get("prompt", "")),
            # The job's own model decides what runs (mirrors video jobs) so the
            # model picked in the UI is honored instead of the saved default.
            model=job.model or None,
            width=int(params.get("width", 1024)),
            height=int(params.get("height", 1024)),
            numSteps=int(params.get("numSteps", 4)),
            numImages=int(params.get("numImages", 1)),
            loraPath=str(params.get("loraPath")) if params.get("loraPath") else None,
            loraWeight=float(params.get("loraWeight", 1.0)),
            sourceImagePath=str(params.get("sourceImagePath")) if params.get("sourceImagePath") else None,
            strength=float(params.get("strength", 0.65)),
            referenceImagePaths=_str_list(params.get("referenceImagePaths")),
            modelParams=_param_dict(params.get("modelParams")),
        )
        result = self._handler.image_generation.generate(req)
        if result.status == "cancelled":
            raise RuntimeError("Generation was cancelled")
        return result.image_paths or []

    def _execute_video(self, job: QueueJob) -> list[str]:
        params = _prepare_video_params(self._handler, job.params)
        req = GenerateVideoRequest(
            prompt=str(params.get("prompt", "")),
            resolution=str(params.get("resolution", "512p")),
            model=job.model,
            cameraMotion=str(params.get("cameraMotion", "none")),  # type: ignore[arg-type]
            duration=str(params.get("duration", "2")),
            fps=str(params.get("fps", "24")),
            audio=str(params.get("audio", "false")),
            imagePath=str(params.get("imagePath")) if params.get("imagePath") else None,
            audioPath=str(params.get("audioPath")) if params.get("audioPath") else None,
            audioStartTime=float(params.get("audioStartTime", 0.0)),
            audioMaxDuration=(
                float(params["audioMaxDuration"])
                if isinstance(params.get("audioMaxDuration"), (int, float))
                else None
            ),
            lastFramePath=str(params.get("lastFramePath")) if params.get("lastFramePath") else None,
            referenceImagePaths=_str_list(params.get("referenceImagePaths")),
            audioReferencePaths=_str_list(params.get("audioReferencePaths")),
            videoReferencePaths=_str_list(params.get("videoReferencePaths")),
            exactDuration=bool(params.get("exactDuration", False)),
            aspectRatio=str(params.get("aspectRatio", "16:9")),  # type: ignore[arg-type]
            loraPath=str(params.get("loraPath")) if params.get("loraPath") else None,
            loraWeight=float(params.get("loraWeight", 1.0)),
        )
        result = self._handler.video_generation.generate(req)
        if result.status == "cancelled":
            raise RuntimeError("Generation was cancelled")
        if result.video_path is None:
            return []
        return [result.video_path]

    def _execute_h3_local(self, job: QueueJob) -> list[str]:
        """Render on the local MiniMax H3 engine (gpu slot).

        Phase-1 engine drives the proven ComfyUI graph; swappable behind the
        H3LocalClient Protocol. Result is copied into outputs_dir so it lands in
        the Gallery like every other local render.
        """
        from services.h3_local_client import (
            H3_TE_FALLBACK,
            H3_TE_UNCENSORED,
            H3_TE_UNCENSORED_NVFP4,
            ComfyH3LocalClientImpl,
            h3_dimensions,
        )

        params = _prepare_video_params(self._handler, job.params)
        # DD resolution ids -> H3's proven tiers (480p / 544p / 720p).
        res_map = {"480p": "480p", "512p": "544p", "540p": "544p",
                   "544p": "544p", "720p": "720p", "1080p": "720p"}
        h3_res = res_map.get(str(params.get("resolution", "480p")), "480p")
        aspect = str(params.get("aspectRatio", "16:9"))
        width, height = h3_dimensions(h3_res, aspect)
        try:
            seconds = float(str(params.get("duration", "5")))
        except ValueError:
            seconds = 5.0
        try:
            seed = int(params.get("seed", 7))
        except (TypeError, ValueError):
            seed = 7

        refs = _str_list(params.get("referenceImagePaths"))
        image_path = str(params.get("imagePath")) if params.get("imagePath") else None
        reference_image = refs[0] if refs else image_path  # omni-reference (character lock)

        comfy_dir = Path(os.environ.get("DD_COMFY_DIR", r"D:\comfy\ComfyUI_windows_portable"))
        # Prefer the uncensored Heretic encoder that FITS 24GB (NVFP4), then the
        # bigger int8 Heretic (works but spills to RAM on 24GB), then the standard
        # censored encoder as a last resort.
        te_dir = Path(os.environ.get("DD_H3_TE_DIR", r"D:\models\minimax-h3\text_encoders"))
        if (te_dir / H3_TE_UNCENSORED_NVFP4).exists():
            text_encoder = H3_TE_UNCENSORED_NVFP4
        elif (te_dir / H3_TE_UNCENSORED).exists():
            text_encoder = H3_TE_UNCENSORED
        else:
            text_encoder = H3_TE_FALLBACK
        client = ComfyH3LocalClientImpl(comfy_dir=comfy_dir, text_encoder=text_encoder)

        def on_phase(phase: str, percent: int) -> None:
            self._handler.job_queue.update_job(job.id, phase=phase, progress=percent)

        def should_cancel() -> bool:
            current = self._handler.job_queue.get_job(job.id) or job
            return current.status == "cancelled"

        out_path = client.generate_video(
            prompt=str(params.get("prompt", "")),
            width=width,
            height=height,
            seconds=seconds,
            reference_image_path=reference_image,
            seed=seed,
            on_phase=on_phase,
            should_cancel=should_cancel,
        )

        dest = self._handler.config.outputs_dir / f"h3_{job.id}.mp4"
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(out_path, dest)
        return [str(dest)]

    def _execute_ltx_local(self, job: QueueJob) -> list[str]:
        """Render on the local LTX-2.3 engine (gpu slot) via the ComfyUI blueprint.

        Same shape as _execute_h3_local: drives the shared ComfyUI instance behind
        the LTXComfyClient Protocol and copies the result into outputs_dir so it
        lands in the Gallery. Prefers the official fp4-mixed Gemma encoder; falls
        back to the uncensored Heretic fp8 gemma if the official file isn't present.
        """
        from services.ltx_comfy_client import (
            LTX_CKPT,
            LTX_CKPT_NVFP4,
            LTX_TE,
            LTX_TE_UNCENSORED,
            ComfyLTXClientImpl,
            ltx_dimensions,
        )

        params = _prepare_video_params(self._handler, job.params)
        # DD resolution ids -> LTX's two /32-aligned tiers (480p / 720p).
        res_map = {"480p": "480p", "512p": "480p", "540p": "480p",
                   "544p": "480p", "720p": "720p", "1080p": "720p"}
        ltx_res = res_map.get(str(params.get("resolution", "480p")), "480p")
        aspect = str(params.get("aspectRatio", "16:9"))
        width, height = ltx_dimensions(ltx_res, aspect)
        try:
            seconds = float(str(params.get("duration", "5")))
        except ValueError:
            seconds = 5.0
        try:
            seed = int(params.get("seed", 7))
        except (TypeError, ValueError):
            seed = 7

        refs = _str_list(params.get("referenceImagePaths"))
        image_path = str(params.get("imagePath")) if params.get("imagePath") else None
        reference_image = refs[0] if refs else image_path  # first-frame conditioning (i2v)

        model_params = _param_dict(params.get("modelParams"))
        lora_name = str(model_params["ltxLora"]) if model_params.get("ltxLora") else None
        try:
            lora_strength = float(cast("Any", model_params.get("ltxLoraStrength", 1.0)))
        except (TypeError, ValueError):
            lora_strength = 1.0
        negative = str(params.get("negativePrompt", "")) if params.get("negativePrompt") else ""

        comfy_dir = Path(os.environ.get("DD_COMFY_DIR", r"D:\comfy\ComfyUI_windows_portable"))
        ckpt_dir = comfy_dir / "ComfyUI" / "models" / "checkpoints"
        te_dir = comfy_dir / "ComfyUI" / "models" / "text_encoders"
        text_encoder = LTX_TE if (te_dir / LTX_TE).exists() else LTX_TE_UNCENSORED
        # Prefer the nvfp4 checkpoint (the 24GB fit — runs compute-bound with the
        # engine's --disable-smart-memory Gemma eviction). Fall back to the official
        # fp8, which renders but block-swaps on 24GB.
        checkpoint = LTX_CKPT_NVFP4 if (ckpt_dir / LTX_CKPT_NVFP4).exists() else LTX_CKPT
        # DD's downloaded LTX LoRAs (LTXDesktop models dir) — staged into ComfyUI's
        # loras dir on demand so the distilled + any extra LoRA resolve by name.
        lora_src = Path(os.environ.get(
            "DD_LTX_MODELS_DIR",
            os.path.join(os.environ.get("LOCALAPPDATA", ""), "LTXDesktop", "models"),
        ))
        client = ComfyLTXClientImpl(
            comfy_dir=comfy_dir, text_encoder=text_encoder, checkpoint=checkpoint,
            lora_src_dir=lora_src,
        )

        def on_phase(phase: str, percent: int) -> None:
            self._handler.job_queue.update_job(job.id, phase=phase, progress=percent)

        def should_cancel() -> bool:
            current = self._handler.job_queue.get_job(job.id) or job
            return current.status == "cancelled"

        out_path = client.generate_video(
            prompt=str(params.get("prompt", "")),
            width=width,
            height=height,
            seconds=seconds,
            negative_prompt=negative,
            reference_image_path=reference_image,
            lora_name=lora_name,
            lora_strength=lora_strength,
            seed=seed,
            on_phase=on_phase,
            should_cancel=should_cancel,
        )

        dest = self._handler.config.outputs_dir / f"ltx_{job.id}.mp4"
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(out_path, dest)
        return [str(dest)]

    def _execute_long_video(self, job: QueueJob) -> list[str]:
        params = job.params
        video_path = self._handler.video_generation.generate_long_video(
            prompt=str(params.get("prompt", "")),
            image_path=str(params.get("imagePath", "")),
            target_duration=int(params.get("targetDuration", 20)),
            resolution=str(params.get("resolution", "512p")),
            aspect_ratio=str(params.get("aspectRatio", "16:9")),
            fps=int(params.get("fps", 24)),
            segment_duration=int(params.get("segmentDuration", 4)),
            camera_motion=str(params.get("cameraMotion", "none")),  # type: ignore[arg-type]
            lora_path=str(params.get("loraPath")) if params.get("loraPath") else None,
            lora_weight=float(params.get("loraWeight", 1.0)),
            exact_duration=bool(params.get("exactDuration", False)),
        )
        return [video_path]


class ApiJobExecutor:
    """Executes API-slot jobs using existing generation handlers."""

    def __init__(self, handler: AppHandler) -> None:
        self._handler = handler

    def execute(self, job: QueueJob) -> list[str]:
        syncer = _ProgressSyncer(self._handler, job.id)
        syncer.start()
        try:
            from services.recast_client import RECAST_MODELS

            if job.model in RECAST_MODELS:
                # Person replacement: not a text->video generation — route to
                # the recast handler (upload footage + character, run swap).
                return self._handler.recast.execute(
                    job.model,
                    job.params,
                    should_cancel=lambda: (
                        (self._handler.job_queue.get_job(job.id) or job).status == "cancelled"
                    ),
                )
            if job.type == "image":
                return self._execute_image(job)
            elif job.type == "video":
                return self._execute_video(job)
            else:
                raise ValueError(f"Unknown job type: {job.type}")
        finally:
            syncer.stop()

    def _execute_image(self, job: QueueJob) -> list[str]:
        params = job.params
        req = GenerateImageRequest(
            prompt=str(params.get("prompt", "")),
            # The job's own model decides what runs (mirrors video jobs) so the
            # model picked in the UI is honored instead of the saved default.
            model=job.model or None,
            width=int(params.get("width", 1024)),
            height=int(params.get("height", 1024)),
            numSteps=int(params.get("numSteps", 4)),
            numImages=int(params.get("numImages", 1)),
            loraPath=str(params.get("loraPath")) if params.get("loraPath") else None,
            loraWeight=float(params.get("loraWeight", 1.0)),
            sourceImagePath=str(params.get("sourceImagePath")) if params.get("sourceImagePath") else None,
            strength=float(params.get("strength", 0.65)),
            referenceImagePaths=_str_list(params.get("referenceImagePaths")),
            modelParams=_param_dict(params.get("modelParams")),
        )
        result = self._handler.image_generation.generate(req)
        if result.status == "cancelled":
            raise RuntimeError("Generation was cancelled")
        return result.image_paths or []

    def _execute_video(self, job: QueueJob) -> list[str]:
        params = _prepare_video_params(self._handler, job.params)
        req = GenerateVideoRequest(
            prompt=str(params.get("prompt", "")),
            resolution=str(params.get("resolution", "512p")),
            model=job.model,
            cameraMotion=str(params.get("cameraMotion", "none")),  # type: ignore[arg-type]
            duration=str(params.get("duration", "2")),
            fps=str(params.get("fps", "24")),
            audio=str(params.get("audio", "false")),
            imagePath=str(params.get("imagePath")) if params.get("imagePath") else None,
            audioPath=str(params.get("audioPath")) if params.get("audioPath") else None,
            audioStartTime=float(params.get("audioStartTime", 0.0)),
            audioMaxDuration=(
                float(params["audioMaxDuration"])
                if isinstance(params.get("audioMaxDuration"), (int, float))
                else None
            ),
            lastFramePath=str(params.get("lastFramePath")) if params.get("lastFramePath") else None,
            referenceImagePaths=_str_list(params.get("referenceImagePaths")),
            audioReferencePaths=_str_list(params.get("audioReferencePaths")),
            videoReferencePaths=_str_list(params.get("videoReferencePaths")),
            exactDuration=bool(params.get("exactDuration", False)),
            aspectRatio=str(params.get("aspectRatio", "16:9")),  # type: ignore[arg-type]
            loraPath=str(params.get("loraPath")) if params.get("loraPath") else None,
            loraWeight=float(params.get("loraWeight", 1.0)),
        )
        result = self._handler.video_generation.generate(req)
        if result.status == "cancelled":
            raise RuntimeError("Generation was cancelled")
        if result.video_path is None:
            return []
        return [result.video_path]
