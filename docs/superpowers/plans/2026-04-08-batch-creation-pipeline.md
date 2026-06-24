# Batch Creation Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing `BatchBuilderModal` with two new workflows: (1) blank-line-separated prompts → images with variations and seed modes, and (2) a contact-sheet Images→Videos flow that auto-captions each image via OpenRouter vision and submits a video batch.

**Architecture:** Reuses the existing `BatchHandler`, `JobQueue`, `/api/queue/submit-batch` route, `useBatch` hook, and OpenRouter vision code in `enhance_prompt_handler.py`. Adds (a) one new `POST /api/caption-image` route, (b) one new `vision_captioner_model` setting, (c) two new tabs in `BatchBuilderModal` (Prompts and Animate), and (d) supporting frontend utilities (blank-line parser, aspect-ratio helpers, batch captioner hook).

**Tech Stack:** Python 3.12 + FastAPI + Pydantic (backend); React 18 + TypeScript + Tailwind (frontend); OpenRouter (Qwen 2.5 VL 72B) for vision captioning; existing job queue and batch infrastructure.

---

## Pre-existing infrastructure (do NOT rebuild)

Before starting, confirm these exist and leave them alone:

- `backend/handlers/batch_handler.py` — `BatchHandler.submit_batch()` already expands list/sweep/pipeline requests into queue jobs with shared `batch_id`
- `backend/_routes/batch.py` — `/api/queue/submit-batch`, `/api/queue/batch/{id}/status`, `/cancel`, `/retry-failed`
- `backend/api_types.py` lines 355–422 — `BatchJobItem`, `BatchSubmitRequest`, `BatchSubmitResponse`, `BatchStatusResponse`, `BatchReport`
- `backend/state/job_queue.py` — `QueueJob` already has `batch_id`, `batch_index`, `depends_on`, `auto_params`, `tags`
- `backend/handlers/enhance_prompt_handler.py` — `_enhance_via_openrouter(image_path=...)` already does vision-aware chat completions via OpenRouter
- `backend/handlers/video_generation_handler.py` — `_prepare_image(image_path, width, height)` already center-crops source images to the target aspect ratio. **We reuse this for auto-crop — no new crop code.**
- `backend/state/app_settings.py` — `openrouter_api_key` and `has_openrouter_api_key` already exist
- `frontend/components/BatchBuilderModal.tsx` — existing modal with List/Import/Grid Sweep tabs; already wired to `useBatch`
- `frontend/hooks/use-batch.ts` — `submit`, `cancel`, `retryFailed`, `batchStatus`, `batchReport` with polling
- `frontend/lib/batch-api.ts` — API client wrapping `/api/queue/submit-batch` + friends
- `frontend/lib/batch-import.ts` — `parseCSV`, `parseJSON`, `parseRange`
- `frontend/types/batch.ts` — `BatchSubmitRequest` and friends
- `frontend/views/GenSpace.tsx:1848` — `<BatchBuilderModal isOpen={showBatchModal} ... />` already mounted

## File structure

**Backend — new files:**
- None (all additions go into existing files)

**Backend — modified files:**
- `backend/state/app_settings.py` — add `vision_captioner_model` to `AppSettings` and `SettingsResponse`
- `backend/api_types.py` — add `CaptionImageRequest`, `CaptionImageResponse`
- `backend/handlers/enhance_prompt_handler.py` — add `caption_image_for_video()` method
- `backend/_routes/enhance_prompt.py` — add `/api/caption-image` route
- `backend/tests/test_settings.py` — extend default-settings test with new field
- `backend/tests/test_caption_image.py` — **NEW** integration test file

**Frontend — new files:**
- `frontend/lib/aspect-ratio.ts` — pure utilities: `detectAspectRatio`, `isCompatibleWithTarget`, `suggestCompatibleRatio`
- `frontend/lib/caption-api.ts` — API client wrapping `/api/caption-image`
- `frontend/hooks/use-batch-captioner.ts` — parallel caption calls with concurrency limit 4
- `frontend/components/batch/BatchPromptsTab.tsx` — "Prompts → Images" tab body
- `frontend/components/batch/BatchAnimateTab.tsx` — "Images → Videos" tab body
- `frontend/components/batch/BatchImageTile.tsx` — single tile in the Animate contact sheet

**Frontend — modified files:**
- `frontend/lib/batch-import.ts` — add `parseBlankLineSeparated()`
- `frontend/components/BatchBuilderModal.tsx` — register the two new tabs, add the tab switch, plumb handlers

---

## Task 1: Add `vision_captioner_model` setting

**Files:**
- Modify: `backend/state/app_settings.py`
- Modify: `backend/tests/test_settings.py`

- [ ] **Step 1: Write the failing test**

Edit `backend/tests/test_settings.py` — inside `TestGetSettings.test_default_settings`, add an assertion for the new field. Find the line `assert data["batchSoundEnabled"] is True` and add right after it:

```python
        assert data["visionCaptionerModel"] == "qwen/qwen-2.5-vl-72b-instruct"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && uv run pytest tests/test_settings.py::TestGetSettings::test_default_settings -v --tb=short
```

Expected: FAIL with `KeyError: 'visionCaptionerModel'` or similar.

- [ ] **Step 3: Add field to `AppSettings`**

In `backend/state/app_settings.py`, find the `AppSettings` class definition (around line 62) and add this field after `custom_video_model_path`:

```python
    vision_captioner_model: str = "qwen/qwen-2.5-vl-72b-instruct"
```

- [ ] **Step 4: Add field to `SettingsResponse`**

In the same file, find the `SettingsResponse` class (around line 156) and add this field in the same position:

```python
    vision_captioner_model: str = "qwen/qwen-2.5-vl-72b-instruct"
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd backend && uv run pytest tests/test_settings.py -v --tb=short
```

Expected: All `test_settings.py` tests pass, including the new assertion.

- [ ] **Step 6: Run the schema drift test**

```bash
cd backend && uv run pytest tests/test_settings.py::TestSettingsSchemaDrift -v --tb=short
```

Expected: PASS. (This test verifies `AppSettings.model_fields == UpdateSettingsRequest.model_fields`, so adding to `AppSettings` alone should keep them in sync via the partial model factory.)

- [ ] **Step 7: Commit**

```bash
git add backend/state/app_settings.py backend/tests/test_settings.py
git commit -m "feat(settings): add vision_captioner_model setting"
```

---

## Task 2: Add `CaptionImageRequest`/`CaptionImageResponse` types

**Files:**
- Modify: `backend/api_types.py`

- [ ] **Step 1: Add request and response models**

In `backend/api_types.py`, find the end of the batch types block (around line 423, just before `class ModelDownloadRequest`) and add:

```python
class CaptionImageRequest(BaseModel):
    imagePath: str
    targetModel: Literal["ltx-fast", "seedance-1.5-pro"]


class CaptionImageResponse(BaseModel):
    prompt: str
```

- [ ] **Step 2: Verify type check**

```bash
pnpm typecheck:py
```

Expected: no new pyright errors. (These are simple Pydantic models with no forward refs.)

- [ ] **Step 3: Commit**

```bash
git add backend/api_types.py
git commit -m "feat(api): add CaptionImageRequest/CaptionImageResponse types"
```

---

## Task 3: Add `caption_image_for_video` method to EnhancePromptHandler

**Files:**
- Modify: `backend/handlers/enhance_prompt_handler.py`
- Test: `backend/tests/test_caption_image.py` (new)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_caption_image.py`:

```python
"""Tests for image captioning for video prompt generation."""

from __future__ import annotations

from pathlib import Path
from PIL import Image


