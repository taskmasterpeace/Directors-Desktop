# Director's Palette ⇄ Directors Desktop — Unified Creation Ecosystem (Design Spec)

Date: 2026-06-24
Status: Draft for review

## North star

Director's Palette (web) and Directors Desktop stop being two separate apps and become **one
creative pipeline**. You generate from the surfaces you already have (GenSpace, Playground,
gap-fill, the transcript panel), images flow to a shared cloud gallery under a dedicated
Director's Palette **workspace**, videos stay local and land on the editor timeline as
live placeholders, and generation runs on your DP account (image/shot generator) so you don't
juggle separate OpenRouter/Replicate/fal keys.

This is **not a new "workspace" screen in the desktop.** The generation surfaces already exist.
The work is connecting and extending them.

## Confirmed decisions (from the brainstorm)

1. **Images → DP cloud**, organized inside a dedicated **"Directors Desktop" workspace** that the
   app creates in DP if it doesn't exist. This is the shared image gallery (visible on web + desktop).
2. **Videos → local only.** Generated videos are large; we do **not** upload them. They live in the
   desktop's local gallery and on the timeline.
3. **Video placeholder lands at the playhead, on the next free video track** (never overwrites an
   existing clip), then swaps to the finished clip in place.
4. **DP cloud is the master** for the image gallery; the desktop caches/syncs.
5. **Music-Video mode uses pasted/imported lyrics** (not auto-transcription) for its context.
6. **Image generation runs through DP's shot generator** (your DP account + credits).
7. **First + last frame for Seedance 1.5** already works (`image`=first, `last_frame_image`=last);
   the job here is to surface it cleanly, not rebuild it.

## Pillars

### A. Generation modes — Story / Music-Video / Plain

The transcript→prompt bridge already supports `story_aware` + `media_type` (`image`/`video`).
Generalize the single `story_aware` boolean into a **mode**:

- **Story** — narrative continuity. System prompt: the full transcript is the story; keep setting,
  characters, wardrobe, tone consistent across moments. (Already built.)
- **Music-Video** — the context is **pasted lyrics** (a `lyrics` string the user provides, optionally
  with a `[section]`/timing structure). System prompt cares about hook, energy, repetition, and visual
  motifs per line/section rather than plot. Each selected lyric line → an image or video prompt that
  fits the song's overall vibe and the section (verse/chorus).
- **Plain** — just the selected text, no broader context. (Already built.)

Backend: `transcript_to_prompt` gains `mode: 'story' | 'music' | 'plain'` and an optional
`lyrics` field; `_transcript_system_prompt` branches on mode. The UI mode selector in `TranscriptPanel`
becomes a 3-way (it's currently Story/Plain) plus a "Lyrics" text area shown only in Music mode.
Music mode is also available from GenSpace/Playground (paste lyrics once, applies to the session).

### B. Director's Palette as the image / shot engine

Already started: `dp-nano-banana-2` / `dp-flux-2-klein-9b` image models route through
`PaletteImageClient` → `POST {dp}/api/v1/images/generate` with the user's `dp_` key. Extend:

- **Shot-generator parity**: pass reference images (`referenceImages[]`) — the desktop already
  collects references via `ReferencePicker`; encode/host them and forward. Optionally expose DP's
  `enableAnchorTransform` (anchor + inputs) and aspect-ratio control (already mapped).
- Keep local image models (flux/zit) as an option for offline/no-credit use. DP models are the
  default "no keys needed" path once connected.

### C. Storage & gallery model

This is the heart of the user's clarification.

```
IMAGES                              VIDEOS
  generated (DP or local)             generated (Seedance/local)
        │                                   │
        ▼                                   ▼
  upload to DP cloud                  stay on disk (outputs/)
  → "Directors Desktop" workspace     → local gallery + timeline
  (shared gallery, web + desktop)     (NOT uploaded — too large)
```

- **Workspace bootstrap**: on first connect (or first image save), ensure a workspace named
  "Directors Desktop" exists in the user's DP account (look up via `/api/workspaces`; create if
  missing). Cache its id in settings (`palette_desktop_workspace_id`).
- **Image save**: after a successful image generation, save it to that workspace's gallery
  (DP `/api/gallery/save` equivalent). The desktop gallery view reads from DP (cloud master) +
  a local thumbnail cache.
- **Videos**: never uploaded. The local gallery + the project timeline are the source of truth.
- **Sync direction**: images are pulled from DP (cloud master) so web-generated images also appear
  in the desktop gallery; desktop-generated images are pushed up to the workspace.

**DP-side work required (precise — verified against the directors-palette-v2 source):**

The existing `/api/gallery/save` uses cookie auth (`getAuthenticatedUser`) and `resolveSessionWorkspaceId`
(which finds an existing workspace but does NOT create one). The desktop sends a `dp_` key, not a cookie.
So DP needs a new route **`POST /api/desktop/gallery/save`** that:
1. `const result = await authenticateDesktopRequest(request)` → `result.user.id` (mirrors `/api/desktop/me`).
2. Uses the **service-role** client: `createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)`.
3. Ensures a **"Directors Desktop"** workspace: `select id from workspaces where user_id=? and name='Directors Desktop'`;
   if none, `insert { user_id, name: 'Directors Desktop' } returning id`.
