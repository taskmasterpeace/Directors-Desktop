# Shot Creator for Desktop — 1:1 port, organized for desktop

**Date:** 2026-07-19
**Status:** Approved (decisions locked with Robert); phased build
**Source of truth:** Palette `src/features/shot-creator/` (redesign layout)

## Decisions (locked)

1. **Model routing → through Palette (credits).** Desktop generation runs on the
   user's Palette account/credits via Palette's API — identical models and
   behavior to Shot Creator, drawing from the one credit balance (the desktop
   credits fix, deployed 2026-07-19, made this balance correct). No direct
   Replicate/fal keys for these image models.
2. **First scope → image Shot Creator.** The 4 current image models + full
   prompt language + Wardrobe/Character/Location quick-mode buttons + camera
   angle + reference tags, as a **dedicated desktop view**. Video (Shot
   Animator) already has a desktop equivalent (Playground Seedance +
   animate-still); it comes in a later phase.
3. **Camera angle → full 3D gizmo.** Port Palette's Three.js orbit gizmo
   faithfully (adds `three` to desktop deps).
4. **Nav → reorganize, Recipes → Tools** (structure below, for approval).

## Current models (no old ones)

Image (Palette `src/config/index.ts` `MODEL_CONFIGS`, non-hidden):
| Desktop id | Display | Palette endpoint | Cost (pts) | Refs | Key params |
|---|---|---|---|---|---|
| `nano-banana-2` | Nano Banana 2 | `google/nano-banana-2` | 10/15/20 (1K/2K/4K) | 14 | resolution, safetyFilterLevel, personGeneration, googleSearch, imageSearch |
| `nano-banana-2-lite` | Nano Banana 2 Lite | `google/nano-banana-2-lite` | 5 (1K) | 14 | jpg/png only, no search |
| `qwen-image-edit` | Camera Angle | `qwen/qwen-image-edit-plus-lora` | 5 | 1 (required) | camera lora + `<sks> {azimuth}{elevation}{distance}` prompt, loraScale |
| `gpt-image-2` | GPT Image 2 | `openai/gpt-image-2` | 2 (low)/8 (med) | 10 | quality, aspect (1:1/3:2/2:3), background, moderation, numberOfImages |

Excluded (old/retired): `flux-2-klein-9b` (LoRA engine, hidden), and all
`DEPRECATED_MODEL_MAP` ids (nano-banana, seedream-5-lite, riverflow-2-pro,
z-image-turbo, …). Migration: any stored deprecated id → `nano-banana-2`.

## Architecture — route through Palette

**Palette side (directors-palette-v2), needs deploy:**
- Extend `POST /api/v1/images/generate` (already Bearer `dp_`-key, runs on
  credits). Today `VALID_MODEL_IDS = {nano-banana-2, flux-2-klein-9b}`. Change to
  `{nano-banana-2, nano-banana-2-lite, gpt-image-2, qwen-image-edit}`, thread the
  per-model params (resolution/quality/camera/loraScale/…) into
  `ImageGenerationService.buildReplicateInput` (which already supports every
  model), and deduct credits per model. Drop flux.

**Desktop side (directors-desktop):**
- `PaletteImageClientImpl.generate_image` gains an optional `params: dict`
  passthrough for the extra per-model settings (currently only prompt/model/
  aspectRatio/referenceImages). Backend `api_types` + image handler thread it.
- **Prompt language runs client-side** (as in Palette): the resolved/expanded
  prompt is what's sent to `/api/v1/images/generate`. Slot-machine + prompt
  enhance call existing Palette desktop endpoints where available.

## Prompt language (port to `frontend/lib`, pure + tested)

- `parseDynamicPrompt`: wildcards `_name_` / `_name=value_` (first), then bracket
  variations `[a,b,c]` (≤50, confirm >10), pipe/multi-stage chains `a | b | c`
  (each stage feeds the next as a ref image), cross-product `[a,b] x | [c,d] y`
  (cap 10), slot machine `{seed}` (AI-expanded via endpoint).
