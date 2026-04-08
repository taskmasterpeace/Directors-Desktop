# Batch Creation Pipeline — Design Spec

**Date:** 2026-04-08
**Status:** Approved for implementation planning

## Purpose

Let the user create many images and videos in one pass instead of clicking through the single-prompt UI N times. Two paired workflows:

1. **Batch Text → Images** — feed a list of prompts, get back a gallery of images
2. **Batch Images → Videos** — point at a folder of images, auto-generate animation prompts, get back a gallery of videos

The workflows chain: Feature 1's output flows into Feature 2 with one click. But each also works standalone, because the user often already has 50 images sitting on disk that they want animated.

## Why now

- The existing single-prompt UI doesn't scale past ~5 generations without friction
- The user has ~50 Flux Dev LoRAs locally and wants to run concept sweeps
- Image→video is the natural next step after generation, and doing it one at a time is the main bottleneck
- The job queue already supports `batch_id` on jobs; the plumbing exists but no UI drives it yet

## Non-goals

Explicitly **not** building in this spec:

- Per-prompt LoRA switching (one LoRA applies to the whole batch)
- Prompt templates or variable substitution
- Scheduling / overnight runs
- Auto-retry on failure (failed jobs stay errored; user retries manually)
- Pause/resume mid-batch
- Reading captions from existing `.json` sidecar files (captions come fresh from the vision model — deterministic, no schema guessing)
- Parallelism beyond the existing GPU/API slot split in `QueueWorker`

## Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│  Frontend: new "Batch" sidebar view                         │
│  ┌─────────────────────┐  ┌──────────────────────────────┐  │
│  │ Tab 1:              │  │ Tab 2:                       │  │
│  │ Prompts → Images    │  │ Images → Videos              │  │
│  │                     │  │                              │  │
│  │ - Textarea          │  │ - File/folder picker         │  │
│  │ - Load .txt button  │  │ - Contact-sheet grid         │  │
│  │ - Prompt count      │  │ - Auto-caption button        │  │
│  │ - Image settings    │  │ - Per-tile editable prompt   │  │
│  │ - "Generate N"      │  │ - Target model selector      │  │
│  └─────────┬───────────┘  │ - Aspect ratio flagging      │  │
│            │              │ - Video settings             │  │
│            │ "Animate     │ - "Animate N (~time)"        │  │
│            └─ all →"─────▶│                              │  │
│                           └──────┬───────────────────────┘  │
└──────────────────────────────────┼──────────────────────────┘
                                   │
                ┌──────────────────┼───────────────────┐
                │                  │                   │
          POST /api/batch/   POST /api/batch/    POST /api/caption-image
          submit-images      submit-videos       (vision caption)
                │                  │                   │
                ▼                  ▼                   ▼
          BatchHandler       BatchHandler        EnhancePromptHandler
          (new)              (new)               (existing — extended)
                │                  │                   │
                ▼                  ▼                   ▼
          JobQueue           JobQueue            OpenRouter
          (N image jobs,     (N video jobs,      (Qwen 2.5 VL)
           shared batch_id)   shared batch_id)
