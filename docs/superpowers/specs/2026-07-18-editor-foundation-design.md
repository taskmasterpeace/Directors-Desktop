# Editor Foundation: OpenReel core, hardware decode, and the recipes workspace

**Date:** 2026-07-18
**Status:** Phase 1 in progress (autonomous session; direction confirmed by Robert)
**Prior art:** `2026-07-18-clip-to-reference-design.md` (clip → reference pipeline)

## Direction

Directors Desktop stays a generation-first Electron + Python app — that core is
untouchable. Around it, we are building a **full-featured editor** on the
foundation of OpenReel's engines instead of growing `VideoEditor.tsx` further:

1. **Vendor `@openreel/core`** (MIT, https://github.com/Augani/openreel-video) —
   action-based undoable editing, timeline managers, WebCodecs playback/export.
2. **Hardware decode now** — the user runs an RTX 4090; Chromium's NVDEC path
   should do frame work, not ffmpeg process spawns.
3. **Recipes workspace** — Palette-style location/wardrobe/style recipes usable
   from every prompt surface (and later shared across the Machine King apps).

## Phase 1 (this session)

### Vendored core (`vendor/openreel-core/`)

- Source-shipped upstream (`main: ./src/index.ts`), consumed via Vite alias
  `@openreel/core` → `vendor/openreel-core/src`. See `PROVENANCE.md` there for
  commit hash, local-modification contract, and update procedure.
- **Isolation contract:** DD's `typecheck:ts` does not include the vendor tree
  (root tsconfig `include: ["frontend"]` and nothing in `frontend/` imports the
  vendor yet); `pnpm typecheck:vendor` compiles it under its own strict config
  (green at vendoring time). DD's vitest include is pinned so OpenReel's
  internal tests don't run in our suite; our `vendor/openreel-core/smoke/`
  suite proves alias + deps + the execute→undo→redo action loop inside DD's
  harness.
- Runtime deps added to root package.json: immer, uuid, mediabunny, idb-keyval,
  gsap, @ffmpeg/ffmpeg, @ffmpeg/util, @mediapipe/tasks-vision.
- Known gap: upstream does not commit `src/wasm/*/build/*.wasm`; audio
  FFT/beat-detection needs an AssemblyScript build before use.

### Hardware frame service (`frontend/lib/video-frames.ts`)

- Drop-in replacement for `electronAPI.extractVideoFrame` (same `{path, url}`
  file contract): offscreen `<video>` seek + canvas capture → JPEG → temp file
  via `saveBinaryFile` + new `get-temp-path` IPC. Decode runs on Chromium's
  hardware path (NVDEC/D3D11 on the 4090).
- Feature-detected; any failure falls back to the ffmpeg IPC path, and two
  consecutive hardware failures pin the session to ffmpeg (no repeated
  timeout tax). Seeks are clamped to duration, which also fixes the
  "seek to 9999 = last frame" convention that ffmpeg errors on.
- All six extraction call sites (GenSpace extend, VideoEditor, VideoPlayer,
  gap generation ×2, regeneration) now route through it.

## Phase 2 (next): editor state on the action system

Rebuild the editor's interaction core on `@openreel/core` engines rather than
adopting Zustand separately — the vendored `ActionExecutor`/`ActionHistory`
IS the action-based store:

- Introduce an adapter mapping DD's project/timeline types
  (`frontend/types/project.ts`) to OpenReel `Project`/`Timeline`/`Track`/`Clip`.
  DD assets are `file://` paths; OpenReel `MediaItem` accepts
  `blob: null` + `originalUrl`, so a path-backed media library is legal.
- Route timeline mutations in `VideoEditor.tsx` through `ClipManager`
  (add/move/trim/split/ripple) to gain validated edits + undo/redo for free.
- Undo/redo UI binds to `ActionHistory` (`canUndo`, `getDisplayHistory`,
  snapshots).
- When this lands, `frontend/` imports the vendor for real: bump root tsconfig
  `target`/`lib` to ES2022 (Electron 31 supports it) and fold the vendor into
  the typechecked program (or keep `typecheck:vendor` as a separate project
  reference — decide by error volume at integration time).

## Phase 3: playback + export engines

- Replace the preview `<video>`-tag pipeline with OpenReel's `playback` engine
  (WebCodecs + mediabunny) for frame-accurate multi-track scrubbing.
- Evaluate `ExportEngine` (WebCodecs hardware encode) against the current
  ffmpeg exporter; keep ffmpeg for containers/codecs WebCodecs can't write.
- Effects/graphics/text engines (WebGPU) arrive here — this is what makes the
  "full-featured editor" (transitions, color, text animation) real.

## Recipes workspace (parallel track, branch `recipes-library`)

- Backend `recipes` library entity (kind: location | wardrobe | style; name;
  text) with `/api/library/recipes` routes mirroring references; frontend
  Recipes view + a RecipePicker quick-insert popover in Playground and
  GenSpace prompt bars.
- v1 is local-only. The "shared workspace" (Palette ↔ Desktop sync of recipes)
  lands after: Palette already exposes a recipe API (see the directors-palette
  skill); the sync route domain (`_routes/sync.py`) is the integration point,
  following the existing reference-sync download-and-register pattern.

## Addendum (2026-07-18, later): transcript-of-truth + animate-still

Assessment against the goal "Descript-style transcript, script as source of
truth, animate stills like the Shot Animator":

- **Already existed** (verified, not rebuilt): the Descript-style
  `TranscriptPanel` — click-to-seek with speed-aware source↔timeline math,
  active-word highlight, shift-click selection, silence-snapped ripple delete,
  double-click word editing, transcript→prompt→generate bridge; backend
  word-level STT via Replicate `incredibly-fast-whisper` (accepts video
  directly). Mounted for both video AND audio clips (audio dramas covered),
  words cached per clip.
- **New — script of truth** (`frontend/lib/transcript-align.ts`): the user's
  real script (audiobook chapter, drama dialogue) aligns to STT timings —
  two-pointer walk with a bounded resync window; exact matches anchor, near
  misses become substitutions (script text, STT timing), STT-missed words get
  length-weighted interpolated timings between anchors, STT hallucinations
  are dropped, output forced monotonic. Panel UI: "Script" → paste →
  "Use as source of truth", alignment-quality badge (% timed from speech /
  interpolated / mishears dropped) and Revert-to-STT. 16 unit tests including
  a realistic audiobook passage.
- **New — animate a still (Shot Animator flow)**: `pendingAnimateImage`
  handoff → Playground opens in image-to-video with the still preloaded,
  model `seedance-2.0`, prompt seeded from the shot's original prompt and
  focused for directed motion. Entry points: "Animate in Playground" on image
  clips in the editor properties panel and a hover Sparkles action on Gallery
  images. (The editor's inline quick "Generate Video (I2V)" stays for
  in-timeline regeneration.)
- **UX lift**: transcript auto-scrolls the active word into view during
  playback (Descript behavior).
- **OpenReel bring-over verdict for this area**: their
  `speech-to-text-engine` is the browser Web Speech API — sentence-level, no
  word timestamps, online-only — strictly worse than our Replicate whisper
  path; do NOT adopt. Their karaoke subtitle rendering remains the Phase 3
  candidate for styled word-by-word subtitles.
- **Known limit**: transcription inlines audio as a base64 data URI —
  fine for scenes/chapters (minutes), not for a full multi-hour audiobook
  file in one shot; chunked/Files-API upload is future work if needed.

## Testing/verification policy

Every phase keeps the CI contract green: `pnpm typecheck` (ts+py),
`pnpm test:frontend`, backend pytest, `pnpm build:frontend`, plus
`pnpm typecheck:vendor` for the vendored tree. Runtime-only paths (hardware
decode, WebGPU) always ship with a software/ffmpeg fallback so a bad driver
never breaks the app.
