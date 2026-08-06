"""Phase-1 local LTX-2.3 engine: drives the official ComfyUI LTX-2.3 node graph.

Faithful to the built-in ComfyUI blueprint "Text to Video (LTX-2.3)" — the same
official fp8 checkpoint (DiT + video VAE + audio VAE in one file), fp4-mixed Gemma
encoder, and distilled speed LoRA, wrapped as an :class:`LTXComfyClient` with the
progress + cancellation the DD queue needs. Isolated behind the Protocol so a
Phase-2 NATIVE (no-ComfyUI) engine can replace it without any change above.

Drives the SAME local ComfyUI instance as the H3 engine (127.0.0.1:8188). Only one
video model fits in 24GB at a time and the gpu slot serialises jobs, so switching
H3<->LTX simply loads the other model set on the next render — no VRAM collision.

The graph below is ported from the official blueprint's node types. The exact node
IO is validated against a live ComfyUI before this engine is offered in the UI (a
first render must produce a real mp4 — green construction tests alone never gate
it). Verified-against-live markers note where that check matters most.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import urllib.request
from pathlib import Path
from typing import Any, Callable, cast

from .ltx_comfy_client import (
    LTX_CKPT,
    LTX_DISTILLED_LORA,
    LTX_FPS,
    LTX_TE,
    ltx_snap_frames,
)

# Distilled 8-step schedule from the blueprint's single-stage ManualSigmas (node
# 308): 9 sigma values = 8 denoise steps. cfg=1 (no CFG) is what "distilled" means.
_DISTILLED_SIGMAS = "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"
_DISTILLED_LORA_STRENGTH = 0.5
_DEFAULT_NEGATIVE = "worst quality, blurry, jittery, distorted, watermark, text"


class ComfyLTXClientImpl:
    """Drives a local ComfyUI instance to render LTX-2.3. Implements LTXComfyClient."""

    def __init__(
        self,
        *,
        comfy_dir: Path,
        text_encoder: str = LTX_TE,
        text_encoder_device: str = "default",
        checkpoint: str = LTX_CKPT,
        lora_src_dir: Path | None = None,
        base_url: str = "http://127.0.0.1:8188",
        poll_interval_s: float = 4.0,
        startup_timeout_s: float = 240.0,
        launch_extra: tuple[str, ...] = (),
    ) -> None:
        self._comfy_dir = comfy_dir
        self._te = text_encoder
        # GPU text-encode (fast) — CPU encode of the 12B Gemma is far too slow
        # (~350s). Eviction is handled by --disable-smart-memory instead (see the
        # launch flags), which frees the ~8GB Gemma before sampling so the DiT gets
        # the whole card and runs compute-bound.
        self._te_device = text_encoder_device
        self._ckpt = checkpoint
        # Extra ComfyUI launch flags (VRAM tuning); empty = default management.
        self._launch_extra = launch_extra
        # Where DD keeps LTX LoRAs it has downloaded (LTXDesktop models dir). Any
        # LoRA a graph names is staged from here into ComfyUI's loras dir if absent
        # — the extra_model_paths empty-path entry doesn't reliably expose them, so
        # we copy rather than depend on config. ComfyUI rescans a loras dir when its
        # mtime changes, so a freshly staged file is picked up on the next submit.
        self._lora_src_dir = lora_src_dir
        self._loras_dir = comfy_dir / "ComfyUI" / "models" / "loras"
        self._base_url = base_url.rstrip("/")
        self._poll_interval_s = poll_interval_s
        self._startup_timeout_s = startup_timeout_s

    def _ensure_lora_staged(self, lora_name: str) -> bool:
        """Ensure a LoRA is present in ComfyUI's loras dir; return whether it is
        available. A bare filename is staged from DD's models dir if missing; a
        subfoldered name (``ltxv/ltx2/...``) is assumed already placed. Returning a
        bool lets the caller skip an unavailable optional LoRA rather than 404.
        """
        dst = self._loras_dir / lora_name
        if dst.exists():
            return True
        if ("/" in lora_name or "\\" in lora_name) or not self._lora_src_dir:
            return False
        # Two source candidates: the models root (curated downloads) and the
        # loras/ subdir (the drop-a-file local LoRA convention).
        for src in (self._lora_src_dir / lora_name, self._lora_src_dir / "loras" / lora_name):
            if src.exists():
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src, dst)
                return True
        return False

    # -- ComfyUI HTTP (identical to the H3 engine — same instance) ----------
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

    _PROFILE_MARKER = "dd_comfy_profile.txt"

    def _launch_flags(self) -> tuple[str, ...]:
        # nvfp4 DiT + --disable-smart-memory: ComfyUI unloads the ~8GB Gemma after
        # encoding, so the DiT gets the whole 24GB card and runs compute-bound
        # (~57s warm / ~127s cold per 2s clip) instead of block-swapping (~350s+).
        return self._launch_extra or ("--disable-smart-memory",)

    def _profile_id(self) -> str:
        # H3 keeps its 20GB DiT resident (smart memory ON); LTX evicts Gemma (smart
        # memory OFF). Those policies can't share one ComfyUI, so the running
        # profile is recorded and a mismatch triggers a relaunch. Safe because the
        # gpu slot serialises jobs — only one engine is ever mid-render.
        return "ltx|" + " ".join(self._launch_flags())

    def _read_profile(self) -> str | None:
        try:
            return (self._comfy_dir / self._PROFILE_MARKER).read_text(
                encoding="utf-8").splitlines()[0]
        except Exception:
            return None

    def _kill_comfy(self) -> None:
        """Kill whatever process is serving port 8188 (robust to a missing/stale
        marker or an externally launched ComfyUI)."""
        try:
            out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True, check=False).stdout
            pids = {ln.split()[-1] for ln in out.splitlines() if ":8188" in ln and "LISTENING" in ln}
            for pid in pids:
                subprocess.run(["taskkill", "/F", "/PID", pid], capture_output=True, check=False)
        except Exception:
            pass

    def _ensure_comfy(self, on_phase: Callable[[str, int], None] | None) -> None:
        want = self._profile_id()
        if self._comfy_up():
            if self._read_profile() == want:
                return  # already running with our memory policy
            # A different (or unknown) engine's ComfyUI is up — stop it, relaunch ours.
            if on_phase:
                on_phase("loading_model", 1)
            self._kill_comfy()
            for _ in range(30):
                if not self._comfy_up():
                    break
                time.sleep(1)
        if on_phase:
            on_phase("loading_model", 2)
        env = {**os.environ, "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"}
        proc = subprocess.Popen(
            [
                str(self._comfy_dir / "python_embeded" / "python.exe"), "-s",
                str(self._comfy_dir / "ComfyUI" / "main.py"), "--windows-standalone-build",
                "--listen", "127.0.0.1", "--port", "8188",
                *self._launch_flags(),
            ],
            cwd=str(self._comfy_dir),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            (self._comfy_dir / self._PROFILE_MARKER).write_text(f"{want}\n{proc.pid}\n", encoding="utf-8")
        except Exception:
            pass
        deadline = time.monotonic() + self._startup_timeout_s
        while time.monotonic() < deadline:
            if self._comfy_up():
                return
            time.sleep(2)
        raise RuntimeError("ComfyUI did not start (local LTX engine unavailable)")

    # -- graph (official blueprint node types; verified against live ComfyUI) --
    def _build_graph(
        self, *, prompt: str, negative_prompt: str, width: int, height: int, frames: int,
        reference_image_path: str | None, lora_name: str | None, lora_strength: float, seed: int,
    ) -> dict[str, Any]:
        neg = negative_prompt or _DEFAULT_NEGATIVE
        # ComfyUI lists a subfoldered LoRA with the OS path separator (backslash on
        # Windows), so the lora_name must use it too or it's "not in list" (400).
        if lora_name:
            lora_name = lora_name.replace("/", os.sep)
        g: dict[str, Any] = {
            # Checkpoint: DiT (MODEL[0]) + video VAE (VAE[2]). Audio VAE via its own loader.
            "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": self._ckpt}},
            # LTX's text-encoder loader needs the checkpoint too (projection layers
            # that map Gemma embeddings into the DiT conditioning space) — verified
            # against blueprint node 319, which carries text_encoder + ckpt_name + device.
            "2": {"class_type": "LTXAVTextEncoderLoader", "inputs": {
                "text_encoder": self._te, "ckpt_name": self._ckpt, "device": self._te_device}},
            "3": {"class_type": "LTXVAudioVAELoader", "inputs": {"ckpt_name": self._ckpt}},
            # Always-on distilled speed LoRA on the DiT.
            "4": {"class_type": "LoraLoaderModelOnly", "inputs": {
                "model": ["1", 0], "lora_name": LTX_DISTILLED_LORA,
                "strength_model": _DISTILLED_LORA_STRENGTH}},
        }
        model_ref = ["4", 0]
        # Optional extra LoRA (style / motion / IC-LoRA) stacked on the distilled one.
        if lora_name:
            g["4b"] = {"class_type": "LoraLoaderModelOnly", "inputs": {
                "model": model_ref, "lora_name": lora_name, "strength_model": lora_strength}}
            model_ref = ["4b", 0]

        g["5"] = {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": prompt}}
        g["6"] = {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": neg}}
        g["7"] = {"class_type": "LTXVConditioning", "inputs": {
            "positive": ["5", 0], "negative": ["6", 0], "frame_rate": float(LTX_FPS)}}

        # Empty video latent — replaced by an image-conditioned latent for i2v.
        g["8"] = {"class_type": "EmptyLTXVLatentVideo", "inputs": {
            "width": width, "height": height, "length": frames, "batch_size": 1}}
        video_latent_ref: list[Any] = ["8", 0]
        if reference_image_path:
            g["8i"] = {"class_type": "LoadImage", "inputs": {"image": Path(reference_image_path).name}}
            g["8p"] = {"class_type": "LTXVPreprocess", "inputs": {"image": ["8i", 0], "img_compression": 18}}
            g["8c"] = {"class_type": "LTXVImgToVideoInplace", "inputs": {
                "vae": ["1", 2], "image": ["8p", 0], "latent": ["8", 0], "strength": 1.0, "bypass": False}}
            video_latent_ref = ["8c", 0]

        g["9"] = {"class_type": "LTXVEmptyLatentAudio", "inputs": {
            "audio_vae": ["3", 0], "frames_number": frames, "frame_rate": LTX_FPS, "batch_size": 1}}
        g["10"] = {"class_type": "LTXVConcatAVLatent", "inputs": {
            "video_latent": video_latent_ref, "audio_latent": ["9", 0]}}

        g["11"] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler_ancestral_cfg_pp"}}
        g["12"] = {"class_type": "ManualSigmas", "inputs": {"sigmas": _DISTILLED_SIGMAS}}
        g["13"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}}
        g["14"] = {"class_type": "CFGGuider", "inputs": {
            "model": model_ref, "positive": ["7", 0], "negative": ["7", 1], "cfg": 1.0}}
        g["15"] = {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["13", 0], "guider": ["14", 0], "sampler": ["11", 0],
            "sigmas": ["12", 0], "latent_image": ["10", 0]}}
        g["16"] = {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["15", 0]}}
        g["17"] = {"class_type": "VAEDecode", "inputs": {"samples": ["16", 0], "vae": ["1", 2]}}
        g["18"] = {"class_type": "LTXVAudioVAEDecode", "inputs": {"samples": ["16", 1], "audio_vae": ["3", 0]}}
        g["19"] = {"class_type": "CreateVideo", "inputs": {"images": ["17", 0], "audio": ["18", 0], "fps": LTX_FPS}}
        g["20"] = {"class_type": "SaveVideo", "inputs": {
            "video": ["19", 0], "filename_prefix": "video/ltx_render", "format": "auto", "codec": "auto"}}
        return g

    def _stage_input(self, src: str) -> None:
        """Copy a reference image into ComfyUI's input dir so LoadImage finds it."""
        dst = self._comfy_dir / "ComfyUI" / "input" / Path(src).name
        if not dst.exists():
            dst.write_bytes(Path(src).read_bytes())

    def _output_path(self, filename: str) -> str:
        return str(self._comfy_dir / "ComfyUI" / "output" / filename)

    # -- run (identical control flow to the H3 engine) ----------------------
    def generate_video(
        self,
        *,
        prompt: str,
        width: int,
        height: int,
        seconds: float,
        negative_prompt: str = "",
        reference_image_path: str | None = None,
        lora_name: str | None = None,
        lora_strength: float = 1.0,
        seed: int = 7,
        on_phase: Callable[[str, int], None] | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> str:
        self._ensure_comfy(on_phase)
        if reference_image_path:
            self._stage_input(reference_image_path)
        # Make every LoRA the graph names resolvable in ComfyUI's loras dir; skip
        # an optional LoRA that isn't downloaded (e.g. a gated IC-LoRA) rather than
        # 404 the whole render — the clip just renders without that adapter.
        self._ensure_lora_staged(LTX_DISTILLED_LORA)
        if lora_name and not self._ensure_lora_staged(lora_name):
            lora_name = None

        frames = ltx_snap_frames(seconds)
        graph = self._build_graph(
            prompt=prompt, negative_prompt=negative_prompt, width=width, height=height,
            frames=frames, reference_image_path=reference_image_path,
            lora_name=lora_name, lora_strength=lora_strength, seed=seed,
        )
        submit = self._api("/prompt", {"prompt": graph})
        prompt_id = cast("str", submit.get("prompt_id", ""))
        if not prompt_id:
            raise RuntimeError("ComfyUI did not accept the LTX job")

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
                raise RuntimeError("LTX render cancelled")
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
                raise RuntimeError("ComfyUI reported an error rendering LTX")
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
            raise RuntimeError("LTX render finished but produced no video file")