```

## UI design

### Sidebar entry

New top-level sidebar item **"Batch"** with a grid/stack icon, sitting alongside existing library entries.

### Batch view layout

Two tabs: **"Prompts → Images"** and **"Images → Videos"**.

### Tab 1 — Prompts → Images

**Top:**
- Large textarea (full width, ~15 rows) for prompts
- "Load from .txt" button above the textarea — opens the Electron file picker, fills the textarea with file contents
- Live count shown below the textarea: `"23 prompts detected"` (updates on every keystroke)

**Parsing rule:** Prompts are separated by **one or more blank lines**. Each prompt can be multiple lines (a paragraph). Trailing/leading whitespace per prompt is stripped.

**Right side — settings panel:** Reuses existing image settings components (`ImageGenerationSettings` or equivalent):
- Image model (Flux Dev / Flux Klein / Z-Image / Nano Banana)
- LoRA path, weight, trigger phrase, trigger mode
- Resolution, aspect ratio, steps
- Seed behavior (locked or random — if locked, same seed used for all; if random, each prompt gets a different seed)

**Bottom:**
- Run button: `"Generate 23 images"` — count in the button label so there's no accidental submission
- Disabled when count is 0 or while batch is running

**Running state:**
- Per-job progress shown via the existing queue status UI
- Results stream into a grid above the queue as they complete
- "Animate all →" button appears once the batch completes, switching to Tab 2 with the batch's images pre-loaded

### Tab 2 — Images → Videos

**Top bar:**
- **Target model selector:** `LTX-2 Fast` / `LTX-2 Pro` / `Seedance 1.5 Pro`
  - Changes which aspect ratios are considered "compatible"
  - Passed to the auto-captioner as context
- **"Add images" button** — opens a file picker (multi-select) with an "Add folder" option
- **"Clear all" button**

**Contact-sheet grid** (main area):
- Responsive grid, 4–6 tiles per row depending on viewport
- Each tile shows:
  - Thumbnail (square crop preview, full image on hover)
  - Filename (truncated) and dimensions + aspect ratio
  - Editable prompt textarea (3 rows, auto-growing)
  - Small refresh icon → regenerate caption for this image
  - Small X icon → remove from batch
  - **Red aspect-ratio badge** if incompatible with target model, with action buttons: `Skip` / `Auto-crop` / `Keep anyway`

**Auto-caption bar** (above grid):
- Button: `"Generate prompts for all"` — runs the vision captioner on all tiles in parallel (concurrency limit 4)
- Progress: `"Captioning 7 of 23..."`
- Button disabled until OpenRouter key is set; if missing, shows a link to settings

**Video settings panel** (right side or collapsed at bottom):
- Duration, fps, camera motion, resolution
- These are **defaults** applied to all tiles
- Future: per-tile override (not in this spec)

**Bottom:**
- Run button: `"Animate 23 videos (~45 min estimated)"` — count + rough ETA from existing estimation logic
- Button label updates as tiles are added/removed/skipped

### Aspect-ratio compatibility matrix

| Model | Supported aspect ratios |
|---|---|
| LTX-2 Fast | 9:16, 16:9 |
| LTX-2 Pro | 9:16, 16:9 |
| Seedance 1.5 Pro | 16:9, 9:16, 1:1, 4:3, 3:4, 21:9 (verify against current Replicate model card during implementation) |

**"Auto-crop" behavior:** Center-crop the source image to the nearest compatible ratio (prefer 16:9 or 9:16 depending on whether source is landscape or portrait). Uses the existing `_prepare_image` pattern from `video_generation_handler.py`.

## Backend changes

### New settings fields

Add to `AppSettings` in `state/app_settings.py`:

```python
vision_captioner_model: str = "qwen/qwen-2.5-vl-72b-instruct"
```

`openrouter_api_key` and `has_openrouter_api_key` already exist.

### New route: POST /api/caption-image

Thin wrapper over existing OpenRouter vision path in `enhance_prompt_handler.py`.

**Request:**
```python
class CaptionImageRequest(BaseModel):
    image_path: str
    target_model: Literal["ltx-fast", "ltx-pro", "seedance-1.5-pro"]
```

**Response:**
```python
class CaptionImageResponse(BaseModel):
    prompt: str
```

**Implementation:**
- Reuses `_enhance_via_openrouter(..., image_path=...)` in `EnhancePromptHandler`
- System prompt is target-model-aware:
  - **LTX:** *"Write a short video prompt (1–2 sentences, under 50 words) describing the motion, camera movement, and action for this image. Use cinematic language. Do not describe what the image shows — describe what should happen in the video."*
  - **Seedance:** *"Write a concise video prompt (under 40 words) describing the motion and camera for this image. Be specific about subject movement and camera direction."*
- Model used: value of `vision_captioner_model` setting

### New handler: BatchHandler

`backend/handlers/batch_handler.py` — orchestrates batch submission. Thin orchestration layer only; actual generation delegates to existing handlers via the queue.

```python
class BatchHandler:
    def submit_image_batch(self, req: BatchImageRequest) -> BatchSubmitResponse:
        """Parse prompts, submit N image jobs with a shared batch_id."""

    def submit_video_batch(self, req: BatchVideoRequest) -> BatchSubmitResponse:
        """Submit N video jobs with a shared batch_id."""
```

**Request shapes:**

```python
class BatchImageRequest(BaseModel):
    prompts: list[str]  # already parsed by frontend
    model: str
    width: int
    height: int
    num_steps: int
    num_images_per_prompt: int = 1
    lora_path: str | None = None
    lora_weight: float = 1.0
    seed_mode: Literal["locked", "random"]
    locked_seed: int | None = None

class BatchVideoItem(BaseModel):
    image_path: str
    prompt: str
    skip: bool = False  # for aspect-ratio-flagged items

class BatchVideoRequest(BaseModel):
    items: list[BatchVideoItem]
    target_model: Literal["ltx-fast", "ltx-pro", "seedance-1.5-pro"]
    duration: int
    fps: int
    camera_motion: str
    resolution: str
    aspect_ratio: str  # the compatible ratio, after any auto-crop
```

**Response:**
```python
class BatchSubmitResponse(BaseModel):
    batch_id: str
    job_ids: list[str]
    count: int
