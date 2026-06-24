# Director's Desktop — Handoff to Kenil

**Repo:** `taskmasterpeace/Ai-Directors-Desktop` · **Branch:** `main` · **Date:** 2026-06-24

This is the orientation doc for taking over Director's Desktop. **Read this before the product brief** —
because most of the MVP the brief describes is *already built*. The job is not to start from scratch; it's
to finish the last connective pieces and harden what exists.

---

## TL;DR — what this is

An **Electron + React + Python (FastAPI)** desktop app, adapted from the open-source **LTX Desktop**
foundation into an AI-native non-linear video editor that integrates with **Director's Palette** (the web
product at `directorspal.com`). Creators select a moment on the timeline, generate exactly the clip needed
for that moment, and the result lands back in place — without leaving the editor.

```
Renderer (React+TS)  --HTTP localhost:random-port-->  Backend (FastAPI/Python)  --> local GPU models | cloud APIs
Renderer             --IPC window.electronAPI------->  Electron main (TS)        --> OS: files, ffmpeg, process mgmt
```

## Run it

```bash
pnpm install
pnpm setup:dev:win        # one-time (or :mac)
pnpm dev                  # Vite + Electron + Python backend
pnpm typecheck            # tsc + pyright
pnpm backend:test         # 555 pytest tests
pnpm test:frontend        # vitest pure-function suites
```

Hardware: local generation needs an NVIDIA GPU (32GB+ VRAM ideal; dev box is a 4090/24GB). **API-only mode**
works on any hardware/macOS — all the cloud generation (Seedance, DP images) runs without a local GPU.

`CLAUDE.md` at the repo root has the full architecture map. `backend/architecture.md` covers the backend
request flow (`_routes → AppHandler → handlers → services + state`).

---

## What the brief asks for vs. what already exists

The product brief describes an MVP loop. Here is the honest status of each piece **in this codebase today**:

| Brief feature | Status | Where it lives |
|---|---|---|
| Timeline editor | ✅ Built | `frontend/views/VideoEditor.tsx` (+ `editor/`) |
| Transcript panel, word-level timestamps, click-to-seek | ✅ Built | `frontend/components/TranscriptPanel.tsx`; transcription via `backend/handlers/transcription_handler.py` (Replicate fast-whisper) |
| Highlight transcript range → auto clip duration | ✅ Built | `frontend/lib/transcript-ripple.ts`, transcript→timeline mapping |
| AI generation panel inside the editor | ✅ Built | `frontend/views/GenSpace.tsx`, `Playground.tsx` |
| `@character` references picker | ✅ Built | `frontend/components/ReferencePicker.tsx`, `AtAutocompleteDropdown.tsx`, `useMentionOptions.ts` |
| Real AI video generation | ✅ Built | Seedance 1.5 (Replicate, first+last frame), Seedance 2.0 (fal, reference-to-video); `backend/services/{video_api_client,fal_video_client}` |
| DP image generation (`dp-*` models) | ✅ Built | `backend/services/palette_image_client/` → DP `/api/v1/images/generate` |
| Story / Music / Plain prompt modes (music = pasted lyrics) | ✅ Built | `backend/handlers/enhance_prompt_handler.py`, `TranscriptPanel` mode selector |
| Placeholder while generating | 🟡 Partial | exists for the **gap-fill** flow (duration-sized placeholder swaps to finished clip). **Not yet universal** — see TODO-1 |
| Metadata preservation | 🟡 Partial | `generationParams` on clips + `GET /api/generations`; not every field in the brief is captured yet — see TODO-3 |
| Save generated images to a DP "workspace" | 🟡 Blocked on DP | desktop client is specced; needs a **DP-side endpoint deployed** — see TODO-2 |
| Regeneration / versioning per timeline slot | ❌ TODO | TODO-4 |
| Context-aware shot assistance (prev/next clip awareness) | ❌ TODO | TODO-5 |
| Audio references + audio library (Seedance 2.0 lip-sync) | ❌ TODO | TODO-6 |

**Takeaway:** the core loop (transcript → duration → `@`refs → prompt → generate → real clip) is mostly
working. The remaining work is *finishing placeholders everywhere, the DP image-save round-trip, metadata
completeness, versioning, and context-awareness* — plus answering the open product questions below.

---

## Your 10 questions, answered from the code

1. **Is LTX Desktop the right foundation, or a trap?** Right foundation — it's *already* adapted and
   shipping features. It has a working timeline, job queue, and generation pipeline. Not a trap; it's live.
2. **How hard is a transcript panel?** Already done. Word-level timestamps (`TranscriptWord{text,start,end}`,
   seconds into *source* media so they survive trim/split/speed), click-to-seek, ripple-delete editing.
3. **How hard to insert clips programmatically?** Done for gap-fill: the app creates a duration-sized
   placeholder clip and swaps in the finished file. Generalizing this to *every* generation surface is TODO-1.
4. **Custom metadata on clips/assets?** Yes — clips carry `generationParams`; the job queue persists
   `params` + `result_paths`; `GET /api/generations` exposes them. Extend the schema for TODO-3.
5. **Transcript format?** JSON, word-level, from Replicate `incredibly-fast-whisper`. SRT/VTT *import* is a
   small add if you want it; internal model stays JSON source-time.