class TestCaptionImage:
    def _write_test_image(self, tmp_path: Path) -> str:
        img = Image.new("RGB", (512, 288), "red")
        p = tmp_path / "test.jpg"
        img.save(p, format="JPEG")
        return str(p)

    def test_missing_openrouter_key_errors(self, client, test_state, tmp_path):
        test_state.state.app_settings.openrouter_api_key = ""
        image_path = self._write_test_image(tmp_path)
        r = client.post(
            "/api/caption-image",
            json={"imagePath": image_path, "targetModel": "ltx-fast"},
        )
        assert r.status_code == 400
        assert "openrouter" in r.text.lower() or "api key" in r.text.lower()

    def test_caption_image_ltx_uses_cinematic_system_prompt(
        self, client, test_state, fake_services, tmp_path
    ):
        test_state.state.app_settings.openrouter_api_key = "sk-or-test"
        image_path = self._write_test_image(tmp_path)
        fake_services.http.enqueue_response(
            status=200,
            json_body={
                "choices": [
                    {"message": {"content": "Slow dolly-in as smoke curls from the pipe."}}
                ]
            },
        )
        r = client.post(
            "/api/caption-image",
            json={"imagePath": image_path, "targetModel": "ltx-fast"},
        )
        assert r.status_code == 200
        assert r.json()["prompt"] == "Slow dolly-in as smoke curls from the pipe."
        # Inspect the request that was sent
        last = fake_services.http.last_request
        assert last is not None
        body = last.json_payload
        system_msg = body["messages"][0]
        assert system_msg["role"] == "system"
        assert "cinematic" in system_msg["content"].lower()
        assert "motion" in system_msg["content"].lower()

    def test_caption_image_seedance_uses_seedance_system_prompt(
        self, client, test_state, fake_services, tmp_path
    ):
        test_state.state.app_settings.openrouter_api_key = "sk-or-test"
        image_path = self._write_test_image(tmp_path)
        fake_services.http.enqueue_response(
            status=200,
            json_body={"choices": [{"message": {"content": "Camera pans right."}}]},
        )
        r = client.post(
            "/api/caption-image",
            json={"imagePath": image_path, "targetModel": "seedance-1.5-pro"},
        )
        assert r.status_code == 200
        last = fake_services.http.last_request
        body = last.json_payload
        system_msg = body["messages"][0]
        assert "subject" in system_msg["content"].lower()
        # Seedance prompt should be concise per spec
        assert "concise" in system_msg["content"].lower() or "under" in system_msg["content"].lower()

    def test_caption_image_uses_configured_captioner_model(
        self, client, test_state, fake_services, tmp_path
    ):
        test_state.state.app_settings.openrouter_api_key = "sk-or-test"
        test_state.state.app_settings.vision_captioner_model = "google/gemma-3-27b-it"
        image_path = self._write_test_image(tmp_path)
        fake_services.http.enqueue_response(
            status=200,
            json_body={"choices": [{"message": {"content": "Pan left."}}]},
        )
        r = client.post(
            "/api/caption-image",
            json={"imagePath": image_path, "targetModel": "ltx-fast"},
        )
        assert r.status_code == 200
        body = fake_services.http.last_request.json_payload
        assert body["model"] == "google/gemma-3-27b-it"
```

- [ ] **Step 2: Verify the test's fake HTTP surface exists**

Check that `fake_services.http` supports `enqueue_response` and `last_request`:

```bash
grep -n "enqueue_response\|last_request\|class FakeHttp" backend/tests/fakes/services.py backend/services/http_client/*.py 2>/dev/null
```

If the fake HTTP client in `tests/fakes/` doesn't support these exact methods, adapt the test to match whatever interface the existing `FakeHttpClient` uses. Read `backend/tests/fakes/services.py` first and mirror the patterns from the existing enhance-prompt tests in `backend/tests/test_enhance_prompt.py` if that file exists. **Do not invent a new fake API — match whatever already works.**

- [ ] **Step 3: Run test to verify it fails**

```bash
cd backend && uv run pytest tests/test_caption_image.py -v --tb=short
```

Expected: FAIL — endpoint `/api/caption-image` does not exist yet (404).

- [ ] **Step 4: Add `caption_image_for_video` method to EnhancePromptHandler**

In `backend/handlers/enhance_prompt_handler.py`, add this method inside the `EnhancePromptHandler` class (after `_enhance_via_openrouter`, around line 413):

```python
    def caption_image_for_video(
        self,
        image_path: str,
        target_model: str,
    ) -> str:
        """Generate a short video animation prompt describing motion/camera for an image.

        Uses OpenRouter with the configured vision_captioner_model. System prompt
        is tailored per target video model (LTX vs Seedance).
        """
        openrouter_api_key = self.state.app_settings.openrouter_api_key
        if not openrouter_api_key:
            raise HTTPError(400, "OpenRouter API key is required for image captioning")

        image_b64 = self._read_image_as_base64(image_path)
        if not image_b64:
            raise HTTPError(400, f"Could not read image: {image_path}")

        captioner_model = self.state.app_settings.vision_captioner_model

        if target_model == "ltx-fast":
            system_text = (
                "You are writing a short video animation prompt. Look at the image "
                "and write 1-2 sentences (under 50 words) describing the motion, "
                "camera movement, and action that should happen in the video. Use "
                "cinematic language (e.g., dolly in, pan, push, tilt, slow reveal). "
                "Do NOT describe what the image shows — describe what should move "
                "and how the camera should behave."
            )
        else:  # seedance-1.5-pro
            system_text = (
                "You are writing a concise video prompt for the Seedance model. "
                "Look at the image and write under 40 words describing the subject "
                "motion and camera direction. Be specific about what moves and where "
                "the camera goes. Do not describe the scene itself."
            )

        user_content: list[dict[str, JSONValue]] = [
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"},
            },
            {"type": "text", "text": "Write the video prompt for this image."},
        ]

        messages: JSONValue = [
            {"role": "system", "content": system_text},
            {"role": "user", "content": user_content},  # type: ignore[dict-item]
        ]

        payload: dict[str, JSONValue] = {
            "model": captioner_model,
            "messages": messages,
            "temperature": 0.6,
            "max_tokens": 120,
        }

        try:
            response = self._http.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {openrouter_api_key}",
                },
                json_payload=payload,
                timeout=30,
            )
        except HttpTimeoutError as exc:
            raise HTTPError(504, "OpenRouter caption request timed out") from exc
        except Exception as exc:
            raise HTTPError(500, str(exc)) from exc

        if response.status_code != 200:
            raise HTTPError(response.status_code, f"OpenRouter caption error: {response.text}")

        caption = _extract_openrouter_text(response.json())
        return caption.strip()
```

Note: `HTTPError`, `HttpTimeoutError`, `JSONValue`, and `_extract_openrouter_text` are already imported at the top of the file. Verify by reading lines 1–80 of `enhance_prompt_handler.py` before adding code. If `_read_image_as_base64` is a static method, call it as `self._read_image_as_base64(image_path)` (the existing `_enhance_via_openrouter` does exactly that around line 363).

- [ ] **Step 5: Run test to verify it still fails (now with routing error)**

```bash
cd backend && uv run pytest tests/test_caption_image.py -v --tb=short
```

Expected: still FAIL — route not yet registered. The method exists but no one calls it.

- [ ] **Step 6: Commit**

```bash
git add backend/handlers/enhance_prompt_handler.py backend/tests/test_caption_image.py
git commit -m "feat(caption): add caption_image_for_video method to EnhancePromptHandler"
```

---

## Task 4: Add `POST /api/caption-image` route

**Files:**
- Modify: `backend/_routes/enhance_prompt.py`

- [ ] **Step 1: Add the route handler**

Open `backend/_routes/enhance_prompt.py` and add at the bottom:

```python
from api_types import CaptionImageRequest, CaptionImageResponse


@router.post("/api/caption-image", response_model=CaptionImageResponse)
def caption_image(
    req: CaptionImageRequest,
    handler: AppHandler = Depends(get_state_service),
) -> CaptionImageResponse:
    prompt = handler.enhance_prompt.caption_image_for_video(
        image_path=req.imagePath,
        target_model=req.targetModel,
    )
    return CaptionImageResponse(prompt=prompt)
```

- [ ] **Step 2: Run the caption tests to verify they pass**

```bash
cd backend && uv run pytest tests/test_caption_image.py -v --tb=short
```

Expected: all 4 tests PASS.

- [ ] **Step 3: Run full backend suite to catch regressions**

```bash
cd backend && uv run pytest -v --tb=short
```

Expected: all tests PASS (including the 462 existing ones).

- [ ] **Step 4: Run pyright**

```bash
pnpm typecheck:py
```

Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add backend/_routes/enhance_prompt.py
git commit -m "feat(routes): add POST /api/caption-image"
```

---

## Task 5: Add `parseBlankLineSeparated` to `batch-import.ts`

**Files:**
- Modify: `frontend/lib/batch-import.ts`

- [ ] **Step 1: Add the function**

Append to `frontend/lib/batch-import.ts`:

```typescript
/**
 * Parse a text file where each prompt is separated by one or more blank lines.
 * Multi-line (paragraph) prompts are preserved as-is with internal newlines.
 * Leading/trailing whitespace on each prompt is stripped. Empty prompts are dropped.
 */
