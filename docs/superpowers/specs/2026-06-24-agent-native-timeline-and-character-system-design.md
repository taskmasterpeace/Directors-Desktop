# Agent-Native Timeline + Character Intelligence — Design Spec

Date: 2026-06-24
Status: Design — approved direction, **not** scheduled for build yet (documentation + issues only)
Related: [login parity #9](https://github.com/taskmasterpeace/Ai-Directors-Desktop/issues/9), [DP⇄Desktop ecosystem spec](2026-06-24-dp-desktop-ecosystem-design.md)

## North star

Director's Desktop should let the **AI perceive and act on a project the same way the user can** — read the
whole timeline and transcript, know exactly where every clip and generation sits (to the second), know who
each character is, and place/replace/adjust clips on command. A creator should be able to drop in a song,
get a beat-accurate transcript, have the app surface the characters automatically, tie them to real
references, and generate the right shot into the right slot — with every generation remembering *what* it is,
*where* it lives, and *who* is in it.

This spec captures **five pillars** and the research behind each. It is **documentation only** — no build is
scheduled here. Each pillar becomes a structured GitHub issue with explicit feature and quality goals.

## Confirmed decisions (from the brainstorm)

1. **AI role = read + write, act on command.** The AI can read the full project and also place, replace,
   re-time, mute, and swap clips when told to — with **undo**. (Not full autonomy in v1.)
2. **Character mapping = propose, then confirm.** The app extracts characters from the story/transcript and
   the user confirms and ties each to a real reference. No silent auto-mapping.
3. **Audio → transcript in-app.** The user can hand the app a song; it transcribes for **timing**.
4. **Lyrics + audio = the winner (forced alignment).** When real lyrics are provided, the *words* come from
   the lyrics (100% correct) and the *timing* from aligning them to the audio.
5. **Don't transcribe the music.** Separate the vocal first; transcribe the vocal, not the beat.
6. **Reuse Director's Palette's intelligence.** DP already ships the entity-extraction and lyric-analysis
   brains as stateless services; mirror them rather than reinventing.
7. **"You" = the application.** This intelligence (prompts, processing) is built *into the app*; it is not a
   human running Claude each time.

## Research summary (decision-ready)

### Transcription & alignment (Replicate-first)
- **Vocal separation first** is the single biggest accuracy win on music: **Demucs** (`cjwbw/demucs`,
  `htdemucs_ft`). Source: [Exploiting Music Source Separation for ALT, ICME 2025](https://arxiv.org/abs/2506.15514).
- **Word-level timing**: **WhisperX** (`victor-upmeet/whisperx`) does Whisper + wav2vec2 forced alignment →
  true per-word timestamps (~$0.03/song). The app already uses `vaibhavs10/incredibly-fast-whisper` — keep it
  as the fast draft path (no true alignment).
- **Forced alignment of provided lyrics** (the "winner"): align known lyrics text to audio with
  `whisperx.align()` or [`ctc-forced-aligner`](https://github.com/MahmoudAshraf97/ctc-forced-aligner) (MMS-300m,
  1000+ languages). **Gap:** no public Replicate model accepts your-own-transcript today → needs a small
  **custom Cog**. [Montreal Forced Aligner](https://montreal-forced-aligner.readthedocs.io/) is highest
  accuracy but local-only (a future "precision" toggle).
- **Pipelines:** (a) audio only → Demucs → WhisperX. (b) audio + lyrics → Demucs → forced-align lyrics.
- **Gotchas:** overlapping adlibs misalign (flag low-confidence words for manual nudge); normalize numerals to
  words before alignment; set language explicitly (auto-detect is shaky on music).

### Entity-review UX (research-backed)
Pattern across Prodigy, Label Studio, Apple/Google Photos, Descript, Otter, CiviCRM: **machine proposes, human
confirms in one gesture; confirm once → apply to all mentions; link-to-existing is the default; three-state
disambiguation (Same / Different / Not sure); aliases drive find-and-replace.** Chosen UI: the **"Review Cast"
side panel** (see Pillar 5). Status colors: green = confirmed, amber = needs review, red = conflict (never purple).

### Director's Palette reuse (verified in `directors-palette-v2`)
- `OpenRouterService.extractEntities(storyText)` — LLM character extraction that **already merges aliases**,
  assigns roles, and writes visual descriptions; also extracts locations with `@tag`s.
- `lyric-analysis.service` — Whisper word timing → verse/chorus structure → themes/emotional arc → vocal regions.
- `StoryboardCharacter` — `name` + `metadata.aliases[]` + `reference_tag` + reference image: the exact model.
- `name-replacement.service` — alias-aware `@tag`/name → description substitution.
- All are described as **stateless and portable** to the desktop with no DB changes.

---

## Pillar 1 — Login parity (tracked in [#9](https://github.com/taskmasterpeace/Ai-Directors-Desktop/issues/9))

**Feature goals:** sign in to the desktop with the *same* methods as directorspal.com (email/password **and
Google**, same Supabase project); fix the broken `dp_` API-key path (validate against DP's deployed
`/api/desktop/me`); persistent, auto-refreshing session; a session/key the **AI agent** can use headlessly to
read the project and call generation APIs.

**Quality goals:** a returning user is logged in automatically; Google works like the web; a wrong password
gives a clear error; the agent can authenticate without a human in the loop. Prerequisite for Pillars 2–5.

---

## Pillar 2 — Project Context API (the AI's eyes + hands)

Today the timeline + transcript live **only in the front-end** (React state / IndexedDB). The backend and the
AI cannot see them, and there is no way for the AI to act. This pillar fixes the foundation.

**Feature goals**
- **Read:** a backend endpoint returning the full current project as structured JSON — every track (kind
  video/audio, muted, enabled/visible, locked) and every clip (`id`, type, `startTime`, `duration`, `trackIndex`,
  `trimStart/End`, `speed`, `muted`, `volume`, `assetId`, `isGenerating`, linked clips). The data model already
  exists in `frontend/types/project.ts` — it just isn't exposed.
- **Act:** a small, **bounded** action API the AI calls on command: `placeClip(assetId, trackIndex, startTime)`,
  `replaceClip(clipId, assetId)`, `moveClip/retime`, `setMuted(clipId|trackId, bool)`, `removeClip`. Every action
  is one reversible step and pushes a single **undo** entry.
- **Bridge:** the running editor is the source of truth; it publishes a live read-model snapshot to the backend
  and applies queued actions, reporting success/failure back (so the AI "acts" in the app the user is watching).

**Quality goals**
- The read model is accurate to the **second (ideally ms)** and always reflects current state (mute/visibility
  included), distinguishing audio vs video tracks.
- Every action is **undoable in one Ctrl-Z**, never corrupts A/V links, and is rejected safely (clear error) if
  the target is invalid — it never silently does the wrong thing.
- Read is fast enough to call before each AI decision; actions confirm within a normal interaction beat.

**Acceptance:** the AI can call "what's on the timeline?" and get exact positions/mute/visibility, then run
"put asset X at 1:08 on the next free video track and mute track 2," and the user sees it happen with one undo.

---

## Pillar 3 — Generation metadata ("the filename isn't the prompt")

**Feature goals**
- Every generated clip carries a **metadata record** that travels with it: full prompt, model/provider (DP vs
  local vs Seedance/fal/Replicate), characters/references used (ids + tags), aspect/duration/seed, the
  **timeline position it was placed at**, the **transcript range** it was generated for, creation timestamp,
  version number, and accepted/replaced/regenerated state.
- Stored both **in the project** (so it's queryable by Pillar 2) and as a **sidecar `.json`** next to the media
  file (so a clip is self-describing even outside the app). The file keeps the existing readable name
  (`dd_{model}_{slug}_{timestamp}`) — the *full* prompt lives in metadata, not the filename.
- Exposed via `GET /api/generations` (already exists, partial) extended with the new fields, plus a link from a
  timeline clip → its generation record.

**Quality goals**
- Given any clip on the timeline, the AI (or user) can recover **exactly** what made it, where it sits, and who
  is in it — with zero guessing from filenames.
- Metadata survives save/reload and project move (sidecar); versions for the same slot are linked, not orphaned.

**Acceptance:** select any generated clip → see/query its full prompt, model, characters, transcript range, and
timeline position; regenerate into the same slot and the versions are linked under one shot.

---

## Pillar 4 — Audio intelligence (audio → timed transcript)

**Feature goals**
- **Ingest audio** (drop a song) and produce a **word-level timed transcript** used for timing on the timeline.
- **Vocal separation** pre-pass (Demucs) so the beat isn't transcribed.
- **Two modes:** (a) *audio only* → Demucs → WhisperX word timing; (b) *audio + provided lyrics* → Demucs →
  **forced alignment** so the words are the real lyrics and the timing is exact. The app **knows** which mode it
  is in (lyrics-provided = high confidence) and labels the transcript source accordingly.
- **Song structure**: detect verse/chorus/sections (reuse DP's `lyric-analysis`) so generation can be section-aware.
- **Editable transcript**: the user can fix wrong words (transcription will miss some); edits update the word
  list that downstream features (Pillar 5, timeline placement) rely on.
- **Persisted**: the transcript is saved with the project/asset (today it's lost on refresh).

**Quality goals**
- Rap/spoken vocals get **reliable word-level** boundaries; the lyrics-provided path is materially more accurate
  than ASR alone. Low-confidence words are **flagged** for quick manual nudge (overlapping adlibs are known-hard).
- "Don't transcribe the music" is real: instrumental/wordless sections don't produce garbage words.
- Cost stays ~cents/song (Replicate). Long songs (5–8 min) complete without manual chunking by the user.

**Acceptance:** drop a song with no lyrics → a usable timed transcript appears and persists. Drop the same song
**with** pasted lyrics → the words are the exact lyrics, timed to the audio, marked "high confidence," and the
verse/chorus sections are labeled.

**Build note:** the only genuinely new infra is a **custom Replicate Cog** for provided-lyrics forced alignment
(wrapping `whisperx.align()` / `ctc-forced-aligner`). v1 can ship "audio only" on WhisperX first; the
lyrics-aligned mode is a fast-follow once the Cog exists.

---

## Pillar 5 — Character identity + entity extraction + Review Cast

**Feature goals**
- **Character model** gains `reference_tag` (e.g. `@ldavis`) and `aliases[]` (e.g. "Lands", "L-Dav") alongside
  `name`, mirroring DP's `StoryboardCharacter`. (Today the desktop `Character` has only `name`, and `@lands`
  doesn't even match "Lands Davis" — a real bug this fixes.)
- **Entity extraction**: when a transcript/story loads, the app extracts the characters (reuse DP's
  `extractEntities`, which already merges aliases + writes visual descriptions).
- **Review Cast panel** (the chosen UI): a side panel beside the transcript listing each detected character —
  name, mention count, confidence chip, context snippets. One gesture per character: **link to an existing saved
  Character** via autocomplete (matches name/`@tag`/alias) or **create new**; **confirm once → every mention
  re-links**; **Same / Different / Not sure** for look-alikes; aliases act as **find-and-replace** across the
  transcript and **persist back to the character** so the next song auto-resolves more. Inline click-a-mention to
  fix one instance. Status colors green/amber/red (no purple).
- **Resolution into generation**: a confirmed character's `@tag` pulls its reference images into generations
  automatically (alias-aware substitution, reuse DP's `name-replacement.service`).

**Quality goals**
- The common case (small, obvious cast) is a **fast keyboard flick** down the list — no per-mention babysitting.
- "Lands" in the audio reliably resolves to "Lands Davis" → `@ldavis` → the right reference images, after one
  confirmation. Find-and-replace shows a count ("re-linked 7 mentions") with undo.
- Linking to an existing character is the default path; the user is never forced into a wrong commit (Not-sure
  defers). New aliases learned here make future transcripts smarter (compounding).

**Acceptance:** load a song transcript → "We found 3 characters" → confirm + link `@ldavis` once → all
mentions re-link, references attach, and generating that section uses the right character automatically.

---

## Cross-cutting: reuse vs. port

DP's `extractEntities`, `lyric-analysis`, and `name-replacement` are **stateless**. **Recommendation: port the
prompts/logic into the desktop backend** (works offline, no DP-deploy dependency, no extra round-trip), keeping
DP as the gallery/credits master per the ecosystem spec. Calling DP live is the fallback if we want a single
source of truth for the prompts.

## Edge cases & risks

- **Overlapping adlibs / layered vocals** misalign — flag low-confidence words; never hard-fail.
- **Two people, similar names** — Same/Different/Not-sure + a context mini-diff; never silently merge.
- **Forced-alignment Cog** is the one new piece of infra — ship audio-only first, lyrics-aligned as fast-follow.
- **Action API safety** — bounded, reversible, A/V-link-aware; reject invalid targets clearly.
- **Project source-of-truth** stays the editor; the backend mirrors a read-model + applies queued actions
  (avoid a full project-store rewrite).
- **Privacy/cost** — audio + transcript leave the machine for cloud transcription; surface that, and the per-song
  cost, before running (no surprise paid runs).

## Phasing & dependencies

```
Pillar 1 (login)  ──► Pillar 2 (context API: read+act)
Pillar 3 (metadata) underpins 2 and 5
Pillar 4 (audio→transcript) ──► Pillar 5 (extract + Review Cast)
```

Login (#9) unblocks the agent. Pillars 4+5 are the most visible and most de-risked by DP reuse; Pillars 2+3 are
the agent-native foundation. Build order is the user's call (captured per-issue); this spec does not schedule it.

## Open questions (for when build is scheduled)

- Reuse-vs-port final call for DP's brains (recommend port).
- How much the action API confirms vs. just-does for destructive actions (delete/overwrite).
- Whether v1 ships the custom forced-alignment Cog or defers it (audio-only first).
- Where the Review Cast panel lives (transcript view vs a soft "lock the cast" step before generate).
