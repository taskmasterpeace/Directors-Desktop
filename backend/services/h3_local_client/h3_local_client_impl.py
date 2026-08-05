"""Phase-1 local H3 engine: drives the proven ComfyUI node graph on the 4090.

A faithful port of the validated `render.py` battery — same weights, same graph,
same int8 config, same frame-snap — wrapped as an :class:`H3LocalClient` with the
progress + cancellation the DD queue needs. This is deliberately isolated behind
the Protocol so the Phase-2 NATIVE (no-ComfyUI) engine can replace it without any
change above this file.

ComfyUI MUST be launched with ``--vram-headroom 2`` or a 5s clip thrashes to
system RAM and takes ~20 min; :meth:`_ensure_comfy` sets that. The first render
of a session pays a ~9 min model load; every render after is fast, so callers
should batch by model type (omni-ref vs first/last are two 20GB DiTs, only one
fits in 24GB).
"""

from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path
from typing import Any, Callable, cast

from .h3_local_client import H3_TE_UNCENSORED, H3Quant, h3_snap_frames

_FPS = 24

# VAEs are shared across modes; the two DiTs are mode-specific. The text encoder
# is chosen by the caller (uncensored Heretic by default) via the constructor.
_VIDEO_VAE = "minimax_h3_video_vae_fp16.safetensors"
_AUDIO_VAE = "minimax_h3_audio_vae_fp32.safetensors"
_DITS: dict[str, dict[str, str]] = {
    "int8": {
        "fl": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
        "ref": "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    },
    "fp8": {
        "fl": "minimax_h3_fl2va_pruned_fp8_scaled.safetensors",
        "ref": "minimax_h3_ref2va_pruned_int8_convrot.safetensors",  # no fp8 ref exists
    },
}


class ComfyH3LocalClientImpl:
    """Drives a local ComfyUI instance to render H3. Implements H3LocalClient."""

    def __init__(
        self,
        *,
        comfy_dir: Path,
        text_encoder: str = H3_TE_UNCENSORED,
        base_url: str = "http://127.0.0.1:8188",
        poll_interval_s: float = 4.0,
        startup_timeout_s: float = 240.0,
    ) -> None:
        self._comfy_dir = comfy_dir
        self._te = text_encoder
        self._base_url = base_url.rstrip("/")
        self._poll_interval_s = poll_interval_s
        self._startup_timeout_s = startup_timeout_s

    # -- ComfyUI HTTP ------------------------------------------------------
    def _api(self, path: str, payload: dict[str, Any] | None = None, timeout: int = 60) -> dict[str, Any]:
        req = urllib.request.Request(self._base_url + path)
        data: bytes | None = None
        if payload is not None:
            data = json.dumps(payload).encode()
            req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, data, timeout=timeout) as r:  # noqa: S310 - localhost only
            return cast("dict[str, Any]", json.loads(r.read()))

    def _comfy_up(self) -> bool:
        try:
            self._api("/system_stats", timeout=4)
            return True
        except Exception:
            return False

    def _ensure_comfy(self, on_phase: Callable[[str, int], None] | None) -> None:
        if self._comfy_up():
            return
        if on_phase:
            on_phase("loading_model", 2)
        env = {**os.environ, "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"}
        subprocess.Popen(
            [
                str(self._comfy_dir / "python_embeded" / "python.exe"), "-s",
                str(self._comfy_dir / "ComfyUI" / "main.py"), "--windows-standalone-build",
                "--listen", "127.0.0.1", "--port", "8188", "--vram-headroom", "2",
            ],
            cwd=str(self._comfy_dir),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + self._startup_timeout_s
        while time.monotonic() < deadline:
            if self._comfy_up():
                return
            time.sleep(2)
        raise RuntimeError("ComfyUI did not start (local H3 engine unavailable)")

    # -- graph -------------------------------------------------------------
    def _build_graph(
        self, *, prompt: str, width: int, height: int, frames: int, quant: H3Quant,
        ref: str | None, first: str | None, last: str | None, seed: int,
    ) -> dict[str, Any]:
        use_ref = ref is not None
        dit = _DITS[quant]["ref" if use_ref else "fl"]
        node = "MiniMaxH3ReferenceToVideo" if use_ref else "MiniMaxH3ImageToVideo"
        v: dict[str, Any] = {
            "clip": ["2", 0], "vae": ["3", 0], "prompt": prompt,
            "width": width, "height": height, "length": frames,
        }
        g: dict[str, Any] = {
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": dit, "weight_dtype": "default"}},
            "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": self._te, "type": "minimax", "device": "default"}},
            "3": {"class_type": "VAELoader", "inputs": {"vae_name": _VIDEO_VAE}},
            "4": {"class_type": "VAELoader", "inputs": {"vae_name": _AUDIO_VAE}},
            "7": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
            "8": {"class_type": "BasicScheduler", "inputs": {"scheduler": "simple", "steps": 20, "denoise": 1.0, "model": ["1", 0]}},
            "9": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        }
        if use_ref:
            v["audio_vae"] = ["4", 0]
            v["ref_image_size"] = "match"
            g["5"] = {"class_type": "LoadImage", "inputs": {"image": Path(ref).name}}
            v["ref_images.ref_image_0"] = ["5", 0]
        g["6"] = {"class_type": node, "inputs": v}
        g["10"] = {"class_type": "BasicGuider", "inputs": {"model": ["1", 0], "conditioning": ["6", 0]}}
        g["11"] = {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["9", 0], "guider": ["10", 0], "sampler": ["7", 0], "sigmas": ["8", 0], "latent_image": ["6", 1]}}
        g["12"] = {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["3", 0]}}
        g["13"] = {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["11", 0], "vae": ["4", 0]}}
        g["14"] = {"class_type": "CreateVideo", "inputs": {"images": ["12", 0], "audio": ["13", 0], "fps": _FPS}}
        g["15"] = {"class_type": "SaveVideo", "inputs": {"video": ["14", 0], "filename_prefix": "video/h3_render", "format": "auto", "codec": "auto"}}
        return g

    def _stage_input(self, src: str) -> None:
        """Copy a reference/keyframe image into ComfyUI's input dir so LoadImage finds it."""
        dst = self._comfy_dir / "ComfyUI" / "input" / Path(src).name
        if not dst.exists():
            dst.write_bytes(Path(src).read_bytes())

    def _output_path(self, filename: str) -> str:
        return str(self._comfy_dir / "ComfyUI" / "output" / filename)

    # -- run ---------------------------------------------------------------
    def generate_video(
        self,
        *,
        prompt: str,
        width: int,
        height: int,
        seconds: float,
        quant: H3Quant = "int8",
        reference_image_path: str | None = None,
        first_frame_path: str | None = None,
        last_frame_path: str | None = None,
        seed: int = 7,
        on_phase: Callable[[str, int], None] | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> str:
        self._ensure_comfy(on_phase)
        if reference_image_path:
            self._stage_input(reference_image_path)
        if first_frame_path:
            self._stage_input(first_frame_path)

        frames = h3_snap_frames(seconds)
        graph = self._build_graph(
            prompt=prompt, width=width, height=height, frames=frames, quant=quant,
            ref=reference_image_path, first=first_frame_path, last=last_frame_path, seed=seed,
        )
        submit = self._api("/prompt", {"prompt": graph})
        prompt_id = cast("str", submit.get("prompt_id", ""))
        if not prompt_id:
            raise RuntimeError("ComfyUI did not accept the H3 job")

        if on_phase:
            on_phase("inference", 10)
        return self._poll_until_done(prompt_id, on_phase, should_cancel)

    def _poll_until_done(
        self, prompt_id: str,
        on_phase: Callable[[str, int], None] | None,
        should_cancel: Callable[[], bool] | None,
    ) -> str:
        while True:
            if should_cancel and should_cancel():
                try:
                    self._api("/interrupt", {})
                except Exception:
                    pass
                raise RuntimeError("H3 render cancelled")
            time.sleep(self._poll_interval_s)
            try:
                hist = self._api(f"/history/{prompt_id}")
            except Exception:
                continue
            if prompt_id not in hist:
                if on_phase:
                    on_phase("inference", 50)
                continue
            info = cast("dict[str, Any]", hist[prompt_id])
            status = cast("dict[str, Any]", info.get("status", {}))
            done = bool(status.get("completed")) or status.get("status_str") in ("success", "error")
            if not done:
                continue
            if status.get("status_str") == "error":
                raise RuntimeError("ComfyUI reported an error rendering H3")
            if on_phase:
                on_phase("decoding", 95)
            outputs = cast("dict[str, Any]", info.get("outputs", {}))
            for node_out in outputs.values():
                node_dict = cast("dict[str, Any]", node_out)
                for key in ("video", "videos", "gifs", "images"):
                    items = cast("list[dict[str, Any]] | None", node_dict.get(key))
                    for item in items or []:
                        fn = item.get("filename")
                        sub = item.get("subfolder", "")
                        if fn:
                            rel = f"{sub}/{fn}" if sub else fn
                            return self._output_path(cast("str", rel))
            raise RuntimeError("H3 render finished but produced no video file")