export function parseBlankLineSeparated(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n+/)
    .map(p => p.trim())
    .filter(p => p.length > 0)
}
```

- [ ] **Step 2: Verify type check**

```bash
pnpm typecheck:ts
```

Expected: no errors.

- [ ] **Step 3: Manual smoke test via a throwaway script**

```bash
cd frontend && npx tsx -e "import {parseBlankLineSeparated} from './lib/batch-import.ts'; console.log(parseBlankLineSeparated('first prompt\n\nsecond prompt\nline two\n\n\nthird'))"
```

Expected output:
```
[ 'first prompt', 'second prompt\nline two', 'third' ]
```

If `tsx` is not available, skip this step and rely on type-check + manual QA at the end. Do not add unit-test infrastructure — frontend tests don't exist in this repo (see `CLAUDE.md`).

- [ ] **Step 4: Commit**

```bash
git add frontend/lib/batch-import.ts
git commit -m "feat(batch): add parseBlankLineSeparated parser"
```

---

## Task 6: Add `caption-api.ts` frontend client

**Files:**
- Create: `frontend/lib/caption-api.ts`

- [ ] **Step 1: Create the client**

```typescript
const getBaseUrl = async (): Promise<string> => {
  if (window.electronAPI) {
    return await window.electronAPI.getBackendUrl()
  }
  return 'http://localhost:8000'
}

export type CaptionTargetModel = 'ltx-fast' | 'seedance-1.5-pro'

