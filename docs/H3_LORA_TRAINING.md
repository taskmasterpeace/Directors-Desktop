# Training MiniMax H3 LoRAs (local, on the 4090/5090)

*Written 2026-08-04. How to train a character/style LoRA for MiniMax H3 on this rig,
what the dataset must look like, and how it relates to Directors Desktop.*

> License: fine-tuned H3 weights are **Model Derivatives** under the MiniMax H3
> Community License (territory + attribution terms apply). MKL holds special
> permission — see the H3-local project note.

---

## The tool: AI-Toolkit (ostris)

H3 LoRA training landed first in **AI-Toolkit** (T2V and first-frame I2V modes).
You already have it installed:

- **Location:** `D:\git\AI-Toolkit-Easy-Install\`
- **Launch the web UI:** `Start-AI-Toolkit.bat`
- **⚠️ Update first:** the current install predates H3 — run `Update-AI-Toolkit.bat`
  once so "MiniMax H3" shows up as a trainable model. (Verified: no `minimax/h3`
  references in the current install tree.)

Alternatives, if AI-Toolkit's H3 support isn't ready:
- **IAmIronMan42/MiniMax-H3-FineTuning** — a ~150-line trainer + latent caching on
  the official Diffusers H3 integration. Checkpoints store only trainable tensors
  (a few MB, not ~66 GB). Needs Python 3.11, torch ≥ 2.8, a pinned Diffusers revision.
- **musubi-tuner** — already installed via Pinokio (`D:\pinokio\api\musubi-tuner.pinokio.git`);
  check its changelog for H3 before relying on it.

---

## Dataset (the part that actually decides quality)

1. **Pick the mode before you shoot clips:** T2V (prompt→video) or first-frame I2V.
   A character LoRA is usually T2V.
2. **Clips:** 15–40 short clips of the subject, varied angles/lighting/action.
   Consistency of the *subject*, variety of *everything else*.
3. **Respect H3's temporal grid (17n+5).** Frame counts snap to `n + (5 - n%17)%17`
   — 5 s @ 24 fps → 124 frames, 15 s → 362. Trim training clips so they land on the
   grid (or let the trainer bucket them); off-grid clips waste frames.
4. **Captions:** one `.txt` per clip, same basename. Describe the scene; use a rare
   trigger token for the subject (e.g. `mkl_khadijah woman ...`).
5. **Resolution:** train at the tier you'll generate at — **480p (854×480)** or
   544p. Don't train 720p unless you'll infer 720p (cost scales ~tokens^1.85).
6. **Audio is supervised data** in H3 — if the clips have audio, the trainer can use
   it; for a pure visual character LoRA you can ignore/strip it.

---

## Config essentials

- **Rank:** 16–32 for a character (higher = more capacity + bigger file + overfit risk).
- **Steps:** start ~1500–3000; watch samples, stop when the subject locks in.
- **LR:** AI-Toolkit's H3 defaults are a sane start; only tune after a baseline run.
- **Base weights:** point at the int8 DiT you infer with
  (`minimax_h3_fl2va_pruned_int8_convrot` for T2V/first-last;
  `..._ref2va_...` for omni-reference), from `D:\models\minimax-h3\diffusion_models\`.
- **VRAM:** 24 GB is tight for a 32B-TE model — use the int8/quantized path and
  `--vram-headroom`-style spillover guards, same lesson as inference.

Output: a small `.safetensors` LoRA (a few MB).

---

## How this connects to Directors Desktop

DD's H3 engine (`backend/services/h3_local_client/`) renders through the proven
ComfyUI graph. **H3 LoRA loading in DD is a follow-up** — the graph would need a
`LoraLoader` (or H3's LoRA node) inserted before the sampler, plus a LoRA picker in
the UI (mirroring the existing local-LTX LoRA controls). For now:

1. Train the LoRA in AI-Toolkit.
2. Test it in AI-Toolkit / ComfyUI to confirm it works.
3. Then we wire H3-LoRA selection into DD's `h3-local` path (small, well-scoped add
   on top of the shipped engine).

**Tonight's fast path:** `Update-AI-Toolkit.bat` → `Start-AI-Toolkit.bat` → new job →
pick MiniMax H3 → drop the clip folder + captions → 480p, rank 16, ~2000 steps → go.