- `parse-reference-tags`: `@tag`, versioned `@tag:v2`/`:latest`, category
  `@people/@places/@props/@layouts`, positional `@IMG_n`; prompt-library
  categories (`@cinematic`…) are NOT image refs (filtered). Rewrites each `@tag`
  to `@tag (REF:IMG_n)` mapping name→attached image index.
- Granular disables: rawPromptMode, disable{Pipe,Bracket,Wildcard,SlotMachine}Syntax.

## Camera angle (port `helpers/camera-angle.helper.ts` + gizmo)

`CameraAngle {azimuth 0-360, elevation -30..60, distance 0-10}` →
`buildCameraAnglePrompt` = `"<sks> {azimuth-view} {elevation-shot} {distance-shot}"`
prepended to the prompt; sent with the qwen lora (`MULTI_ANGLE_LORA_URL`,
`loraScale` default 0.5). 8 presets (Front/Right/Back/Left/Hero Low/Bird's
Eye/Close-up/Wide). Full Three.js orbit gizmo for interactive selection.

## Quick-mode buttons (Wardrobe / Character / Location / Style)

Port `QuickModeIcons`: Style Sheet + Wardrobe set `quickMode`
(`'style-transfer'|'wardrobe'`); Character Sheet + Location Sheet activate the
matching **recipe** (character sheet / master location reference sheet). Uses the
existing desktop Characters/References/Recipes libraries as the entity sources.

## Dedicated Shot Creator view (redesign layout)

`frontend/views/ShotCreator.tsx` (+ `frontend/views/shot-creator/` parts):
- **TopStrip**: progressive ref slots (drag-drop) · model selector · aspect ·
  quick-mode icons (Style/Char/Location/Wardrobe) · Recipes dropdown · kebab.
- **PromptArea**: hero textarea with `@` and `_` autocomplete, syntax feedback,
  cost line, sticky Generate bar (Batch x1/x3/x5, pts, cancel).
- **StylePicker**: System/Personal/Recent + inline gen settings.
- **AdvancedDisclosure**: seed/guidance/safety/search/loraScale/presets + the
  syntax-mode toggles.
- **Camera-angle panel**: the 3D gizmo when Camera Angle model is selected.
- Right: gallery / references tabs.

## Nav reorganization (for approval)

Current — Library: Gallery·Characters·Styles·References·Recipes / Tools:
Wildcards·Prompt Library·Clip Tool. Proposed:
- **CREATE**: Shot Creator (new) · Playground
- **ASSETS**: Gallery · Characters · Styles · References
- **TOOLS**: Recipes (moved) · Wildcards · Prompt Library · Clip Tool

Rationale: generation surfaces vs reusable content vs utilities; Recipes are a
prompt-building utility, not a standalone asset → Tools.

## Phasing

1. **Foundation** (pure, testable): prompt-language engine + reference-tag parser
   + 4-model registry + camera-angle helper — `frontend/lib`, vitest.
2. **Palette endpoint**: extend `/api/v1/images/generate` to the 4 models + deploy.
3. **Desktop plumbing**: PaletteImageClient params passthrough; image handler +
   api_types; backend tests.
4. **View**: Shot Creator UI (TopStrip/PromptArea/StylePicker/Advanced),
   generation wiring, gallery.
5. **Camera gizmo**: three.js orbit gizmo.
6. **Quick modes**: Style/Char/Location/Wardrobe buttons.
7. **Nav reorg** (after approval).

Each phase keeps the suite green (typecheck, vitest, backend pytest, build).

---

## ⚠️ ARCHITECTURE CORRECTION (2026-07-19, after mapping the live Palette source)

The plan above assumed the target was `POST /api/v1/images/generate` and that it must
be extended + deployed. **That is wrong.** Mapping `directors-palette-v2` revealed:

- **`/api/v1/images/generate` is legacy** — hard-codes `VALID_MODEL_IDS =
  {nano-banana-2, flux-2-klein-9b}`, flat pricing, no version-hash routing (so
  `qwen-image-edit` would silently run without its pinned version + multi-angle
  LoRA). Do **not** target it.