export async function captionImage(
  imagePath: string,
  targetModel: CaptionTargetModel,
): Promise<string> {
  const base = await getBaseUrl()
  const resp = await fetch(`${base}/api/caption-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imagePath, targetModel }),
  })
  if (!resp.ok) {
    throw new Error(`Caption failed: ${resp.status} ${await resp.text()}`)
  }
  const data: { prompt: string } = await resp.json()
  return data.prompt
}
```

- [ ] **Step 2: Verify type check**

```bash
pnpm typecheck:ts
```

- [ ] **Step 3: Commit**

```bash
git add frontend/lib/caption-api.ts
git commit -m "feat(caption): add frontend caption-api client"
```

---

## Task 7: Add aspect-ratio utilities

**Files:**
- Create: `frontend/lib/aspect-ratio.ts`

- [ ] **Step 1: Create the utilities**

```typescript
import type { CaptionTargetModel } from './caption-api'

export type AspectLabel = '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '4:5' | '5:4' | '21:9' | 'other'

const LTX_COMPATIBLE: ReadonlySet<AspectLabel> = new Set(['9:16', '16:9'])
const SEEDANCE_COMPATIBLE: ReadonlySet<AspectLabel> = new Set([
  '16:9', '9:16', '1:1', '4:3', '3:4', '21:9',
])

// Label a (width, height) pair with the closest canonical aspect ratio.
// Tolerance is 3% — enough to catch slightly off sizes (e.g. 1024x576 vs 1920x1080).
export function detectAspectRatio(width: number, height: number): AspectLabel {
  if (width <= 0 || height <= 0) return 'other'
  const ratio = width / height
  const candidates: Array<[AspectLabel, number]> = [
    ['1:1', 1],
    ['16:9', 16 / 9],
    ['9:16', 9 / 16],
    ['4:3', 4 / 3],
    ['3:4', 3 / 4],
    ['4:5', 4 / 5],
    ['5:4', 5 / 4],
    ['21:9', 21 / 9],
  ]
  for (const [label, value] of candidates) {
    if (Math.abs(ratio - value) / value < 0.03) return label
  }
  return 'other'
}

export function isCompatibleWithTarget(
  ratio: AspectLabel,
  target: CaptionTargetModel,
): boolean {
  const set = target === 'ltx-fast' ? LTX_COMPATIBLE : SEEDANCE_COMPATIBLE
  return set.has(ratio)
}

// Pick the best compatible ratio for a source image + target model.
// Rule: match landscape/portrait orientation of the source.
export function suggestCompatibleRatio(
  width: number,
  height: number,
  target: CaptionTargetModel,
): AspectLabel {
  const isPortrait = height > width
  if (target === 'ltx-fast') {
    return isPortrait ? '9:16' : '16:9'
  }
  // Seedance supports more — prefer the closest canonical to source
  const current = detectAspectRatio(width, height)
  if (SEEDANCE_COMPATIBLE.has(current)) return current
  return isPortrait ? '9:16' : '16:9'
}

export function labelForTarget(target: CaptionTargetModel): string {
  return target === 'ltx-fast' ? 'LTX-2 Fast' : 'Seedance 1.5 Pro'
}

export function compatibleRatiosForTarget(target: CaptionTargetModel): AspectLabel[] {
  return target === 'ltx-fast'
    ? ['9:16', '16:9']
    : ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']
}
```

- [ ] **Step 2: Verify type check**

```bash
pnpm typecheck:ts
```

- [ ] **Step 3: Commit**

```bash
git add frontend/lib/aspect-ratio.ts
git commit -m "feat(batch): add aspect-ratio compatibility utilities"
```

---

## Task 8: Add `useBatchCaptioner` hook

**Files:**
- Create: `frontend/hooks/use-batch-captioner.ts`

- [ ] **Step 1: Create the hook**

```typescript
import { useCallback, useRef, useState } from 'react'
import { captionImage, type CaptionTargetModel } from '@/lib/caption-api'

export interface CaptionProgress {
  total: number
  completed: number
  failed: number
  running: boolean
}

const DEFAULT_CONCURRENCY = 4

export interface UseBatchCaptionerReturn {
  progress: CaptionProgress
  captionAll: (
    items: Array<{ id: string; imagePath: string }>,
    targetModel: CaptionTargetModel,
    onResult: (id: string, caption: string) => void,
    onError?: (id: string, error: string) => void,
  ) => Promise<void>
  cancel: () => void
}

export function useBatchCaptioner(
  concurrency: number = DEFAULT_CONCURRENCY,
): UseBatchCaptionerReturn {
  const [progress, setProgress] = useState<CaptionProgress>({
    total: 0, completed: 0, failed: 0, running: false,
  })
  const cancelledRef = useRef(false)

  const captionAll = useCallback(
    async (
      items: Array<{ id: string; imagePath: string }>,
      targetModel: CaptionTargetModel,
      onResult: (id: string, caption: string) => void,
      onError?: (id: string, error: string) => void,
    ) => {
      cancelledRef.current = false
      setProgress({ total: items.length, completed: 0, failed: 0, running: true })

      let cursor = 0
      const workers: Promise<void>[] = []

      const runNext = async (): Promise<void> => {
        while (cursor < items.length && !cancelledRef.current) {
          const i = cursor++
          const item = items[i]
          try {
            const caption = await captionImage(item.imagePath, targetModel)
            if (cancelledRef.current) return
            onResult(item.id, caption)
            setProgress(p => ({ ...p, completed: p.completed + 1 }))
          } catch (err) {
            if (cancelledRef.current) return
            const msg = err instanceof Error ? err.message : String(err)
            onError?.(item.id, msg)
            setProgress(p => ({ ...p, failed: p.failed + 1 }))
          }
        }
      }

      for (let i = 0; i < Math.min(concurrency, items.length); i++) {
        workers.push(runNext())
      }
      await Promise.all(workers)

      setProgress(p => ({ ...p, running: false }))
    },
    [concurrency],
  )

  const cancel = useCallback(() => {
    cancelledRef.current = true
    setProgress(p => ({ ...p, running: false }))
  }, [])

  return { progress, captionAll, cancel }
}
```

- [ ] **Step 2: Verify type check**

```bash
pnpm typecheck:ts
```

- [ ] **Step 3: Commit**

```bash
git add frontend/hooks/use-batch-captioner.ts
git commit -m "feat(batch): add useBatchCaptioner hook"
```

---

## Task 9: Create `BatchPromptsTab` component

**Files:**
- Create: `frontend/components/batch/BatchPromptsTab.tsx`

This is the "Prompts → Images" tab body. Blank-line-separated textarea, image settings, variations, seed mode, animation toggle, and submit wiring.

- [ ] **Step 1: Create the component**

```tsx
import { useRef, useState, useMemo } from 'react'
import { Upload } from 'lucide-react'
import { parseBlankLineSeparated } from '@/lib/batch-import'
import type { BatchSubmitRequest, BatchJobItem } from '@/types/batch'

type SeedMode = 'locked' | 'random' | 'sequential'
type Variations = 1 | 2 | 4

export interface BatchPromptsTabProps {
  target: 'local' | 'cloud'
  onSubmit: (request: BatchSubmitRequest) => void
  isRunning: boolean
}

// Image models supported in batch mode
const IMAGE_MODELS = [
  { value: 'flux-klein-9b', label: 'FLUX.2 Klein 9B' },
  { value: 'flux-dev', label: 'FLUX.1 Dev' },
  { value: 'z-image-turbo', label: 'Z-Image Turbo' },
  { value: 'nano-banana-2', label: 'Nano Banana 2' },
] as const

// All aspect ratios for image gen
const ALL_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '4:5', '21:9'] as const
// Restricted set when "for animation" toggle is on
const ANIMATION_ASPECT_RATIOS = ['16:9', '9:16'] as const

const RESOLUTIONS = ['1080p', '1440p', '2048p'] as const

export function BatchPromptsTab({ target, onSubmit, isRunning }: BatchPromptsTabProps) {
  const [text, setText] = useState('')
  const [model, setModel] = useState<string>('flux-klein-9b')
  const [loraPath, setLoraPath] = useState('')
  const [loraWeight, setLoraWeight] = useState(1.0)
  const [resolution, setResolution] = useState<string>('1080p')
  const [aspectRatio, setAspectRatio] = useState<string>('16:9')
  const [steps, setSteps] = useState(28)
  const [variations, setVariations] = useState<Variations>(1)
  const [seedMode, setSeedMode] = useState<SeedMode>('locked')
  const [baseSeed, setBaseSeed] = useState(42)
  const [forAnimation, setForAnimation] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const prompts = useMemo(() => parseBlankLineSeparated(text), [text])
  const totalImages = prompts.length * variations

  const availableAspects: readonly string[] = forAnimation
    ? ANIMATION_ASPECT_RATIOS
    : ALL_ASPECT_RATIOS

  // If the user flips the toggle on and current aspect is incompatible, snap to 16:9
  if (forAnimation && !ANIMATION_ASPECT_RATIOS.includes(aspectRatio as '16:9' | '9:16')) {
    setAspectRatio('16:9')
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setText(String(reader.result ?? ''))
    reader.readAsText(file)
  }

  const computeDimensions = (): { width: number; height: number } => {
    const shortSide = resolution === '1080p' ? 1080 : resolution === '1440p' ? 1440 : 2048
    const ratioMap: Record<string, number> = {
      '1:1': 1, '16:9': 16 / 9, '9:16': 9 / 16, '4:3': 4 / 3,
      '3:4': 3 / 4, '4:5': 4 / 5, '21:9': 21 / 9,
    }
    const ratio = ratioMap[aspectRatio] ?? 1
    return ratio >= 1
      ? { width: Math.round(shortSide * ratio), height: shortSide }
      : { width: shortSide, height: Math.round(shortSide / ratio) }
  }

  const computeSeed = (index: number): number => {
    if (seedMode === 'locked') return baseSeed
    if (seedMode === 'sequential') return baseSeed + index
    // random
    return Math.floor(Math.random() * 2_147_483_647)
  }

  const handleSubmit = () => {
    if (prompts.length === 0) return
    const dims = computeDimensions()
    const jobs: BatchJobItem[] = []
    let jobIndex = 0
    for (const prompt of prompts) {
      for (let v = 0; v < variations; v++) {
        jobs.push({
          type: 'image',
          model,
          params: {
            prompt,
            width: dims.width,
            height: dims.height,
            numSteps: steps,
            numImages: 1,
            seed: computeSeed(jobIndex),
            ...(loraPath ? { loraPath, loraWeight } : {}),
          },
        })
        jobIndex++
      }
    }
    const request: BatchSubmitRequest = { mode: 'list', target, jobs }
    onSubmit(request)
  }

  return (
    <div className="space-y-4">
      {/* Load from file */}
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium" style={{ color: 'oklch(0.75 0.05 290)' }}>
          Prompts (separate with blank lines)
        </label>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
          style={{
            background: 'oklch(0.22 0.025 290)',
            color: 'oklch(0.75 0.05 290)',
            border: '1px solid oklch(0.32 0.03 290)',
          }}
        >
          <Upload className="w-3.5 h-3.5" />
          Load from .txt
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,text/plain"
          onChange={handleFileUpload}
          className="hidden"
        />
      </div>

      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        rows={12}
        placeholder={'A cinematic wide shot of...\n\nA close-up of...\n\nA gritty noir detective...'}
        className="w-full rounded-lg px-3 py-2 text-sm font-mono border"
        style={{
          background: 'oklch(0.22 0.025 290)',
          borderColor: 'oklch(0.32 0.03 290)',
          color: 'oklch(0.92 0.02 290)',
        }}
      />

      <div className="text-xs" style={{ color: 'oklch(0.65 0.04 290)' }}>
        {prompts.length === 0
          ? 'No prompts yet — paste some text above'
          : `${prompts.length} prompt${prompts.length === 1 ? '' : 's'} detected`}
      </div>

      {/* Settings grid */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 290)' }}>Model</label>
          <select
            value={model}
            onChange={e => setModel(e.target.value)}
            className="w-full rounded-lg px-2 py-1.5 text-sm border"
            style={{ background: 'oklch(0.22 0.025 290)', borderColor: 'oklch(0.32 0.03 290)', color: 'oklch(0.92 0.02 290)' }}
          >
            {IMAGE_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 290)' }}>Resolution</label>
          <select
            value={resolution}
            onChange={e => setResolution(e.target.value)}
            className="w-full rounded-lg px-2 py-1.5 text-sm border"
            style={{ background: 'oklch(0.22 0.025 290)', borderColor: 'oklch(0.32 0.03 290)', color: 'oklch(0.92 0.02 290)' }}
          >
            {RESOLUTIONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 290)' }}>Aspect ratio</label>
          <select
            value={aspectRatio}
            onChange={e => setAspectRatio(e.target.value)}
            className="w-full rounded-lg px-2 py-1.5 text-sm border"
            style={{ background: 'oklch(0.22 0.025 290)', borderColor: 'oklch(0.32 0.03 290)', color: 'oklch(0.92 0.02 290)' }}
          >
            {availableAspects.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 290)' }}>Steps</label>
          <input
            type="number"
            value={steps}
            onChange={e => setSteps(Math.max(1, Math.min(100, Number(e.target.value))))}
            className="w-full rounded-lg px-2 py-1.5 text-sm border"
            style={{ background: 'oklch(0.22 0.025 290)', borderColor: 'oklch(0.32 0.03 290)', color: 'oklch(0.92 0.02 290)' }}
          />
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 290)' }}>Variations per prompt</label>
          <select
            value={variations}
            onChange={e => setVariations(Number(e.target.value) as Variations)}
            className="w-full rounded-lg px-2 py-1.5 text-sm border"
            style={{ background: 'oklch(0.22 0.025 290)', borderColor: 'oklch(0.32 0.03 290)', color: 'oklch(0.92 0.02 290)' }}
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={4}>4</option>
          </select>
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 290)' }}>Seed mode</label>
          <select
            value={seedMode}
            onChange={e => setSeedMode(e.target.value as SeedMode)}
            className="w-full rounded-lg px-2 py-1.5 text-sm border"
            style={{ background: 'oklch(0.22 0.025 290)', borderColor: 'oklch(0.32 0.03 290)', color: 'oklch(0.92 0.02 290)' }}
          >
            <option value="locked">Locked (same every job)</option>
            <option value="sequential">Sequential (base+i)</option>
            <option value="random">Random</option>
          </select>
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 290)' }}>
            {seedMode === 'sequential' ? 'Base seed' : seedMode === 'locked' ? 'Seed' : 'Seed (ignored)'}
          </label>
          <input
            type="number"
            value={baseSeed}
            onChange={e => setBaseSeed(Math.max(0, Math.min(2_147_483_647, Number(e.target.value))))}
            disabled={seedMode === 'random'}
            className="w-full rounded-lg px-2 py-1.5 text-sm border disabled:opacity-50"
            style={{ background: 'oklch(0.22 0.025 290)', borderColor: 'oklch(0.32 0.03 290)', color: 'oklch(0.92 0.02 290)' }}
          />
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 290)' }}>LoRA path (optional)</label>
          <input
            value={loraPath}
            onChange={e => setLoraPath(e.target.value)}
            placeholder="E:\fluxdev\my_lora.safetensors"
            className="w-full rounded-lg px-2 py-1.5 text-sm border"
            style={{ background: 'oklch(0.22 0.025 290)', borderColor: 'oklch(0.32 0.03 290)', color: 'oklch(0.92 0.02 290)' }}
          />
        </div>
      </div>

      {/* Animation lock toggle */}
      <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'oklch(0.75 0.05 290)' }}>
        <input
          type="checkbox"
          checked={forAnimation}
          onChange={e => setForAnimation(e.target.checked)}
        />
        These images are for animation — restrict aspect ratio to 16:9 / 9:16
      </label>

      {/* Submit */}
      <button
        onClick={handleSubmit}
        disabled={prompts.length === 0 || isRunning}
        className="w-full py-2.5 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
        style={{
          background: 'oklch(0.6 0.2 290)',
          color: 'oklch(0.98 0.01 290)',
        }}
      >
        {variations > 1
          ? `Generate ${totalImages} images (${prompts.length} prompts × ${variations})`
          : `Generate ${totalImages} image${totalImages === 1 ? '' : 's'}`}
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Verify type check**

```bash
pnpm typecheck:ts
```

Expected: no errors. If there is a stray error about `setAspectRatio` inside render (the inline `if` that calls it), move that logic into a `useEffect`:

```tsx
useEffect(() => {
  if (forAnimation && !ANIMATION_ASPECT_RATIOS.includes(aspectRatio as '16:9' | '9:16')) {
    setAspectRatio('16:9')
  }
}, [forAnimation, aspectRatio])
```

Add `useEffect` to the import from `react`.

- [ ] **Step 3: Commit**

```bash
git add frontend/components/batch/BatchPromptsTab.tsx
git commit -m "feat(batch): add BatchPromptsTab component"
```

---

## Task 10: Create `BatchImageTile` component

**Files:**
- Create: `frontend/components/batch/BatchImageTile.tsx`

- [ ] **Step 1: Create the tile**

```tsx
import { RefreshCw, X, AlertTriangle } from 'lucide-react'
import type { CaptionTargetModel } from '@/lib/caption-api'
import { isCompatibleWithTarget, type AspectLabel } from '@/lib/aspect-ratio'

export interface BatchImage {
  id: string
  imagePath: string
  thumbnailUrl: string  // file:// URL for display
  width: number
  height: number
  aspectRatio: AspectLabel
  caption: string
  captioning: boolean
  captionError: string | null
  disposition: 'include' | 'skip' | 'crop'
}

interface BatchImageTileProps {
  image: BatchImage
  target: CaptionTargetModel
  onCaptionChange: (id: string, caption: string) => void
  onRegenerateCaption: (id: string) => void
  onRemove: (id: string) => void
  onDispositionChange: (id: string, disposition: BatchImage['disposition']) => void
}

export function BatchImageTile({
  image, target, onCaptionChange, onRegenerateCaption, onRemove, onDispositionChange,
}: BatchImageTileProps) {
  const compatible = isCompatibleWithTarget(image.aspectRatio, target)
  const showFlag = !compatible && image.disposition === 'include'

  return (
    <div
      className="rounded-lg overflow-hidden border flex flex-col"
      style={{ background: 'oklch(0.22 0.025 290)', borderColor: 'oklch(0.32 0.03 290)' }}
    >
      <div className="relative aspect-square bg-black">
        <img
          src={image.thumbnailUrl}
          alt={image.imagePath}
          className="w-full h-full object-contain"
        />
        <button
          onClick={() => onRemove(image.id)}
          title="Remove"
          className="absolute top-1 right-1 p-1 rounded-full bg-black/60 hover:bg-black/80 text-white"
        >
          <X className="w-3 h-3" />
        </button>
        {image.disposition === 'skip' && (
          <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
            <span className="text-xs font-medium text-white">SKIPPED</span>
          </div>
        )}
      </div>

      <div className="p-2 space-y-1.5 flex-1 flex flex-col">
        <div className="flex items-center justify-between text-[10px]" style={{ color: 'oklch(0.65 0.04 290)' }}>
          <span className="truncate">{image.imagePath.split(/[\\/]/).pop()}</span>
          <span>{image.width}×{image.height} · {image.aspectRatio}</span>
        </div>

        {showFlag && (
          <div
            className="flex flex-col gap-1 p-1.5 rounded border text-[11px]"
            style={{ background: 'oklch(0.3 0.15 30 / 0.3)', borderColor: 'oklch(0.6 0.2 30)' }}
          >
            <div className="flex items-center gap-1" style={{ color: 'oklch(0.85 0.15 30)' }}>
              <AlertTriangle className="w-3 h-3" />
              <span>Not compatible with {target}</span>
            </div>
            <div className="flex gap-1">
              <button
                onClick={() => onDispositionChange(image.id, 'skip')}
                className="flex-1 px-1.5 py-0.5 rounded text-[10px]"
                style={{ background: 'oklch(0.25 0.02 290)', color: 'oklch(0.85 0.05 290)' }}
              >Skip</button>
              <button
                onClick={() => onDispositionChange(image.id, 'crop')}
                className="flex-1 px-1.5 py-0.5 rounded text-[10px]"
                style={{ background: 'oklch(0.25 0.02 290)', color: 'oklch(0.85 0.05 290)' }}
              >Auto-crop</button>
            </div>
          </div>
        )}
        {image.disposition === 'crop' && (
          <div className="text-[10px]" style={{ color: 'oklch(0.7 0.15 150)' }}>
            ✓ Will center-crop during generation
          </div>
        )}

        <textarea
          value={image.caption}
          onChange={e => onCaptionChange(image.id, e.target.value)}
          placeholder={image.captioning ? 'Captioning...' : 'Video prompt (motion, camera, action)'}
          disabled={image.captioning}
          rows={3}
          className="w-full rounded px-1.5 py-1 text-[11px] border resize-none flex-1"
          style={{ background: 'oklch(0.18 0.02 290)', borderColor: 'oklch(0.32 0.03 290)', color: 'oklch(0.92 0.02 290)' }}
        />

        {image.captionError && (
          <div className="text-[10px]" style={{ color: 'oklch(0.7 0.2 30)' }}>
            {image.captionError}
          </div>
        )}

        <button
          onClick={() => onRegenerateCaption(image.id)}
          disabled={image.captioning}
          className="flex items-center justify-center gap-1 py-1 rounded text-[10px] disabled:opacity-50"
          style={{ background: 'oklch(0.25 0.02 290)', color: 'oklch(0.75 0.05 290)' }}
        >
          <RefreshCw className={`w-3 h-3 ${image.captioning ? 'animate-spin' : ''}`} />
          Regenerate caption
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify type check**

```bash
pnpm typecheck:ts
```

- [ ] **Step 3: Commit**

```bash
git add frontend/components/batch/BatchImageTile.tsx
git commit -m "feat(batch): add BatchImageTile component"
```

---

## Task 11: Create `BatchAnimateTab` component

**Files:**
- Create: `frontend/components/batch/BatchAnimateTab.tsx`

This is the big one — contact sheet, add images, auto-caption, submit as video batch.

- [ ] **Step 1: Create the component**

```tsx
import { useCallback, useState } from 'react'
import { Upload, Sparkles } from 'lucide-react'
import type { BatchSubmitRequest, BatchJobItem } from '@/types/batch'
import type { CaptionTargetModel } from '@/lib/caption-api'
import { detectAspectRatio, suggestCompatibleRatio, isCompatibleWithTarget } from '@/lib/aspect-ratio'
import { useBatchCaptioner } from '@/hooks/use-batch-captioner'
import { BatchImageTile, type BatchImage } from './BatchImageTile'

export interface BatchAnimateTabProps {
  target: 'local' | 'cloud'
  onSubmit: (request: BatchSubmitRequest) => void
  isRunning: boolean
  // Optional: pre-loaded images from a Prompts → Images batch result
  initialImagePaths?: string[]
}

let tileIdCounter = 0
function nextTileId(): string {
  return `tile_${++tileIdCounter}`
}

const VIDEO_DURATIONS = [2, 3, 4, 5, 6, 8, 10] as const
const VIDEO_FPS = [24, 25, 30] as const
const CAMERA_MOTIONS = ['none', 'static', 'dolly_in', 'dolly_out', 'jib_up', 'jib_down'] as const

async function readImageDimensions(fileUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error(`Could not load image: ${fileUrl}`))
    img.src = fileUrl
  })
}

function pathToFileUrl(p: string): string {
  const normalized = p.replace(/\\/g, '/')
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
}

export function BatchAnimateTab({ target, onSubmit, isRunning, initialImagePaths }: BatchAnimateTabProps) {
  const [tiles, setTiles] = useState<BatchImage[]>([])
  const [targetModel, setTargetModel] = useState<CaptionTargetModel>('ltx-fast')
  const [duration, setDuration] = useState<number>(5)
  const [fps, setFps] = useState<number>(24)
  const [cameraMotion, setCameraMotion] = useState<string>('none')
  const [resolution, setResolution] = useState<string>('512p')
  const captioner = useBatchCaptioner()

  // Handle initial image paths (from Prompts tab handoff)
  const loadedInitialRef = useState<boolean>(false)
  if (!loadedInitialRef[0] && initialImagePaths && initialImagePaths.length > 0) {
    loadedInitialRef[1](true)
    void addImagesFromPaths(initialImagePaths)
  }

  async function addImagesFromPaths(paths: string[]) {
    const newTiles: BatchImage[] = []
    for (const p of paths) {
      try {
        const fileUrl = pathToFileUrl(p)
        const { width, height } = await readImageDimensions(fileUrl)
        const aspectRatio = detectAspectRatio(width, height)
        newTiles.push({
          id: nextTileId(),
          imagePath: p,
          thumbnailUrl: fileUrl,
          width,
          height,
          aspectRatio,
          caption: '',
          captioning: false,
          captionError: null,
          disposition: 'include',
        })
      } catch (err) {
        console.error('Failed to load', p, err)
      }
    }
    setTiles(prev => [...prev, ...newTiles])
  }

  const handleAddImages = async () => {
    const paths = await window.electronAPI.showOpenDialog?.({
      title: 'Select images to animate',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile', 'multiSelections'],
    })
    if (paths && paths.length > 0) {
      await addImagesFromPaths(paths)
    }
  }

  const updateTile = useCallback((id: string, updates: Partial<BatchImage>) => {
    setTiles(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t))
  }, [])

  const handleCaptionChange = (id: string, caption: string) => updateTile(id, { caption })
  const handleRemove = (id: string) => setTiles(prev => prev.filter(t => t.id !== id))
  const handleDispositionChange = (id: string, disposition: BatchImage['disposition']) =>
    updateTile(id, { disposition })

  const handleCaptionAll = async () => {
    const items = tiles
      .filter(t => t.disposition !== 'skip')
      .map(t => ({ id: t.id, imagePath: t.imagePath }))
    if (items.length === 0) return

    items.forEach(i => updateTile(i.id, { captioning: true, captionError: null }))

    await captioner.captionAll(
      items,
      targetModel,
      (id, caption) => updateTile(id, { caption, captioning: false }),
      (id, error) => updateTile(id, { captionError: error, captioning: false }),
    )
  }

  const handleRegenerateOne = async (id: string) => {
    const tile = tiles.find(t => t.id === id)
    if (!tile) return
    updateTile(id, { captioning: true, captionError: null })
    await captioner.captionAll(
      [{ id, imagePath: tile.imagePath }],
      targetModel,
      (tid, caption) => updateTile(tid, { caption, captioning: false }),
      (tid, error) => updateTile(tid, { captionError: error, captioning: false }),
    )
  }

  const handleClearAll = () => setTiles([])

  const activeTiles = tiles.filter(t => t.disposition !== 'skip')
  const canRun = activeTiles.length > 0 && activeTiles.every(t => t.caption.trim().length > 0)

  const handleSubmit = () => {
    const jobs: BatchJobItem[] = activeTiles.map(tile => {
      // For crop: use suggested compatible ratio; backend _prepare_image handles actual crop
      const effectiveRatio = tile.disposition === 'crop'
        ? suggestCompatibleRatio(tile.width, tile.height, targetModel)
        : tile.aspectRatio
      return {
        type: 'video',
        model: targetModel,
        params: {
          prompt: tile.caption,
          imagePath: tile.imagePath,
          duration: String(duration),
          resolution,
          fps: String(fps),
          cameraMotion,
          aspectRatio: effectiveRatio,
          audio: 'false',
        },
      }
    })
    const request: BatchSubmitRequest = { mode: 'list', target, jobs }
    onSubmit(request)
  }

  return (
    <div className="space-y-3">
      {/* Top bar */}
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 290)' }}>Animate with</label>
          <select
            value={targetModel}
            onChange={e => setTargetModel(e.target.value as CaptionTargetModel)}
            className="w-full rounded-lg px-2 py-1.5 text-sm border"
            style={{ background: 'oklch(0.22 0.025 290)', borderColor: 'oklch(0.32 0.03 290)', color: 'oklch(0.92 0.02 290)' }}
          >
            <option value="ltx-fast">LTX-2 Fast (local)</option>
            <option value="seedance-1.5-pro">Seedance 1.5 Pro (cloud)</option>
          </select>
        </div>
        <button
          onClick={handleAddImages}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium self-end"
          style={{ background: 'oklch(0.22 0.025 290)', border: '1px solid oklch(0.32 0.03 290)', color: 'oklch(0.92 0.02 290)' }}
        >
          <Upload className="w-4 h-4" /> Add images
        </button>
        <button
          onClick={handleClearAll}
          disabled={tiles.length === 0}
          className="px-3 py-2 rounded-lg text-sm self-end disabled:opacity-40"
          style={{ background: 'oklch(0.22 0.025 290)', border: '1px solid oklch(0.32 0.03 290)', color: 'oklch(0.65 0.04 290)' }}
        >
          Clear all
        </button>
      </div>

      {/* Auto-caption bar */}
      {tiles.length > 0 && (
        <div className="flex items-center gap-2">
          <button
            onClick={handleCaptionAll}
            disabled={captioner.progress.running}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
            style={{ background: 'oklch(0.6 0.2 290 / 0.3)', color: 'oklch(0.85 0.1 290)', border: '1px solid oklch(0.6 0.2 290 / 0.5)' }}
          >
            <Sparkles className="w-4 h-4" />
            Generate prompts for all
          </button>
          {captioner.progress.running && (
            <span className="text-xs" style={{ color: 'oklch(0.65 0.04 290)' }}>
              Captioning {captioner.progress.completed + captioner.progress.failed} of {captioner.progress.total}...
            </span>
          )}
        </div>
      )}

      {/* Grid */}
      {tiles.length === 0 ? (
        <div
          className="h-48 rounded-lg border-dashed border-2 flex items-center justify-center text-sm"
          style={{ borderColor: 'oklch(0.32 0.03 290)', color: 'oklch(0.55 0.04 290)' }}
        >
          Click "Add images" to get started
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-2 max-h-[50vh] overflow-y-auto pr-1">
          {tiles.map(tile => (
            <BatchImageTile
              key={tile.id}
              image={tile}
              target={targetModel}
              onCaptionChange={handleCaptionChange}
              onRegenerateCaption={handleRegenerateOne}
              onRemove={handleRemove}
              onDispositionChange={handleDispositionChange}
            />
          ))}
        </div>
      )}

      {/* Video settings */}
      <div className="grid grid-cols-4 gap-2">
        <div>
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 290)' }}>Duration (s)</label>
          <select value={duration} onChange={e => setDuration(Number(e.target.value))}
            className="w-full rounded-lg px-2 py-1.5 text-sm border"
            style={{ background: 'oklch(0.22 0.025 290)', borderColor: 'oklch(0.32 0.03 290)', color: 'oklch(0.92 0.02 290)' }}>
            {VIDEO_DURATIONS.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 290)' }}>FPS</label>
          <select value={fps} onChange={e => setFps(Number(e.target.value))}
            className="w-full rounded-lg px-2 py-1.5 text-sm border"
            style={{ background: 'oklch(0.22 0.025 290)', borderColor: 'oklch(0.32 0.03 290)', color: 'oklch(0.92 0.02 290)' }}>
            {VIDEO_FPS.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 290)' }}>Resolution</label>
          <select value={resolution} onChange={e => setResolution(e.target.value)}
            className="w-full rounded-lg px-2 py-1.5 text-sm border"
            style={{ background: 'oklch(0.22 0.025 290)', borderColor: 'oklch(0.32 0.03 290)', color: 'oklch(0.92 0.02 290)' }}>
            <option value="512p">512p</option>
            <option value="720p">720p</option>
          </select>
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 290)' }}>Camera motion</label>
          <select value={cameraMotion} onChange={e => setCameraMotion(e.target.value)}
            className="w-full rounded-lg px-2 py-1.5 text-sm border"
            style={{ background: 'oklch(0.22 0.025 290)', borderColor: 'oklch(0.32 0.03 290)', color: 'oklch(0.92 0.02 290)' }}>
            {CAMERA_MOTIONS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      {/* Submit */}
      <button
        onClick={handleSubmit}
        disabled={!canRun || isRunning}
        className="w-full py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50"
        style={{ background: 'oklch(0.6 0.2 290)', color: 'oklch(0.98 0.01 290)' }}
      >
        {!canRun && tiles.length > 0
          ? 'All active tiles need a caption'
          : `Animate ${activeTiles.length} video${activeTiles.length === 1 ? '' : 's'}`}
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Verify type check**

```bash
pnpm typecheck:ts
```

If `window.electronAPI.showOpenDialog` does not exist on the ElectronAPI type, check what the actual file picker method is called in `electron/preload.ts` and `frontend/vite-env.d.ts` (or wherever `electronAPI` is typed). Replace `showOpenDialog` with the existing method name. If a multi-select file picker does not exist, add one — but that's a separate follow-up; for now, use whatever single-file picker exists and adapt the UI to add one at a time. Look for existing usages like `window.electronAPI.readLocalFile` or `showSaveDialog` to find the pattern.

If the initial-image-paths ref trick (the dual-element `useState<boolean>` trick) trips the React linter, replace it with a proper `useEffect`:

```tsx
const [hasLoadedInitial, setHasLoadedInitial] = useState(false)
useEffect(() => {
  if (!hasLoadedInitial && initialImagePaths && initialImagePaths.length > 0) {
    setHasLoadedInitial(true)
    void addImagesFromPaths(initialImagePaths)
  }
}, [hasLoadedInitial, initialImagePaths])
```

Also add `useEffect` to the React import.

- [ ] **Step 3: Commit**

```bash
git add frontend/components/batch/BatchAnimateTab.tsx
git commit -m "feat(batch): add BatchAnimateTab contact sheet component"
```

---

## Task 12: Register the two new tabs in `BatchBuilderModal`

**Files:**
- Modify: `frontend/components/BatchBuilderModal.tsx`

- [ ] **Step 1: Extend `TabId` and imports**

At the top of `BatchBuilderModal.tsx`, update the `TabId` type and imports:

```tsx
import { BatchPromptsTab } from './batch/BatchPromptsTab'
import { BatchAnimateTab } from './batch/BatchAnimateTab'
```

Find the existing line:
```tsx
type TabId = 'list' | 'import' | 'grid'
```

Replace with:
```tsx
type TabId = 'prompts' | 'animate' | 'list' | 'import' | 'grid'
```

- [ ] **Step 2: Set default tab to 'prompts'**

Find:
```tsx
const [activeTab, setActiveTab] = useState<TabId>('list')
```

Replace with:
```tsx
const [activeTab, setActiveTab] = useState<TabId>('prompts')
```

- [ ] **Step 3: Add imports for new icons**

Find the lucide-react import line (top of file) and add `Layers` and `Film`:

```tsx
import { X, Plus, Trash2, Copy, Upload, Grid3X3, List, FileText, Play, AlertCircle, Layers, Film } from 'lucide-react'
```

- [ ] **Step 4: Register the new tabs in the tabs array**

Find:
```tsx
const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: 'list', label: 'List', icon: <List className="w-4 h-4" /> },
  { id: 'import', label: 'Import', icon: <FileText className="w-4 h-4" /> },
  { id: 'grid', label: 'Grid Sweep', icon: <Grid3X3 className="w-4 h-4" /> },
]
```

Replace with:
```tsx
const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: 'prompts', label: 'Prompts → Images', icon: <Layers className="w-4 h-4" /> },
  { id: 'animate', label: 'Images → Videos', icon: <Film className="w-4 h-4" /> },
  { id: 'list', label: 'List', icon: <List className="w-4 h-4" /> },
  { id: 'import', label: 'Import', icon: <FileText className="w-4 h-4" /> },
  { id: 'grid', label: 'Grid Sweep', icon: <Grid3X3 className="w-4 h-4" /> },
]
```

- [ ] **Step 5: Render the new tab bodies**

Inside the `{/* Tab Content */}` block, find the first existing conditional `{activeTab === 'list' && (...)}` and add BEFORE it:

```tsx
{activeTab === 'prompts' && (
  <BatchPromptsTab
    target={target}
    isRunning={batch.isRunning}
    onSubmit={async (request) => {
      await batch.submit(request)
      onClose()
    }}
  />
)}
{activeTab === 'animate' && (
  <BatchAnimateTab
    target={target}
    isRunning={batch.isRunning}
    onSubmit={async (request) => {
      await batch.submit(request)
      onClose()
    }}
  />
)}
```

- [ ] **Step 6: Hide the legacy submit button when on a new tab**

The existing modal has a single submit handler (`handleSubmit`) at the bottom for the legacy tabs. The new tabs have their own submit buttons inside their bodies. Find the footer submit button (search for `handleSubmit` in the JSX) and wrap it in a conditional so it only shows for legacy tabs. If the button looks like:

```tsx
<button onClick={handleSubmit} disabled={...}>Submit batch</button>
```

Wrap it:

```tsx
{(activeTab === 'list' || activeTab === 'import' || activeTab === 'grid') && (
  <button onClick={handleSubmit} disabled={...}>Submit batch</button>
)}
```

If the footer contains only that button and it becomes empty for new tabs, wrap the whole footer row in the same conditional instead. Read the file to find the exact structure before editing.

- [ ] **Step 7: Verify type check**

```bash
pnpm typecheck:ts
```

- [ ] **Step 8: Build frontend**

```bash
pnpm build:frontend
```

Expected: build succeeds.

- [ ] **Step 9: Commit**

```bash
git add frontend/components/BatchBuilderModal.tsx
git commit -m "feat(batch): register Prompts and Animate tabs in BatchBuilderModal"
```

---

## Task 13: Wire "Animate all →" handoff from batch completion

**Files:**
- Modify: `frontend/components/BatchBuilderModal.tsx`

Currently when a batch completes, `batch.batchReport` is set and `onClose()` is called in the existing submit handlers. For the Prompts tab flow we want: when a prompts-image batch completes, offer a button "Animate all →" that switches to the Animate tab and loads the result paths instead of closing.

**Scope decision for this plan:** keep v1 simple — do NOT auto-handoff. Instead, leave `onClose()` as-is for the Prompts tab, and add a one-line note in the Animate tab's empty state suggesting the user manually select images from the Gallery. The full auto-handoff is a small follow-up that requires keeping the modal open, re-fetching job `result_paths`, and switching tabs — enough state churn to deserve its own PR. We document this and move on.

- [ ] **Step 1: Update the empty state in `BatchAnimateTab.tsx`**

Open `frontend/components/batch/BatchAnimateTab.tsx`, find the empty state:

```tsx
<div className="h-48 rounded-lg border-dashed border-2 flex items-center justify-center text-sm"
  style={{ borderColor: 'oklch(0.32 0.03 290)', color: 'oklch(0.55 0.04 290)' }}>
  Click "Add images" to get started
