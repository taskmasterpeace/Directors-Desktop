# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Directors Desktop (fork of LTX Desktop) is an Electron app for AI video generation. Generation runs locally (open LTX weights on the user's NVIDIA GPU) or via cloud providers.

**HARD POLICY — no LTX/Lightricks cloud, ever.** Nothing is sent to LTX the company: the LTX cloud API (`api.ltx.video`), Lightricks telemetry, the Lightricks update feed, and cloud text encoding are all permanently disabled/removed. The ONLY external services are **Replicate, fal, and Directors Palette** (plus HuggingFace for open-weight model downloads). `should_video_generate_with_ltx_api()` is hard-`False`; `sendAnalyticsEvent` is a no-op; the updater is disabled. Never re-enable any of these.

Three-layer architecture:

```
Renderer (React + TS) --HTTP: localhost:8000--> Backend (FastAPI + Python)
Renderer (React + TS) --IPC: window.electronAPI--> Electron main (TS)
Electron main --> OS integration (files, dialogs, ffmpeg, process mgmt)
Backend --> Local models + GPU | External APIs (when API-backed)
```

- **Frontend** (`frontend/`): React 18 + TypeScript + Tailwind CSS renderer
- **Electron** (`electron/`): Main process managing app lifecycle, IPC, Python backend process, ffmpeg export. Renderer is sandboxed (`contextIsolation: true`, `nodeIntegration: false`).
- **Backend** (`backend/`): Python FastAPI server (port 8000) handling ML model orchestration and generation
- **Vendored editor core** (`vendor/openreel-core/`): OpenReel's editor engines (action-based undoable editing, timeline managers, WebCodecs playback/export), vendored per `vendor/openreel-core/PROVENANCE.md` and resolved via the `@openreel/core` Vite alias. Excluded from `typecheck:ts`; compile-checked by `pnpm typecheck:vendor`; exercised by the smoke suite in `vendor/openreel-core/smoke/`. Editor-foundation roadmap: `docs/superpowers/specs/2026-07-18-editor-foundation-design.md`.

## Agent Bridge — reading and editing the user's project from Claude Code

While the app is running, agents can see and edit the open project through the backend. Spec: `docs/superpowers/specs/2026-07-20-story-context-markers-agent-editing-design.md`.

