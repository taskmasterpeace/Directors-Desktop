# Known Issues

## LTX-2.3 local generation — RESOLVED via the ComfyUI engine (2026-08-05)

**Status:** resolved. LTX-2.3 now renders locally on a 24GB 4090 through the
ComfyUI-based engine (`backend/services/ltx_comfy_client/`). The old on-GPU path
through DD's compiled `ltx_pipelines` (model id `ltx-fast`) is superseded by the
`ltx-comfy` engine and is no longer the local LTX route.

**What was wrong before:** a local `ltx-fast` job stalled at ~15% — GPU at 100%
util but only ~100W draw (real compute is ~340–390W), the classic Windows
shared-memory-fallback thrash. Root cause: the 12B Gemma-3 text encoder overflowed
the 24GB card beside the transformer and spilled to system RAM over PCIe.
`ltx_pipelines` couldn't fp8-quantize its text encoder (the fp8 policy is
transformer-specific), so no code change in that library fixed it.

**The fix (exactly the eviction this doc predicted):** drive the native ComfyUI
LTX-2.3 blueprint instead. Two things made it work fast on 24GB:
1. **nvfp4 checkpoint** (`ltx-2.3-22b-dev-nvfp4`) — the fp8 build's DiT is ~22GB
   (22B params) and can't leave room for the encoder; nvfp4 is the 24GB-oriented
   quant.
2. **`--disable-smart-memory`** — ComfyUI evicts the ~8GB Gemma after text-encode
   (GPU encode, fast), so the DiT gets the whole card and runs **compute-bound**
   (measured ~127s cold / ~34s warm for a 2s 480p clip, GPU at ~300–345W) instead
   of block-swapping (~350–630s at any flag with Gemma resident).

Text-encoding on CPU also frees the card but is far too slow (~350s to encode the
12B Gemma), so GPU-encode + eviction is the shipped config.

**Speed reality:** LTX-2.3 is a 22B model, so even fixed it is minutes-scale and
notably slower than H3 (108s/5s). `--disable-smart-memory` reloads the checkpoint
each render. **H3 remains the recommended fast local engine**; LTX-local is the
slower alternative for when its look is wanted. Cloud (Seedance) stays the fast
cloud path.

**Model switching:** H3 (keeps its 20GB DiT resident) and LTX (evicts Gemma) need
opposite ComfyUI memory policies and can't share one instance. Both clients record
the running policy in `<comfy>/dd_comfy_profile.txt` and relaunch ComfyUI under
their own profile on a mismatch (~11s), reusing instantly when it matches. Only
one runs at a time (gpu slot), so this is collision-free. Verified end-to-end.

**Object-removal IC-LoRAs:** Union-Control (depth/pose/edge) is downloaded and
usable. Clean-Plate and In-Outpainting are **gated HuggingFace repos** — they need
the user to accept each model's license and provide an HF token before download.
