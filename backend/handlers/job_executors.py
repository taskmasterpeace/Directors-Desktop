"""Job executors that bridge the queue system to existing generation handlers."""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

from api_types import GenerateImageRequest, GenerateVideoRequest

if TYPE_CHECKING:
    from app_handler import AppHandler
    from state.job_queue import QueueJob

logger = logging.getLogger(__name__)


def _str_list(value: object) -> list[str]:
    """Coerce an opaque queue-param value into a list of strings."""
    if isinstance(value, list):
        return [str(item) for item in cast("list[Any]", value)]
    return []


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
            width=int(params.get("width", 1024)),
            height=int(params.get("height", 1024)),
            numSteps=int(params.get("numSteps", 4)),
            numImages=int(params.get("numImages", 1)),
            loraPath=str(params.get("loraPath")) if params.get("loraPath") else None,
            loraWeight=float(params.get("loraWeight", 1.0)),
            sourceImagePath=str(params.get("sourceImagePath")) if params.get("sourceImagePath") else None,
            strength=float(params.get("strength", 0.65)),
            referenceImagePaths=_str_list(params.get("referenceImagePaths")),
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
            lastFramePath=str(params.get("lastFramePath")) if params.get("lastFramePath") else None,
            referenceImagePaths=_str_list(params.get("referenceImagePaths")),
            audioReferencePaths=_str_list(params.get("audioReferencePaths")),
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
            width=int(params.get("width", 1024)),
            height=int(params.get("height", 1024)),
            numSteps=int(params.get("numSteps", 4)),
            numImages=int(params.get("numImages", 1)),
            loraPath=str(params.get("loraPath")) if params.get("loraPath") else None,
            loraWeight=float(params.get("loraWeight", 1.0)),
            sourceImagePath=str(params.get("sourceImagePath")) if params.get("sourceImagePath") else None,
            strength=float(params.get("strength", 0.65)),
            referenceImagePaths=_str_list(params.get("referenceImagePaths")),
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
            lastFramePath=str(params.get("lastFramePath")) if params.get("lastFramePath") else None,
            referenceImagePaths=_str_list(params.get("referenceImagePaths")),
            audioReferencePaths=_str_list(params.get("audioReferencePaths")),
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