6. **Local project file structure?** See `frontend/types/project.ts`. Projects are JSON; generated media
   lands under `backend/outputs/` (gitignored). App settings/keys live outside the repo in
   `%LOCALAPPDATA%/LTXDesktop/` — never committed.
7. **How does DP share character references?** DP exposes a desktop API: `authenticateDesktopRequest`
   (accepts a `dp_` API key *or* a Supabase JWT) + `/api/desktop/me`, `/api/v1/images/generate`. The `@`
   picker already pulls characters/references into the generation request. See `docs/palette-api-spec.md`.
8. **Mocked or real AI first?** Real already works — no mock needed. Seedance and DP image gen are live.
9. **Fastest path to a demo?** The loop is ~80% there. The shortest path to a clean end-to-end demo is:
   finish **universal placeholders (TODO-1)** + the **DP image-save round-trip (TODO-2)**. Everything else
   (transcript, `@`refs, real generation) already demos today.
10. **Most likely to break / waste time?** (a) The **DP-side endpoint** — it needs a deploy + a `dp_` key,
    neither of which can be tested from the desktop repo alone (TODO-2). (b) **Local GPU generation** is
    heavy and was crashing on startup — that crash is now **fixed** (see below); don't chase it again.

---

## Recently fixed — don't re-investigate

- **Startup crash (intermittent `0xC0000005` on launch).** Root cause was **not** the GPU. The `file:`
  protocol handler in `electron/main.ts` called `net.fetch(request)` without
  `bypassCustomProtocolHandlers`, so every `file://` resource (a gallery thumbnail) recursed back into the
  handler → stack overflow inside `electron.exe`. Fixed with one flag; verified 3/3 clean launches. If you
  see GPU-flag experiments in history, they were dead ends and were reverted.

---

## Remaining work (proposed issue set)

> Each of these is written to stand alone as a GitHub issue. File pointers included.

### TODO-1 — Universal video-generation placeholders
**Goal:** every video generation (GenSpace, Playground, transcript chain) immediately drops a
duration-sized placeholder at the **playhead** on the **next free video track**, then swaps it for the
finished clip in place (key the swap by job id). On failure, mark errored with a retry, never a silent gap.
**Today:** only the gap-fill flow does this. **Files:** `frontend/hooks/use-generation.ts`,
`frontend/views/VideoEditor.tsx`, the queue status poll. **Done when:** generate from any surface →
placeholder appears at the selection → finished clip replaces it at the same start/track.

### TODO-2 — DP "Directors Desktop" workspace image-save (needs DP deploy)
**Goal:** desktop-generated images save to a shared cloud gallery under a DP workspace named
"Directors Desktop"; videos stay local (too large to upload). **Blocker:** DP needs a new
`POST /api/desktop/gallery/save` route (auth via `authenticateDesktopRequest`, service-role Supabase
client, ensure-workspace-then-insert). The exact contract is specced in
`docs/superpowers/specs/2026-06-24-dp-desktop-ecosystem-design.md` (§C). Then add a `PaletteGalleryClient`
on the desktop mirroring `palette_image_client/`. **Needs:** a DP deploy + a `dp_` API key to test.

### TODO-3 — Complete generation metadata
**Goal:** persist the full brief metadata per generated clip: prompt, characters/references, transcript
words + start/end, timeline start/end, duration, provider/model, timestamp, file path/asset id, version
number, accepted/replaced/regenerated. **Today:** partial (`generationParams`, generations API). **Files:**
`frontend/types/project.ts`, `backend/_routes/generations.py`, job queue params.

### TODO-4 — Regeneration / versioning per slot
**Goal:** a timeline slot can hold multiple alternate versions of the same shot (not unrelated files);
store versions, let the user pick the active one. MVP can be a simple version list. **Depends on:** TODO-3
metadata (`version number`, slot id).

### TODO-5 — Context-aware shot assistance (basic)
**Goal:** the generation request knows previous clip, next clip, selected transcript text, project
description, character refs, and mode (music vs narration). MVP = pass this context; later = an assistant
that suggests the shot. **Files:** generation request assembly in `use-generation.ts` + backend prompt build.

### TODO-6 — Audio references + audio library (Seedance 2.0 lip-sync)
**Goal:** an audio library (uploads + timeline clips + voiceover/music) usable as `@audio` references for
Seedance 2.0 (`audio_urls`, ≤3, requires ≥1 image). **Status:** backend client supports `audio_urls`; the
library data model + UI are the remaining pieces. This is the existing pending task. **Files:**
`backend/state/library_store.py`, `backend/_routes/library.py`, a frontend audio picker.

### What NOT to build yet (from the brief — keep it scoped)
Full movie generation · advanced AI assistant · collaboration/multi-user · complex cloud sync · advanced
effects/color · marketplace/payments · full project management · perfect UI polish. The first proof is the
AI-native timeline loop, and it's nearly there — finish TODO-1 and TODO-2 first.

---

## State of the tree at handoff
- All checks green: **555** backend tests, **16** frontend tests, pyright 0/0, tsc clean, frontend build clean.
- No secrets in the repo (`app_state.json` and `.env*` are gitignored / live outside the tree).
- Generated media (`outputs/`, test artifacts) is gitignored.
- Related design docs: `docs/superpowers/specs/2026-06-24-dp-desktop-ecosystem-design.md` (the DP⇄Desktop
  vision + the DP-side endpoint contract), `docs/palette-api-spec.md`, `docs/palette-team-handoff.md`.