1. **Discover**: read `agent-bridge.json` in the app's userData dir (Windows: `%LOCALAPPDATA%\LTXDesktop\agent-bridge.json` — set by `electron/app-paths.ts`, NOT the Electron default) → `{ url, token, pid, startedAt }`. The file exists only while the backend is alive; verify `pid` is running if unsure.
2. **Authenticate**: send `Authorization: Bearer <token>` on every request.
3. **Read** (mirror of the renderer's autosaved state, ~1s fresh; never edit these responses expecting write-back):
   - `GET /api/project/current` — the full project (assets incl. `transcript`, timelines incl. `markers`, `storyDocs`, `cast`)
   - `GET /api/project/transcript` — the stitched live transcript of the current cut in timeline seconds
   - `GET /api/project/story` — story docs + cast verbatim
4. **Edit** via the bounded action queue — `POST /api/project/actions` with `{ "actions": [...] }`, kinds: `move_clip`, `trim_clip`, `delete_clip`, `add_marker`, `update_marker`, `delete_marker`, `captions_from_transcript`, `generate_and_place`. The renderer applies each through the undo stack (user can Ctrl+Z) and reports per-action `applied`/`rejected(reason)` — poll `GET /api/project/actions/status`. Actions never delete assets from the bin. `trim_clip`'s `trimStart`/`trimEnd` params are the ABSOLUTE source-media window in seconds (in-point/out-point) — NOT the clip's stored `trimEnd` field, which counts seconds cut off the end. `move_clip`/`delete_clip` carry linked A/V clips along, like the mouse. If the editor isn't open, actions stay `queued`/`delivered` — don't assume application without seeing `applied`.

## Common Commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Start dev server (Vite + Electron + Python backend) |
| `pnpm dev:debug` | Dev with Electron inspector (port 9229) + Python debugpy |
| `pnpm typecheck` | Run TypeScript (`tsc --noEmit`) and Python (`pyright`) type checks |
| `pnpm typecheck:ts` | TypeScript only |
| `pnpm typecheck:py` | Python pyright only (`cd backend && uv run pyright`) |
| `pnpm typecheck:vendor` | Typecheck the vendored OpenReel core under its own strict tsconfig |
| `pnpm backend:test` | Run Python pytest tests (`cd backend && uv sync --frozen --extra test --extra dev && uv run pytest -v --tb=short`) |
| `pnpm build:frontend` | Vite frontend build only |
| `pnpm build:win` / `pnpm build:mac` | Full platform builds (installer) |
| `pnpm build:fast:win` / `pnpm build:fast:mac` | Unpacked build, skip Python bundling |
| `pnpm setup:dev:win` / `pnpm setup:dev:mac` | One-time dev environment setup |

Run a single backend test: `cd backend && uv run pytest tests/test_generation.py -v --tb=short`

Run a single test function: `cd backend && uv run pytest tests/test_generation.py::test_name -v --tb=short`

## CI Checks

PRs must pass: `pnpm typecheck` + `pnpm test:frontend` (vitest pure-function suites) + `pnpm backend:test` + frontend Vite build.

## Frontend Architecture

- **Path alias**: `@/*` maps to `frontend/*` (configured in `tsconfig.json` and `vite.config.ts`)
- **State management**: React contexts only (`ProjectContext`, `AppSettingsContext`, `KeyboardShortcutsContext`) — no Redux/Zustand
- **Routing**: View-based via `ProjectContext` with views: `home`, `project`, `playground`, plus library views (`Gallery`, `PromptLibrary`, `Characters`, `References`, `Recipes`, `Wildcards`, `ClipTool`). The standalone `Styles` view still exists in code but is no longer in the nav — styles live inside References.
- **IPC bridge**: All Electron communication through `window.electronAPI` (defined in `electron/preload.ts`). Key methods: `getBackendUrl`, `getBackendToken`, `readLocalFile`, `checkGpu`, `getAppInfo`, `exportVideo`, `showSaveDialog`, `showItemInFolder`
- **Backend calls**: The backend runs on a FREE PORT with a per-session auth token. `frontend/lib/backend-auth.ts` installs a global `fetch` interceptor that attaches `Authorization: Bearer <token>` to backend-origin requests — plain `fetch(backendUrl + ...)` just works.
- **MEDIA LOADING RULE**: NEVER point `<img>`/`<video> src` at backend HTTP URLs. Resource loads bypass the fetch interceptor, so they 401 against the auth middleware and render blank (this is exactly how the Gallery broke). Render local media via the streaming `file://` protocol (`electron/file-protocol.ts` — MIME + Range support): convert the absolute path with a `pathToFileUrl`-style helper.
- **Image models — single source of truth**: `frontend/lib/image-models.ts`. Every surface (Gen Space, Playground, Settings, Batch, Video Editor) reads this registry — NEVER hardcode image model ids in a view. Palette-hosted models carry a `dp-` prefix; `migrateImageModelId` redirects retired ids (e.g. `dp-flux-2-klein-9b`). Capability flags (`supportsLora`, `supportsStrength`, `supportsCameraAngle`, `qualityOptions`, `aspectRatios`, `maxReferenceImages`, `requiresInputImage`) gate which controls render — don't show knobs a model ignores.
- **Quick modes**: `frontend/lib/shot-creator/quick-modes.ts` — Wardrobe / Character / Location / Style one-tap buttons on the Gen Space bar, with VERBATIM Palette prompts (wardrobe mannequin, character sheet, master location sheet, 3x3 style guide). Wardrobe's reference order is `[mannequin URL, outfit photo]` — order matters.
- **References taxonomy**: People / Places / Wardrobe / Styles (shared with Palette going forward). Legacy `props`/`other` load but aren't offered for new refs. `@wardrobe` parses as a category tag in `lib/shot-creator/reference-tags.ts`.
- **Generation hook**: `useGeneration()` manages the full generate → poll → complete lifecycle. Submits jobs to `/api/queue/submit`, polls `/api/queue/status` every 500ms, maps backend phases to user-facing status messages. Image jobs carry their own `model` (+ `modelParams`, `referenceImagePaths`) — the job's model wins over the saved default.
- **Frame extraction**: use `extractVideoFrame` from `frontend/lib/video-frames.ts` (hardware decode via offscreen `<video>` + canvas, ffmpeg IPC fallback, same `{path, url}` contract) — NOT `window.electronAPI.extractVideoFrame` directly.
- **LoRA support**: `GenerationSettings` includes `loraPath`, `loraWeight`, `loraTriggerPhrase`, and `loraTriggerMode` (`'prepend' | 'append' | 'off'`). Trigger phrase is applied client-side before submission. LoRA UI only renders for models with `supportsLora` (local flux pipelines).
- **Frontend tests**: vitest pure-function suites (`npx vitest run`) — lib-level tests for image-models, camera-angle, reference-tags, clip-math, transcript engines, video-frames, plus the vendored-core smoke suite.

## Backend Architecture

Request flow: `_routes/* (thin) -> AppHandler -> handlers/* (logic) -> services/* (side effects) + state/* (mutations)`

Key patterns:
- **Routes** (`_routes/`): Thin plumbing only — parse input, call handler, return typed output. No business logic.
- **AppHandler** (`app_handler.py`): Single composition root owning all sub-handlers, state, and lock. Sub-handlers accessed as `handler.health`, `handler.models`, `handler.downloads`, etc.
- **State** (`state/`): Centralized `AppState` using discriminated union types for state machines (e.g., `GenerationState = GenerationRunning | GenerationComplete | GenerationError | GenerationCancelled`)
- **Services** (`services/`): Protocol interfaces with real implementations and fake test implementations. The test boundary for heavy side effects (GPU, network).
- **Concurrency**: Thread pool with shared `RLock`. Pattern: lock -> read/validate -> unlock -> heavy work -> lock -> write. Never hold lock during heavy compute/IO. Use `handlers.base.with_state_lock` decorator.
- **Exception handling**: Boundary-owned traceback policy. Handlers raise `HTTPError` with `from exc` chaining; `app_factory.py` owns logging. Don't `logger.exception()` then rethrow.
- **Naming**: `*Payload` for DTOs/TypedDicts, `*Like` for structural wrappers, `Fake*` for test implementations

### Job Queue System

Generation requests flow through a persistent job queue rather than direct handler calls:

```
Frontend POST /api/queue/submit → JobQueue.submit() → QueueWorker.tick() → JobExecutor.execute()
Frontend polls GET /api/queue/status for progress updates
```

- **JobQueue** (`state/job_queue.py`): Persistent dataclass-based queue with JSON file backing. Jobs have `slot` (`gpu` | `api`) determining which executor runs them. On app restart, any `running` jobs are marked `error`.
- **QueueWorker** (`handlers/queue_worker.py`): Ticks on a timer, dispatches one job per slot concurrently via daemon threads. Two independent slots: `gpu` (local models) and `api` (cloud APIs).
- **JobExecutor** (`handlers/job_executors.py`): Protocol with `execute(job) -> list[str]`. GPU executor delegates to `VideoGenerationHandler`/`ImageGenerationHandler`; API executor calls external APIs.
- **Phase reporting**: Handlers report granular phases (`preparing_gpu`, `unloading_video_model`, `cleaning_gpu`, `loading_image_model`, `loading_lora`, `inference`, `decoding`, etc.) via `on_phase` callbacks through the pipeline chain. Frontend maps these to user-facing messages.

### Pipeline Lifecycle

GPU is shared between video and image models. Only one model type loaded at a time:

- `PipelinesHandler` manages swap lifecycle: unload current → clean VRAM → load new
- ZIT (image model) can be parked on CPU when video model needs GPU, then restored
- `load_zit_to_gpu(on_phase=...)` and `load_gpu_pipeline(model_type, on_phase=...)` accept phase callbacks for progress reporting during model swaps

### Backend Composition Roots

- `ltx2_server.py`: Runtime bootstrap (logging, `RuntimeConfig`, `AppHandler`, `uvicorn`)
- `app_factory.py`: FastAPI app factory (routers, DI init, exception handling) — importable from tests
- `state/deps.py`: FastAPI dependency hook (`get_state_service()` returns shared `AppHandler`; tests override via `set_state_service_for_tests()`)

### Backend Testing

- Integration-first using Starlette `TestClient` against real FastAPI app
- **No mocks**: `test_no_mock_usage.py` enforces no `unittest.mock`. Swap services via `ServiceBundle` fakes only.
- Fakes live in `tests/fakes/`; `conftest.py` wires fresh `AppHandler` per test
- Pyright strict mode is also enforced as a test (`test_pyright.py`)

### Backend Route Domains

Core: `health`, `settings`, `models`, `generation`, `image_gen`, `queue`
Video modes: `retake`, `ic_lora`
Library/content: `gallery`, `library`, `prompts`, `style_guide`, `contact_sheet`, `enhance_prompt`
Integration: `sync` (Palette cloud sync — status/connect/login, credits, characters/styles/references/**recipes** import, prompt enhance, LoRA sync), `receive_job` (incoming cloud jobs)
Agent bridge: `project` (read-model mirror + action queue — see the Agent Bridge section)
Director: `director` (music-video builds — see below)

### Director (music-video pipeline — clean-room, no Maestro/WanGP code)

Song in → finished music video out. `POST /api/director/start {audioPath, concept, model, resolution, referenceImagePaths}` → phase machine `analyzing → generating → assembling → complete|error|cancelled`, crash-resumable (`/resume` requeues failed shots, keeps finished ones; `/cancel`; `GET /status?runId=`).

- **Analysis** (`services/audio_analysis/`, librosa): tempo, beats, 4/4 downbeat phase, agglomerative section segmentation with energy labels. Lyrics via the existing Replicate whisper transcription (optional, non-fatal).
- **Planning** (`server_utils/shot_planner.py`, pure + deterministic): tiles the whole song with beat-snapped cuts; section energy sets pacing; heuristic prompt grammar (shot type × section flavor × energy × concept); words sung in a shot's window land in performance-shot prompts. `generate_seconds = ceil(shot)` clamped to Seedance's 4–15s; assembler trims to the exact fractional cut.
- **Generation**: shots are ordinary queue jobs (`tags=['director', run_id]`), slot routed per model via `determine_slot`. Cloud: Seedance via fal on the `api` slot (pre-flighted: no fal key → `FAL_API_REQUIRED` at start). **Local: `ltx-fast` on the `gpu` slot renders through the A2V pipeline** — each shot's job carries `audioPath` + `audioStartTime` (its beat position) + `audioMaxDuration` (its window), so LTX-2.3 generates audio-conditioned video that genuinely lip-syncs to the song's own bars, free, using the standard local model set (no extra downloads). One retry per shot, then a resumable error naming the failed shots. Shots surface their queue job's `phase`/`progress` (loading_model/inference/… + %) into the run for live UI status.
- **Assembly** (`services/video_assembler/`, imageio-ffmpeg): exact `-t` trim per shot, normalized concat, song muxed as the only audio track. Output `outputs_dir/director_<run>.mp4` (shows in Gallery).
- Run state: `state/director_store.py` (`director_runs.json`, atomic writes, bounded history). Frontend: `frontend/views/Director.tsx` (Home nav).
### Replace Person (Recast)

Right-click a video clip → "Replace Person…" swaps the person in the footage for a character image (library character or file), preserving motion/scene/camera. Runs as an api-slot queue job (`model` ∈ `RECAST_MODELS`); result returns as a new TAKE on the clip's asset. `services/recast_client/` (Protocol + fal impl): `wan-animate-replace` → `fal-ai/wan/v2.2-14b/animate/replace` (default, $0.04–0.08/s) and `scail-2-replace` → `fal-ai/scail-2` `mode=replacement` ($0.20/s, ≤10s, stylized/hard motion). `handlers/recast_handler.py` uploads footage+character to fal storage and lands output in `outputs_dir` (`recast_*.mp4`). The modal requires a rights/consent affirmation (fal AUP). SCAIL-2 weights are Apache-2.0 — a local 4090 pipeline can drop in behind the same Protocol later.

- **License rule**: this is a clean-room reimplementation. NEVER copy code from Maestro/WanGP (non-commercial license §3.4/3.5 forbids integration) or call a Maestro install as a service; mmgp and seed-vc are GPL-3.0 — do not vendor.

### Director's Palette image routing (v2 API — the credits path)

Image models selected as `dp-<model>` run on the user's Palette credits via the **live v2 API** at `https://directorspal.com` (Bearer `dp_` key). No Palette deploy is needed — v2 already supports all four current models (`nano-banana-2`, `nano-banana-2-lite`, `gpt-image-2`, `qwen-image-edit`).

`services/palette_image_client/` implements three operations:
- `upload_reference(bytes) -> public URL` — `POST /api/v2/images/upload` (multipart). v2's SSRF guard rejects base64 data URIs, so local reference images are uploaded first; paths that are already `http(s)` URLs pass through untouched.
- `generate_image(...) -> bytes` — `POST /api/v2/images/generate` (async) then poll `GET /api/v2/jobs/{job_id}` until `completed` → download `data.result.url`. Palette's own server receives the Replicate webhook; the desktop only polls.
- `generate_camera_angle(...) -> bytes` — `POST /api/v2/images/camera-angle` (synchronous). Send raw azimuth/elevation/distance; the route builds the `<sks>` prompt + injects the multi-angle LoRA server-side.

`image_generation_handler._generate_via_api` routes `dp-qwen-image-edit` to the camera-angle op (requires ≥1 reference) and everything else to generate+poll. `GenerateImageRequest.model` (from the queue job) wins over `settings.image_model`; `modelParams` carries per-model settings (gpt quality, camera azimuth/elevation/distance, loraScale…). v2 responses use the `{success, data}` envelope. Known limit: v2 generate does not thread nano's 2K/4K resolution or search params (nano runs at 1K).

### Adding a Backend Feature

1. Define request/response models in `api_types.py`
2. Add endpoint in `_routes/<domain>.py` delegating to handler
3. Implement logic in `handlers/<domain>_handler.py` with lock-aware state transitions
4. If new heavy side effect needed, add service in `services/` with Protocol + real + fake implementations
5. Add integration test in `tests/` using fake services

## TypeScript Config

- Strict mode with `noUnusedLocals`, `noUnusedParameters`
- Frontend: ES2020 target, React JSX
- Electron main process: ESNext, compiled to `dist-electron/`
- Preload script must be CommonJS (configured in `vite.config.ts` rollup output)

## Python Config

- Python 3.12+ required (`.python-version` pins 3.13), managed with `uv`
- Pyright strict mode (`backend/pyrightconfig.json`) — tests are excluded from pyright
- Dependencies in `backend/pyproject.toml`, lock in `backend/uv.lock`
- PyTorch uses CUDA 12.8 index on Windows/Linux (`tool.uv.sources`)

## Key File Locations

- Backend architecture doc: `backend/architecture.md`
- Default app settings schema: `settings.json`
- Electron builder config: `electron-builder.yml`
- Video editor (largest frontend file): `frontend/views/VideoEditor.tsx`
- Project types: `frontend/types/project.ts`
- IPC API surface: `electron/preload.ts`
- Python backend entry: `backend/ltx2_server.py`
- Build/setup scripts: `scripts/` (platform-specific `.sh` and `.ps1` variants)
- Job queue: `backend/state/job_queue.py`
- Queue worker: `backend/handlers/queue_worker.py`
- Job executors: `backend/handlers/job_executors.py`
- Queue routes: `backend/_routes/queue.py`
- Generation hook: `frontend/hooks/use-generation.ts`
- Image model registry (single source of truth): `frontend/lib/image-models.ts`
- Quick-mode prompts (verbatim Palette): `frontend/lib/shot-creator/quick-modes.ts`
- Camera-angle helper + pad: `frontend/lib/shot-creator/camera-angle.ts`, `frontend/components/CameraAnglePad.tsx`
- Backend auth fetch interceptor: `frontend/lib/backend-auth.ts`
- Streaming file:// protocol (media loading): `electron/file-protocol.ts`
- Palette v2 image client: `backend/services/palette_image_client/`
- Palette sync client (credits/library/recipes): `backend/services/palette_sync_client/`
- Local library store (characters/styles/references/recipes JSON): `backend/state/library_store.py`
- Hero banner video: `public/hero-video.mp4` (2092x480, ~4.36:1, 30fps, 30s loop, H.264, no audio; left-gradient + `public/logo.svg` overlay in `Home.tsx`)
