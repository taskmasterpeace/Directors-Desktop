# Clip → Reference: send a trimmed video clip into generation as a reference

**Date:** 2026-07-18
**Status:** Approved for implementation (autonomous /goal session)

## Goal

Give the app a video clip (primarily mp4s downloaded from YouTube), select **up to
fifteen seconds** of it, have the app **automatically splice** that selection into a real
clip file, and **send that clip as a reference** into video generation together with a
prompt describing **the changes to make** — all fitting the existing design language.

## Why this approach

fal's Seedance 2.0 `reference-to-video` route (already integrated for omni image/audio
references) also accepts **`video_urls` — up to 3 reference videos** (verified schema,
2026-06-22). That makes the clip itself the reference: motion, composition, and identity
of the source inform the generation, and the prompt (`@Video1 …`) describes the changes.

Alternatives considered:

- **Extract a frame → image reference / start frame** — loses all motion; already
  possible today via the start-frame slot, so it adds almost nothing.
- **LTX retake (local video-to-video)** — retake is built around re-taking *generated*
  assets (its own panel, `replace_audio_and_video` semantics); arbitrary YouTube sources
  are a mismatch, and the user asked for "reference", which is the omni-reference system.

## User flow

1. Home → Tools → **Clip Tool**. Load any video (mp4/mov/mkv/webm/avi/m4v).
2. Select the moment: drag the window to position it, **drag its edges to resize** —
   free length 0.5–30 s; the 15 s / 30 s preset buttons snap the length.
3. Click **Use as reference** (primary action; enabled when the selection is ≤ 15 s,
   with an inline hint when longer). The app:
   - auto-exports the selection with the existing frame-accurate ffmpeg re-encode to
     `Downloads/DirectorsDesktop/clips/<name>_ref_<start>s_<len>s_<stamp>.mp4`
     (Downloads is already an allowed ffmpeg output root — no save dialog),
   - opens the **Playground** with model switched to `seedance-2.0`, the clip attached
     to the reference rail as **@Video1**, and the prompt seeded with `@Video1 ` and
     focused so the user types the changes they want.
4. Generate → backend uploads the clip to fal storage (same hosted-URL policy as
   image/audio references) and calls `reference-to-video` with `video_urls`.

Plain **Export…** (save-dialog flow) remains as the secondary action.

## Changes

### Frontend

- `lib/clip-math.ts` — selection length becomes a free `number` (presets stay
  `15 | 30`); new pure helpers: `resizeEdge(selection, duration, edge, time, min, max)`,
  `MIN_CLIP_LENGTH = 0.5`, `MAX_CLIP_LENGTH = 30`, `MAX_REFERENCE_LENGTH = 15`,
  `formatLength`, `suggestReferenceName(sourceName, selection, stamp)`. Unit-tested.
- `views/ClipTool.tsx` — edge drag handles on the selection window (`move | start | end`
  drag modes); length readout; **Use as reference** primary button (auto-export +
  handoff), Export secondary.
- `contexts/ProjectContext.tsx` — `pendingClipReference: { path, label } | null` +
  setter, following the existing `genSpaceRetakeSource` cross-view pattern.
- `views/Playground.tsx` — consume `pendingClipReference` on mount: mode
  `text-to-video`, model `seedance-2.0`, `videoReferencePaths=[path]`, prompt
  `"@Video1 "`, focus prompt, clear the pending value.
- `lib/positional-tags.ts` — `RefKind` gains `'video'` (cap 3, prefix `Video`,
  `@VideoN` tokens in all helpers).
- `components/SettingsPanel.tsx` — `GenerationSettings.videoReferencePaths?: string[]`.
- `components/ReferencePicker.tsx` — Video section: add-from-file (mp4/mov/webm/m4v),
  film-icon chips tagged `@VideoN`, cap 3; `onChange` carries `videoReferencePaths`.
  Both call sites (Playground, GenSpace) wired through.
- `hooks/use-generation.ts` — include `videoReferencePaths` in submit params for
  Seedance 2.0 (mirrors the audio-reference gating).

### Backend

- `api_types.py` — `GenerateVideoRequest.videoReferencePaths: list[str]` (default []).
- `handlers/job_executors.py` — pass `videoReferencePaths` through both executors.
- `services/video_api_client/video_api_client.py` — protocol gains
  `reference_videos: list[str] | None = None`.
- `services/video_api_client/replicate_video_client_impl.py` — accepts the kwarg;
  Seedance 1.5 does not support it (handler rejects before reaching here).
- `services/fal_video_client/fal_video_client_impl.py` — `reference_videos` param,
  `_MAX_REF_VIDEOS = 3`, `video_urls` in the ref payload; routes to `reference-to-video`
  when image **or** video references are present.
- `handlers/video_generation_handler.py` — validate ≤ 3 video references (400);
  reject video references on non-Seedance-2.0 models (400); `_upload_reference`
  generalized from `is_audio` flag to `kind: image | audio | video` with a video MIME
  map; hosted-URL upload (never base64 — clips are tens of MB).
- Fakes (`tests/fakes/services.py`) — `FakeVideoAPIClient` records `reference_videos`.
- Tests (`tests/test_seedance_video.py`) — video refs upload + route to `ref`;
  video-only refs (no images) still route to `ref`; > 3 rejected; 1.5-pro rejected.

### Electron

No changes — `clip-trim` IPC, `getDownloadsPath`, `ensureDirectory` already exist, and
`Downloads` is in `getAllowedRoots()`.

## Error handling

- Selection > 15 s → reference button disabled with the cap explained inline.
- Auto-export failure → inline error in the Clip Tool (same style as export errors).
- Missing fal key at generate time → existing API-gateway modal flow (unchanged).
- fal upload/generation failures surface through the existing job error path.
- Backend validation mirrors fal's rules; nothing is silently dropped.

## Testing

- Pure math: vitest for `resizeEdge` bounds/min/max, `suggestReferenceName`,
  `formatLength`; positional-tags video-kind coverage.
- Backend: integration tests via TestClient + fakes (no mocks), pyright strict.
- Full suite: `pnpm typecheck`, `pnpm test:frontend`, `pnpm backend:test`,
  `pnpm build:frontend`.