4. Reuses the same image handling as `gallery/save` (fetch `imageUrl` → upload to the `gallery` storage bucket →
   `public_url`, `storage_path`, `file_size`, `mime_type`).
5. `insert into gallery { user_id, status:'completed', generation_type:'image', public_url, storage_path,
   file_size, mime_type, workspace_id, metadata:{ source:'desktop', prompt, model } }`.
6. Wrap responses in `withDesktopCors(...)` and add an `OPTIONS` handler (mirror `/api/desktop/me`).

Request body: `{ imageUrl: string, prompt?: string, model?: string }`. Response: `{ id, public_url, workspace_id }`.
This is an **isolated new file** (zero blast radius on existing routes) but must be **reviewed + tested locally
against your Supabase, then deployed** — it can't be tested from the desktop repo. The desktop then calls it
after each DP image generation (a `PaletteGalleryClient` mirroring `PaletteImageClient`). Either is a small, isolated change in `directors-palette-v2` + a redeploy.

### D. Video generation → timeline placeholders (everywhere)

Today, duration-sized placeholders exist for the "generate into a gap" flow. Generalize so **any**
video generation (GenSpace, Playground, transcript chain) drops a placeholder:

- On submit, immediately create a placeholder clip at the **playhead** on the **next free video
  track**, sized to the requested duration (≤15s for Seedance). The placeholder shows progress and a
  caption (the prompt).
- When the job completes, **swap the placeholder for the finished clip in place** (same start time +
  track). On failure, mark the placeholder errored with a retry affordance; never leave a silent gap.
- Reuse the existing placeholder mechanics + the queue (`/api/queue/submit` → status poll).

### E. First + last frame (Seedance 1.5)

Already correct in `replicate_video_client_impl.py`. Surface it consistently: the same UI that holds
reference images also exposes a **first frame** and **last frame** slot for 1.5 (Playground already
has frame slots). Make sure the transcript chain and GenSpace expose first/last frame when the model
is Seedance 1.5. No new backend work — wiring + UX only.

### F. Connective tissue (routing)

A single rule, applied from every generation surface:
- **Image result** → save to DP "Directors Desktop" workspace + show in gallery.
- **Video result** → placeholder at playhead/free track → swap to finished local clip.
- The transcript "Generate image → video" chain already does image-then-i2v; route its image to the
  workspace and its video to a timeline placeholder.

## Architecture / data flow

```
Generation surfaces (existing) ──► queue/handlers
   image → PaletteImageClient → DP image gen → upload to "Directors Desktop" workspace → gallery (cloud master ⇄ desktop cache)
   video → Seedance/local → local file → timeline placeholder swap (local only)
Prompt builder → transcript_to_prompt(mode: story|music|plain, lyrics?, media_type)
Settings → palette_api_key (dp_), palette_desktop_workspace_id, image_model (dp-*), mode prefs
```

## Edge cases & risks

- **No DP connection / no credits**: fall back to local image models; videos always work locally.
  Surface a clear "connect Director's Palette" or "out of credits" message (DP credits API exists).
- **Workspace race**: two devices creating "Directors Desktop" at once → look-up-then-create must be
  idempotent (match by name; if a duplicate appears, prefer the earliest id).
- **Large video library locally**: since videos aren't uploaded, the desktop owns retention. Provide a
  local "clear old generations" affordance later (not v1).
- **Lyrics length**: cap the lyrics context (like the 6000-char story cap) to stay within token limits.
- **Offline web-generated images**: desktop gallery needs network to pull the latest; cache last-known.
- **Placeholder ↔ result mismatch**: key the swap by job id so the right placeholder is replaced even
  if the user moved the playhead or queued several.
- **DP domain**: use `directorspal.com` (the live domain — `directorspalette.com` is dead).

## Open questions / decisions deferred

- Exact DP-side endpoint shape for desktop workspace-scoped image saves (needs a small DP change).
- Whether to also mirror DP's existing **music-video / lip-sync** features later (out of scope for v1).
- Whether videos ever get an opt-in "upload this one" (v1: no; flagged for later).

## Phasing (recommended build order)

1. **Modes** — add Music-Video mode (lyrics) to `transcript_to_prompt` + the panel/GenSpace. Cheap, high value, no DP dependency.
2. **Workspace + image save** — bootstrap the "Directors Desktop" workspace, save DP-generated images to it, read the gallery from DP. (Needs the small DP-side desktop save endpoint.)
3. **Universal video placeholders** — generalize placeholders to all video generation (playhead/free track, swap-in-place).
4. **Shot-gen references + first/last-frame UX** — forward references to DP image gen; surface 1.5 first/last frame everywhere.

First/last frame for 1.5 and DP image-model routing are already done and feed into the above.

## Out of scope (stated, not oversight)

A separate embedded DP web view; uploading videos to the cloud; a brand-new "create hub" screen
(we connect the existing surfaces); auto-transcribed lyrics (music mode uses pasted lyrics).
