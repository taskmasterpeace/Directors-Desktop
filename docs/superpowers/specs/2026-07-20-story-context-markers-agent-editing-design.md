# Story Context, Markers, and Agent-Native Editing

**Date:** 2026-07-20
**Status:** Approved (interview completed with Robert; he directed full completion)
**Supersedes/extends:** `2026-06-24-agent-native-timeline-and-character-system-design.md` (Pillar 2 — this spec is its concrete, updated build plan)

## Vision (Robert's words, distilled)

> The story is the source of truth for WHAT was said. Transcription is the truth
> for WHEN it was said. Aligned, the AI can operate with confidence. Markers are
> my notes on the timeline. Everything the editor knows must be natively
> readable and editable — so an AI that knows my characters, my story, and where
> everything sits can actually help me edit.

Descript-style click-to-seek already works per clip. This spec makes the whole
project — timeline, transcript, story, cast, markers — durable, visible, and
editable from outside, with Claude Code as the operating agent.

## Decisions locked in interview (2026-07-20)

| Question | Decision |
|---|---|
| Story material format | **Varies per project** — accept any text; extract structure (speaker labels, scene headings) when found, never require it |
| Markers | **Points + ranges**, title + note + color, **AI reads Robert's and leaves its own** for review. Auto-markers from script structure: explicitly NOT v1 |
| AI operator | **Claude Code drives** through the app's native local API + discovery file. No in-app chat panel |
| AI write powers v1 | **Arrange clips + markers · captions from transcript · generate + place footage.** Cut-by-transcript for the agent: deliberately not selected — fast-follow |
| Live transcript (Robert's write-in) | **The transcript is a live view of the timeline** — edits (trim/split/move/speed) re-map it instantly; never a stale doc |
| Generation from the editor | **No new editor gen UI.** Right-click → Gen Space opens pre-armed (frame/character/style attached). The Cast panel supplies who/what |
| Undo guarantee | Every agent action applies through the editor's existing undo stack — **one Ctrl+Z reverts anything the AI did** |

## Architecture — read-model + action queue (Approach A)

The June audit proved two hard facts: (1) the editor's in-memory React state is
the real source of truth and clobbers any external write on its autosave timer;
(2) the backend has zero project/timeline routes and lives on an ephemeral
port + token an outside process cannot discover. Therefore:

```
┌─────────── Electron renderer (source of truth) ───────────┐
│ VideoEditor state ──autosave──▶ ProjectContext ──────────┐│
│        ▲                                                 ││
│        │ apply via undo stack                            ││
│  Action applier ◀──poll /api/project/actions/pending──┐  ││
└────────┼──────────────────────────────────────────────┼──┼┘
         │                 ┌──── publish read-model ────▼──▼───┐
         │                 │  FastAPI backend (mirror, queue)  │
         │                 │  GET  /api/project/current        │
         │                 │  GET  /api/project/transcript     │
         │                 │  GET  /api/project/story          │
         │                 │  POST /api/project/actions        │
         │                 └────────────▲──────────────────────┘
         │                              │ Bearer token from discovery file
         │                  %LOCALAPPDATA%/LTXDesktop/agent-bridge.json
         │                              │
         └──────────────────── Claude Code (the agent)
```

- **Editor publishes** a full read-model snapshot to the backend on every
  debounced autosave (it already debounces; publishing rides the same tick).
- **Backend mirrors** the latest snapshot in memory (+ last-good on disk) and
  serves it read-only. It never mutates the project itself.
- **Agent submits bounded actions**; they land in a queue. The renderer polls
  (1s while the editor is open), validates each action against current state,
  applies it **through `useUndoRedo`**, and reports per-action status
  (`applied` / `rejected(reason)`) back to the backend.
- **Discovery file** `agent-bridge.json` (written by Electron main on backend
  spawn, deleted on exit): `{ "url": "http://127.0.0.1:<port>", "token": "…",
  "pid": …, "startedAt": … }`. File permissions: user-only. This is the ONE new
  reachability surface; the existing Bearer middleware already accepts the token.

## Data model (frontend/types/project.ts)

```ts
// NEW — persisted transcript, keyed to the ASSET so every clip cut from the
// same media reuses it (word times are source-media seconds already).
interface Asset {
  …existing…
  transcript?: TranscriptData
}
interface TranscriptData {
  words: TranscriptWord[]        // { text, start, end } — existing shape
  source: 'stt' | 'aligned'      // aligned = script-of-truth applied
  scriptText?: string            // the user's script, verbatim, when aligned
  coverage?: number              // alignment coverage 0..1
  language?: string
  createdAt: number
}

// NEW — markers live on the Timeline.
interface TimelineMarker {
  id: string
  time: number                   // timeline seconds (start, for ranges)
  duration?: number              // undefined → point; > 0 → range
  title: string
  note?: string
  color: MarkerColor             // 'amber' | 'red' | 'green' | 'blue' | 'zinc'
  author: 'user' | 'agent'       // agent markers render distinctly (dashed ring)
  createdAt: number
}
interface Timeline { …existing…; markers?: TimelineMarker[] }

// NEW — story context lives on the Project.
interface StoryDoc {
  id: string
  title: string
  text: string                   // any format; structure extraction is best-effort
  kind: 'script' | 'lyrics' | 'notes' | 'other'
  updatedAt: number
}
interface CastEntry {
  storyName: string              // name as it appears in the story/script
  characterId?: string           // link into the Characters library (likeness)
}
interface Project { …existing…; storyDocs?: StoryDoc[]; cast?: CastEntry[] }
```

Persistence: all of the above ride the existing `ProjectContext` localStorage
save (and therefore the read-model). No migration needed — every field is
optional and absent on old projects.

## The bounded action set (v1)

`POST /api/project/actions` accepts `{ actions: AgentAction[] }`; each action:

```ts
type AgentAction =
  | { kind: 'move_clip';   clipId: string; trackIndex: number; startTime: number }
  | { kind: 'trim_clip';   clipId: string; trimStart?: number; trimEnd?: number }
  | { kind: 'delete_clip'; clipId: string }
  | { kind: 'add_marker';  marker: Omit<TimelineMarker,'id'|'createdAt'|'author'> }
  | { kind: 'update_marker'; markerId: string; patch: Partial<TimelineMarker> }
  | { kind: 'delete_marker'; markerId: string }
  | { kind: 'captions_from_transcript'; clipId?: string; maxCharsPerCue?: number }
  | { kind: 'generate_and_place'; prompt: string; model?: string;
      referenceImagePaths?: string[]; at: { trackIndex: number; startTime: number } }
```

Rules:
- Renderer validates against live state (unknown clipId → `rejected`).
- Every apply goes through `pushUndo` first. Batched actions = one undo step.
- `generate_and_place` submits through the existing queue (job carries its own
  model, per current architecture); on completion the applier drops the result
  at `at` and marks the action `applied`. Agent markers annotate what was done.
- Agent actions NEVER delete assets from the bin (only timeline clips) in v1.

## Live transcript (Robert's requirement)

Word times are stored in **source-media seconds** (already true). The timeline
view maps through each clip's `trimStart/speed/startTime` at render time — the
existing `sourceTimeToTimelineTime` — so every edit is instantly reflected.
What's new: a **project-level transcript endpoint** that walks the timeline's
clips in order and emits the stitched, currently-live transcript with timeline
timestamps — this is what the agent reads to "know the cut," and it is
recomputed per read-model publish (cheap: pure mapping).

## Captions bridge (transcript → subtitles)

`captions_from_transcript` (also a user-facing button in the Transcript panel):
group aligned words into cues (max ~42 chars/line, break on punctuation +
silence gaps ≥ 0.4s), emit `SubtitleClip[]` into `timeline.subtitles` — which
already persists, styles, exports to SRT, and burns in. Agent and human hit the
same function.

## Story docs + cast UI (minimal, v1)

- Project Settings modal gains a **Story** tab: paste/import text docs (kind
  picker), and a **Cast** table: story name ↔ Characters-library entry
  (dropdown). Best-effort speaker extraction (`NAME:` line scan) pre-fills
  cast rows for formatted scripts; plain prose just stores the doc.
- The read-model exposes both verbatim. The agent does its own deeper parsing —
  that's the point of Claude Code driving.

## Out of scope (v1)

Auto-markers from script structure · agent cut-by-transcript (fast-follow) ·
in-app AI chat · MCP wrapper (thin later layer) · file-format project export
(FCPXML fixes tracked separately) · Dramatis-style voice generation (separate
initiative; its "who-said-what" parsing may inform the cast pre-fill later).

## Build phases (each keeps the suite green; each independently shippable)

1. **Persist transcripts** — `Asset.transcript`, save on transcribe/align/edit,
   hydrate `transcriptCache` from the project, "re-transcribe" becomes free.
2. **Markers** — model + ruler UI (click = point, drag = range, right-click
   edit; M key), persisted in the timeline. Data + display only in v1 — markers
   do not affect export output.
3. **Story + Cast** — Project Settings tabs + types + speaker pre-fill scan.
4. **Captions bridge** — the grouping function + panel button + tests.
5. **Read-model + discovery** — publisher in ProjectContext autosave, backend
   mirror routes, `agent-bridge.json` in Electron main, `CLAUDE.md` § for agents.
6. **Action queue** — backend queue routes + renderer applier through undo,
   per-action status, agent markers.
7. **Generate + place** — `generate_and_place` through the job queue + editor
   right-click "Generate with cast member…" pre-armed Gen Space handoff.

Testing: phases 1–4 get vitest unit coverage (grouping, mapping, extraction);
phases 5–6 get backend pytest (routes, queue, auth) + a scripted end-to-end
where a fake agent reads the model and round-trips an action.