- **`/api/v2/images/generate` already accepts all 4 current models**, with
  tier-aware pricing, version-hash routing, gpt/qwen params, and credit
  refund-on-failure. **It is already live** — so **NO Palette deploy is needed.**
  Task "extend the endpoint" (#13) is **eliminated.**

### The desktop integration (route through Palette v2, Bearer `dp_` key)

Response envelope everywhere: `{ success: true, data: … }` (errors:
`{ success: false, error: { code, message } }`).

1. **References must be public http URLs.** v2 has an SSRF guard
   (`isPublicHttpUrl`) that **rejects base64 data URIs** — the desktop's current
   `_encode_reference_images` approach fails on v2. So any local reference image
   must first be **uploaded**:
   - `POST /api/v2/images/upload` — **multipart/form-data**, field `file`
     (jpeg/png/webp, ≤50 MB, **≥256×256**). Returns `data.url` (public). Optional
     `name`, `reference_tag`, `reference_category`, `workspace_id`.

2. **Standard models** (`nano-banana-2`, `nano-banana-2-lite`, `gpt-image-2`) —
   **async, poll**:
   - `POST /api/v2/images/generate` → body `{ model, prompt, aspect_ratio,
     reference_images: [url…], num_images: 1, seed?, quality?/background?/moderation? (gpt only) }`
     → `data = { job_id, status: 'pending', … }`.
   - Poll `GET /api/v2/jobs/{job_id}` every ~2 s → `data = { status, result, error_message }`.
     On `status === 'completed'` → **`data.result.url`** (the public image URL, written by
     Palette's own Replicate webhook → `result: { url, metadata }`). On `'failed'` →
     `data.error_message` (pts auto-refunded server-side). Add a hard timeout (~5 min).
   - Palette's server receives the Replicate webhook; the **desktop never needs a
     webhook receiver** — it only polls.

3. **Camera Angle** (`qwen-image-edit`) — **synchronous, one call**:
   - `POST /api/v2/images/camera-angle` → body `{ image_url (required, public),
     azimuth, elevation, distance, prompt?, lora_scale? (def 0.5), aspect_ratio?
     (def match_input_image), output_format? }`. The route builds the `<sks>` prompt +
     injects the multi-angle LoRA + polls Replicate itself, returning `data = { url,
     prediction_id, camera, … }` directly. So the **gizmo's raw azimuth/elevation/
     distance go straight to the API** — no client-side `<sks>` needed for this path.

### Revised desktop plumbing (replaces Phase 2 + Phase 3)

- Rework `PaletteImageClientImpl` (base `https://directorspal.com`) into three ops:
  `upload_reference(bytes) -> url`, `generate_and_wait(model, prompt, aspect,
  ref_urls, params) -> bytes` (submit + poll jobs + download), and
  `camera_angle(image_url, azimuth, elevation, distance, params) -> bytes`
  (sync + download). Keep defensive URL extraction (`data.result.url` / `data.url`).
- `image_generation_handler._generate_via_api`: upload local refs → URLs (instead of
  base64), then branch `qwen-image-edit → camera_angle`, else `generate_and_wait`.
- `modelParams` passthrough (already shipped) carries per-model settings
  (resolution/quality/background/moderation/loraScale/camera*).

### Model IDs (desktop `dp-<id>`), from Palette `MODEL_CONFIGS` (exclude hidden flux)

| dp id | display | endpoint | maxRefs | requiresInput | cost pts (tier) |
|---|---|---|---|---|---|
| `dp-nano-banana-2` | Nano Banana 2 | v2/images/generate | 14 | no | 10/15/20 (1K/2K/4K) |
| `dp-nano-banana-2-lite` | Nano Banana 2 Lite | v2/images/generate | 14 | no | 5 |
| `dp-gpt-image-2` | GPT Image 2 | v2/images/generate | 10 | no | 2/8 (low/med quality) |
| `dp-qwen-image-edit` | Camera Angle | v2/images/**camera-angle** | 1 | **yes** | 5 |

Excluded: `flux-2-klein-9b` (hidden/retired; `DEPRECATED_MODEL_MAP` → nano-banana-2).
