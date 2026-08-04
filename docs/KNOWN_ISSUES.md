# Known Issues

## LTX local (on-GPU) generation stalls at ~15% on a 24GB card

**Status:** open, deferred (2026-08-04). Cloud paths (Seedance via Replicate/fal,
MiniMax H3 via fal) are unaffected and are the recommended way to generate today.

**Symptom:** a local `ltx-fast` job reaches `inference` / progress 15 and never
advances. GPU shows 100% utilization but only ~100W draw (real compute is
~340–390W) — the classic Windows shared-memory-fallback thrash.

**Root cause (confirmed by live py-spy stack dump):** the local Gemma-3-12B text
encoder overflows the 24GB card — on its own, or beside the already-staged
transformer — and spills into system RAM over PCIe, running orders of magnitude
slower. The process sits in `base_encoder.py` `precompute()` (the Gemma forward)
with one CPU core pinned and VRAM at ~23.6/24GB, ~0.5GB free.

**Ruled out:** model files are byte-complete (safetensors header vs on-disk size
verified); SageAttention (A/B-tested with `USE_SAGE_ATTENTION=0` — stalled
identically); the prompt enhancer (disabled — no change). This is a text-encoder
VRAM-coexistence problem, consistent with the earlier `ea1ae4d` "text encoder
VRAM OOM" fix — a known-fragile area.

**Partial work already landed:** `TextHandler.precompute_local_embeddings()`
moves the encode to its own up-front phase (`encoding_prompt`) with embedding
injection, so the encode is isolated and correctly labeled rather than hidden
inside diffusion. It does NOT resolve the stall.

**The remaining fix (when someone picks this up):** evict the transformer from
VRAM while the Gemma encode runs, then reload it for diffusion. This frees the
room the 12B encoder needs. Cost: a transformer reload (~30–60s) per generation,
so it wants a keep-warm / cache path to stay reasonable. Alternatively, chase the
transformers-version memory regression directly (the March 2026 benchmark ran
this path fine, per `docs/gpu-optimization-results.md`).
