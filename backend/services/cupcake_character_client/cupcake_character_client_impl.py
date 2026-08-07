"""Phase-1 cupcake character engine: drives the proven SDXL + InstantID + IPAdapter graph
on a remote ComfyUI over HTTP. Faithful to the recipe validated in benchmarks/image on the
GX10 (InstantID face lock + IPAdapter full-character look + prompted scene).

Remote-only: no subprocess management. Reference images are pushed to the remote ComfyUI via
its /upload/image endpoint (a local file copy cannot reach another machine), and the finished
image is pulled back via /view and saved into the caller's outputs dir.
"""

from __future__ import annotations

import json
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable, cast

from .cupcake_character_client import (
    DEFAULT_IPADAPTER_WEIGHT,
    DEFAULT_INSTANTID_WEIGHT,
    DEFAULT_NEGATIVE,
    INSTANTID_CONTROLNET,
    INSTANTID_MODEL,
    SDXL_CHECKPOINT,
)

_MULTIPART_BOUNDARY = "----DDCupcakeBoundary7MA4YWxkTrZu0gW"


class CupcakeCharacterClientImpl:
    """Drives a remote ComfyUI to render an on-model character image. Implements CupcakeCharacterClient."""

    def __init__(
        self,
        *,
        base_url: str = "http://127.0.0.1:8188",
        outputs_dir: Path,
        poll_interval_s: float = 4.0,
        request_timeout_s: int = 120,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._outputs_dir = outputs_dir
        self._poll_interval_s = poll_interval_s
        self._request_timeout_s = request_timeout_s

    # -- ComfyUI HTTP (same shape as the LTX/H3 clients; remote base_url) --------
    def _api(self, path: str, payload: dict[str, Any] | None = None, timeout: int | None = None) -> dict[str, Any]:
        req = urllib.request.Request(self._base_url + path)
        data: bytes | None = None
        if payload is not None:
            data = json.dumps(payload).encode()
            req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, data, timeout=timeout or self._request_timeout_s) as r:  # noqa: S310
            return cast("dict[str, Any]", json.loads(r.read()))

    def _upload_image(self, local_path: str) -> str:
        """Push a local image to the remote ComfyUI input dir via /upload/image (multipart).

        A local filesystem copy (the LTX/H3 ``_stage_input`` trick) cannot reach a remote box,
        so bytes must go over HTTP. Returns the filename ComfyUI stored, for use in LoadImage.
        """
        src = Path(local_path)
        raw = src.read_bytes()
        # Unique name so concurrent/repeat refs never collide on the shared remote input dir.
        remote_name = f"dd_{uuid.uuid4().hex[:12]}_{src.name}"
        body = (
            f"--{_MULTIPART_BOUNDARY}\r\n"
            f'Content-Disposition: form-data; name="image"; filename="{remote_name}"\r\n'
            "Content-Type: application/octet-stream\r\n\r\n"
        ).encode() + raw + (
            f"\r\n--{_MULTIPART_BOUNDARY}\r\n"
            'Content-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n'
            f"--{_MULTIPART_BOUNDARY}--\r\n"
        ).encode()
        req = urllib.request.Request(self._base_url + "/upload/image", data=body)
        req.add_header("Content-Type", f"multipart/form-data; boundary={_MULTIPART_BOUNDARY}")
        with urllib.request.urlopen(req, timeout=self._request_timeout_s) as r:  # noqa: S310
            resp = cast("dict[str, Any]", json.loads(r.read()))
        name = cast("str", resp.get("name", remote_name))
        sub = cast("str", resp.get("subfolder", ""))
        return f"{sub}/{name}" if sub else name

    def _download(self, filename: str, subfolder: str, dest: Path) -> None:
        """Pull a finished image back from the remote ComfyUI via /view into dest."""
        from urllib.parse import urlencode

        qs = urlencode({"filename": filename, "subfolder": subfolder, "type": "output"})
        req = urllib.request.Request(f"{self._base_url}/view?{qs}")
        with urllib.request.urlopen(req, timeout=self._request_timeout_s) as r:  # noqa: S310
            dest.write_bytes(r.read())

    # -- graph (SDXL + InstantID + IPAdapter; the proven kwalker recipe) --------
    def _build_graph(
        self,
        *,
        prompt: str,
        negative_prompt: str,
        face_image: str,
        style_image: str,
        width: int,
        height: int,
        seed: int,
        instantid_weight: float,
        ipadapter_weight: float,
        steps: int,
    ) -> dict[str, Any]:
        neg = negative_prompt or DEFAULT_NEGATIVE
        return {
            "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": SDXL_CHECKPOINT}},
            "2": {"class_type": "InstantIDModelLoader", "inputs": {"instantid_file": INSTANTID_MODEL}},
            "3": {"class_type": "InstantIDFaceAnalysis", "inputs": {"provider": "CPU"}},
            "4": {"class_type": "ControlNetLoader", "inputs": {"control_net_name": INSTANTID_CONTROLNET}},
            "5": {"class_type": "LoadImage", "inputs": {"image": face_image}},
            "20": {"class_type": "IPAdapterUnifiedLoader", "inputs": {"model": ["1", 0], "preset": "PLUS (high strength)"}},
            "21": {"class_type": "LoadImage", "inputs": {"image": style_image}},
            "22": {"class_type": "IPAdapter", "inputs": {
                "model": ["1", 0], "ipadapter": ["20", 1], "image": ["21", 0],
                "weight": ipadapter_weight, "start_at": 0.0, "end_at": 1.0, "weight_type": "standard"}},
            "6": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["1", 1], "text": prompt}},
            "7": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["1", 1], "text": neg}},
            "8": {"class_type": "ApplyInstantID", "inputs": {
                "instantid": ["2", 0], "insightface": ["3", 0], "control_net": ["4", 0], "image": ["5", 0],
                "model": ["22", 0], "positive": ["6", 0], "negative": ["7", 0],
                "weight": instantid_weight, "start_at": 0.0, "end_at": 0.9}},
            "9": {"class_type": "EmptyLatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
            "10": {"class_type": "KSampler", "inputs": {
                "model": ["8", 0], "positive": ["8", 1], "negative": ["8", 2], "latent_image": ["9", 0],
                "seed": seed, "steps": steps, "cfg": 5.0, "sampler_name": "dpmpp_2m_sde", "scheduler": "karras", "denoise": 1.0}},
            "11": {"class_type": "VAEDecode", "inputs": {"samples": ["10", 0], "vae": ["1", 2]}},
            "12": {"class_type": "SaveImage", "inputs": {"images": ["11", 0], "filename_prefix": "cupcake_character"}},
        }

    # -- run --------------------------------------------------------------------
    def generate_image(
        self,
        *,
        prompt: str,
        character_image_path: str,
        style_image_path: str | None = None,
        width: int = 1024,
        height: int = 1024,
        negative_prompt: str = "",
        seed: int = 7,
        instantid_weight: float = DEFAULT_INSTANTID_WEIGHT,
        ipadapter_weight: float = DEFAULT_IPADAPTER_WEIGHT,
        steps: int = 30,
        on_phase: Callable[[str, int], None] | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> str:
        if on_phase:
            on_phase("uploading", 5)
        face_name = self._upload_image(character_image_path)
        # One reference drives both branches; a separate style ref overrides the look branch.
        style_name = self._upload_image(style_image_path) if style_image_path else face_name

        graph = self._build_graph(
            prompt=prompt, negative_prompt=negative_prompt, face_image=face_name, style_image=style_name,
            width=width, height=height, seed=seed, instantid_weight=instantid_weight,
            ipadapter_weight=ipadapter_weight, steps=steps,
        )
        submit = self._api("/prompt", {"prompt": graph})
        prompt_id = cast("str", submit.get("prompt_id", ""))
        if not prompt_id:
            raise RuntimeError("cupcake ComfyUI did not accept the character job")

        if on_phase:
            on_phase("inference", 15)
        return self._poll_until_done(prompt_id, on_phase, should_cancel)

    def _poll_until_done(
        self,
        prompt_id: str,
        on_phase: Callable[[str, int], None] | None,
        should_cancel: Callable[[], bool] | None,
    ) -> str:
        while True:
            if should_cancel and should_cancel():
                try:
                    self._api("/interrupt", {})
                except Exception:
                    pass
                raise RuntimeError("cupcake character render cancelled")
            time.sleep(self._poll_interval_s)
            try:
                hist = self._api(f"/history/{prompt_id}")
            except Exception:
                continue
            if prompt_id not in hist:
                if on_phase:
                    on_phase("inference", 55)
                continue
            info = cast("dict[str, Any]", hist[prompt_id])
            status = cast("dict[str, Any]", info.get("status", {}))
            done = bool(status.get("completed")) or status.get("status_str") in ("success", "error")
            if not done:
                continue
            if status.get("status_str") == "error":
                raise RuntimeError("cupcake ComfyUI reported an error rendering the character")
            if on_phase:
                on_phase("downloading", 95)
            outputs = cast("dict[str, Any]", info.get("outputs", {}))
            for node_out in outputs.values():
                node_dict = cast("dict[str, Any]", node_out)
                for item in cast("list[dict[str, Any]] | None", node_dict.get("images")) or []:
                    fn = item.get("filename")
                    if fn:
                        dest = self._outputs_dir / f"cupcake_{uuid.uuid4().hex[:8]}_{fn}"
                        self._download(cast("str", fn), cast("str", item.get("subfolder", "")), dest)
                        return str(dest)
            raise RuntimeError("cupcake character render finished but produced no image file")