</div>
```

Replace with:

```tsx
<div className="h-48 rounded-lg border-dashed border-2 flex flex-col items-center justify-center gap-1 text-sm"
  style={{ borderColor: 'oklch(0.32 0.03 290)', color: 'oklch(0.55 0.04 290)' }}>
  <span>Click "Add images" to get started</span>
  <span className="text-[11px]">Tip: generate a batch in the Prompts tab first, then add those images here from the gallery</span>
</div>
```

- [ ] **Step 2: Verify type check**

```bash
pnpm typecheck:ts
```

- [ ] **Step 3: Commit**

```bash
git add frontend/components/batch/BatchAnimateTab.tsx
git commit -m "docs(batch): add prompts-to-animate hint in empty state"
```

---

## Task 14: End-to-end verification

**Files:** none (manual QA)

- [ ] **Step 1: Run the full backend test suite**

```bash
pnpm backend:test
```

Expected: all tests pass, including 4 new `test_caption_image.py` tests and the updated `test_settings.py`.

- [ ] **Step 2: Run pyright**

```bash
pnpm typecheck:py
```

Expected: no errors.

- [ ] **Step 3: Run TypeScript typecheck**

```bash
pnpm typecheck:ts
```

Expected: no errors.

- [ ] **Step 4: Build the frontend**

```bash
pnpm build:frontend
```

Expected: build succeeds.

- [ ] **Step 5: Start the app**

```bash
pnpm dev
```

- [ ] **Step 6: Manual QA walkthrough**

Follow the checklist below in order. Check each item off as it passes.

**Prompts tab (Prompts → Images):**
- [ ] Open BatchBuilderModal — the first tab "Prompts → Images" is selected by default
- [ ] Paste this text and verify count shows `3 prompts detected`:
  ```
  A neon-lit alley in Tokyo at night
  rain-soaked pavement reflecting signs

  A warm living room with a cat
  sunlight through a window

  A space station interior
  ```
- [ ] Set variations = 2, run button label shows `Generate 6 images (3 prompts × 2)`
- [ ] Click "Load from .txt" → pick any `.txt` file with blank-line prompts → textarea populates, count updates
- [ ] Toggle "These images are for animation" on → aspect ratio dropdown now only shows 9:16 and 16:9
- [ ] Toggle off → all 7 ratios return
- [ ] Pick seed mode "sequential", base seed 100 → remember this for after submit
- [ ] Click "Generate" — modal closes, batch starts; confirm in the job queue UI that the first 3 jobs have seed 100, 101, 102 in their params

**Animate tab (Images → Videos):**
- [ ] Switch to "Images → Videos" tab — empty state is shown with the hint text
- [ ] Click "Add images" — pick 3 images of different aspect ratios (one 16:9, one 1:1, one 9:16)
- [ ] Tiles render in the grid with thumbnails, dimensions, and aspect ratio badges
- [ ] With target = LTX-2 Fast, the 1:1 tile shows the red badge with Skip/Auto-crop buttons
- [ ] Click "Auto-crop" on the 1:1 tile — green "✓ Will center-crop during generation" message appears
- [ ] Click "Generate prompts for all" — assuming an OpenRouter key is set, captions populate within ~15 seconds; otherwise a clear error message appears
- [ ] Edit one caption inline — changes persist
- [ ] Click "Regenerate caption" on one tile — spinner appears, new caption arrives
- [ ] Set duration = 3, fps = 24, resolution = 512p
- [ ] Click "Animate N videos" — modal closes, batch starts
- [ ] Check the queue: jobs should be `type: video`, model `ltx-fast`, with per-tile prompts and the auto-cropped tile's `aspectRatio` set to 16:9 (or 9:16 depending on orientation)

**Seedance path:**
- [ ] Return to the Animate tab, switch target to Seedance 1.5 Pro
- [ ] The 1:1 tile's red badge should disappear (Seedance supports 1:1)
- [ ] Re-run "Generate prompts for all" with Seedance selected → captions should be more concise (system prompt tailored per target)

**Error paths:**
- [ ] Remove the OpenRouter API key in Settings, go back to Animate tab, click "Generate prompts for all" — each tile shows an error indicating the key is missing

- [ ] **Step 7: Fix anything that failed in manual QA**

For each failure in Step 6, diagnose and fix. Commit each fix separately with a focused message.

- [ ] **Step 8: Final commit**

If everything passes with no fixes needed, skip this step. Otherwise commit any residual docs or cleanup.

```bash
git status
git add -A
git commit -m "chore(batch): manual QA cleanup"
```

---

## Self-review

After implementation, verify against the spec (`docs/superpowers/specs/2026-04-08-batch-creation-pipeline-design.md`):

- **Tab 1 (Prompts → Images)** → Task 9 implements textarea, blank-line parser, variations, seed modes (locked/random/sequential), image settings, and the "for animation" toggle
- **Tab 2 (Images → Videos)** → Tasks 10 and 11 implement the contact sheet, per-tile editable caption, auto-caption bar, target model selector, aspect ratio flagging, and auto-crop disposition
- **POST /api/caption-image** → Tasks 2–4
- **vision_captioner_model setting** → Task 1
- **LTX Fast + Seedance only (no LTX Pro)** → Tasks 4, 7, 11 (target literal) and settings stay untouched for Pro
- **Partial failure = keep going** → No code needed; the existing queue worker already processes jobs independently and `BatchStatusResponse` already reports `failed` vs `completed`
- **Mixed target models in one batch** (non-goal) → enforced because `targetModel` is a single state value in `BatchAnimateTab`
- **Per-tile duration/fps override** (non-goal) → not implemented
- **Prompt enhancer on batch prompts** (non-goal) → not implemented
- **Animate all → auto-handoff** (scoped out to a follow-up in Task 13) → replaced with hint text

All spec requirements covered.