```

### New routes

- `POST /api/batch/submit-images` → `BatchHandler.submit_image_batch`
- `POST /api/batch/submit-videos` → `BatchHandler.submit_video_batch`
- `POST /api/caption-image` → `EnhancePromptHandler` (new method `caption_image_for_video`)

### Queue changes

**None.** The queue already supports `batch_id` and `batch_index` on `Job`. Batch submission just generates one UUID and tags all N jobs with it.

### Existing handlers — no changes required

`VideoGenerationHandler` and `ImageGenerationHandler` are called via the queue as they already are. Batch mode is just N sequential queue submissions from one request.

## Frontend changes

### New files

- `frontend/views/Batch.tsx` — top-level view with tab switcher
- `frontend/components/BatchPromptsTab.tsx` — textarea + image settings + run
- `frontend/components/BatchImagesTab.tsx` — contact sheet + video settings + run
- `frontend/components/BatchImageTile.tsx` — single tile in the contact sheet
- `frontend/hooks/use-batch-captioner.ts` — parallel OpenRouter caption calls with concurrency limit 4
- `frontend/lib/parse-batch-prompts.ts` — pure function that splits text into prompts by blank-line separation

### Modified files

- `frontend/App.tsx` or router: add `batch` to the view union, add sidebar entry
- `frontend/components/Sidebar.tsx`: new "Batch" entry
- `frontend/types/views.ts` (or equivalent): extend view enum

### Data flow

**Tab 1 submission:**
1. `parseBatchPrompts(text)` → `string[]`
2. `POST /api/batch/submit-images` with prompts + settings
3. Backend returns `batch_id` + `job_ids[]`
4. Frontend polls `/api/queue/status`, filters jobs by `batch_id`
5. Results stream into a grid as each completes

**Tab 2 submission:**
1. User adds images → `BatchImageTile[]` in local state
2. User clicks "Generate prompts for all" → `useBatchCaptioner` fires N parallel `POST /api/caption-image` calls with concurrency 4
3. User edits captions inline as desired
4. User clicks "Animate" → `POST /api/batch/submit-videos` with items
5. Frontend polls queue, filters by `batch_id`

## Testing

### Backend tests (pytest, integration style per existing conventions)

- `tests/test_batch_handler.py`:
  - `test_submit_image_batch_creates_n_jobs`
  - `test_submit_image_batch_shared_batch_id`
  - `test_submit_video_batch_creates_n_jobs`
  - `test_submit_video_batch_skips_flagged_items`
  - `test_empty_prompts_rejected`
  - `test_video_batch_with_incompatible_aspect_ratio_rejected`

- `tests/test_caption_image.py`:
  - `test_caption_image_ltx_system_prompt`
  - `test_caption_image_seedance_system_prompt`
  - `test_caption_image_missing_openrouter_key_errors`
  - Uses the existing `FakeHttpClient` pattern to stub OpenRouter responses

### Frontend tests

None currently exist in the repo. Skipping per existing convention.

### Manual QA checklist

- [ ] Paste 5 multi-line prompts separated by blank lines → count shows 5
- [ ] Load a `.txt` file with 20 prompts → textarea populates, count shows 20
- [ ] Run batch with 3 prompts → 3 images appear
- [ ] Click "Animate all" → lands on Tab 2 with 3 images pre-loaded
- [ ] Click "Generate prompts for all" → all 3 get captions within ~10s
- [ ] Edit one caption inline → persists when switching tabs
- [ ] Add a 1:1 image with LTX-2 selected → red badge appears with Skip/Auto-crop/Keep options
- [ ] Auto-crop a 1:1 image → cropped successfully to 16:9
- [ ] Run batch video with 3 items → 3 video jobs appear in queue
- [ ] Remove one tile mid-edit → count in run button updates

## Risks and open questions

1. **Seedance aspect ratio support** needs verification during implementation — the Replicate model card is the source of truth, not this spec.
2. **OpenRouter rate limits** for Qwen 2.5 VL are not published clearly. Concurrency limit of 4 is a safe starting point; may need tuning.
3. **Vision caption quality** varies by model. If Qwen 2.5 VL underwhelms, swap the default to `google/gemma-3-27b-it` or `mistral/pixtral-large` via settings — no code change needed.
4. **Auto-crop quality:** center-crop is dumb. If subjects are off-center, the crop will cut them. Good enough for v1; later could add smart-crop via a saliency model.
5. **Very large batches (100+)** may hit queue persistence performance issues. Not in scope for v1 — we target batches of 10–50.

## Implementation order

When writing the implementation plan, suggested sequence:

1. Backend: `BatchHandler` + routes + tests (no UI yet — drive via curl)
2. Backend: `caption_image` route + tests
3. Frontend: `parse-batch-prompts.ts` + unit-level exercise via console
4. Frontend: `Batch.tsx` shell + sidebar entry + empty tabs
5. Frontend: Tab 1 (Prompts → Images) — full flow
6. Frontend: Tab 2 (Images → Videos) — grid + add images (no captions yet)
7. Frontend: `use-batch-captioner` + "Generate prompts for all"
8. Frontend: aspect-ratio flagging + auto-crop
9. Frontend: "Animate all →" chain from Tab 1 to Tab 2
10. Manual QA sweep
