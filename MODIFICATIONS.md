# Modifications Notice

**Director's Desktop** is a modified fork of **LTX Desktop**
(Copyright 2024 Lightricks), used under the Apache License, Version 2.0.
The unmodified license text is in [`LICENSE.txt`](./LICENSE.txt); third-party
component notices are in [`NOTICES.md`](./NOTICES.md).

This file satisfies Apache-2.0 §4(b) — *"You must cause any modified files to
carry prominent notices stating that You changed the files."*

Director's Desktop is **not affiliated with, endorsed by, or supported by
Lightricks.** Apache-2.0 §6 grants no trademark rights; "LTX", "LTX-2", and
"Lightricks" are marks of Lightricks Ltd. and are referenced here only to
identify the upstream work and the models the application can run.

---

## Summary of significant changes from upstream

**Removed — no Lightricks/LTX network services.** The fork sends nothing to
Lightricks. The LTX cloud generation API (`api.ltx.video`) is permanently
disabled (`should_video_generate_with_ltx_api()` returns hard `False`, enforced
by policy tests), analytics/telemetry is a no-op stub that makes no network
call, the Lightricks auto-update feed is disabled, and cloud text encoding was
removed in favor of a local text encoder. The Windows Python bootstrap was
repointed from Lightricks' GitHub releases + their GCS artifact bucket to this
fork's own release assets.

**Added — Director's Palette integration.** Image generation can route through
the user's Director's Palette account and credits (Palette v2 API), with a
model registry covering Nano Banana 2 / 2 Lite, GPT Image 2, and a Qwen-based
Camera Angle mode; plus reference/character/recipe library sync, one-tap
Wardrobe / Character / Location / Style quick modes, and a 3D-style camera
angle control.

**Added — editing and workflow.** A vendored copy of OpenReel's editor core
(MIT, see `vendor/openreel-core/PROVENANCE.md`), hardware frame extraction,
a Descript-style transcript panel with script-of-truth alignment, clip tools,
batch generation, exact-duration output trimming, and a project/asset model.

**Changed — external providers.** Video generation additionally supports
Seedance via Replicate and fal. Local open-weight generation (LTX-2, Z-Image
Turbo, FLUX) still runs on the user's own GPU.

> Model weights carry their own licenses, separate from this application's
> Apache-2.0 code license. In particular **LTX-2 is distributed under the LTX-2
> Community License**, not Apache-2.0 — see `NOTICES.md` and
> https://github.com/Lightricks/LTX-2/blob/main/LICENSE for its terms,
> including its commercial-use conditions and acceptable-use policy.
