# AI as Assistant Editor — the MCP server + the round-trip editing tools

**Robert, 2026-08-07 (voice):** "Have any AI, using an MCP server, be able to
edit the project you have open. It should generate more sound effects, look at
the timeline, regenerate a character's lines. Descript-style transcript — click
anywhere and the playhead goes there. Build the features we didn't ask for but
totally need to have AI be our assistant editor."

This is the capstone of the pipeline. The plumbing already exists — the agent
bridge (read model + TOC + bounded action queue), the takes API, SFX cue
generation in Dramatis. What's missing is (1) a DOOR any MCP-speaking AI can
walk through, and (2) three editor capabilities that door needs to be useful.

## What already exists (build ON, don't rebuild)

- **Agent bridge** `/api/project/*` — `current` (full read model), **`toc`**
  (the AI-visible timeline: chapters, cast, transitions, per-chapter drill-down
  in ~300 tokens), and the **action queue** (`actions`, `actions/status`) the
  renderer applies through the user's undo stack. Actions today: move_clip,
  trim_clip, delete_clip, add/update/delete_marker, captions_from_transcript,
  generate_and_place (image/video).
- **Takes API** (Dramatis studio :4600) — regenerate ONE line with a director
  note, retained as a new take. DD already round-trips this from the clip menu.
- **Discovery** — `%LOCALAPPDATA%\LTXDesktop\agent-bridge.json` = `{url, token,
  pid, startedAt}`, written while the backend lives.

## The MCP server (Piece 1 — this door)

`mcp/dd-mcp-server.mjs` — a **zero-dependency** Node stdio JSON-RPC 2.0 server
(house ethos: dramatis' whole studio is zero-dep; MCP-over-stdio is a small
protocol subset — initialize / tools/list / tools/call — not worth an SDK that
could hang a headless install). Any MCP client (Claude Desktop, Cursor, Claude
Code) points at `node mcp/dd-mcp-server.mjs` and gets:

- Discovers the bridge from `agent-bridge.json`, attaches the Bearer token,
  verifies `pid` is alive (stale file → a clear "open Directors Desktop" error).
- **Read tools** (wrap existing endpoints):
  - `get_timeline` → the TOC text (the whole map, cheap)
  - `get_chapter{n}` → time-coded per-line detail for one chapter
  - `get_project_json` → the full read model (escape hatch for deep dives)
- **Edit tools**:
  - `edit_timeline{actions[]}` → POST actions, poll status, return per-action
    applied/rejected(reason) so the AI SEES the result of its edit
  - `regenerate_line{clipId, note}` → new take on a dramatis line (Piece 2)
  - `generate_sfx{prompt, at, seconds?}` → retrieve+place a sound effect
    (Piece 3)
- Every tool's description teaches the timeline grammar and the stable-id
  contract, so a cold AI is productive on the first call. The server is
  self-describing the same way the TOC text is.

MCP is the interface, not the brain: the server holds NO editing logic — it
forwards to the bridge, which is the one authority (undo stack, validation).

## Piece 2 — regenerate a character's line (new bridge action)

New action kind `regenerate_line{clipId, note?}`. The renderer applier already
has the dramatis round-trip (`dramatis-studio.ts` + the New Take flow) — this
action routes a clip whose asset origin is a dramatis line through
`requestDramatisTake` and lands the result as a take, exactly like the menu
does, but agent-initiated. Rejected cleanly for non-dramatis clips (points the
AI at generate_and_place instead). Reports late (render takes ~30-60s), like
generate_and_place.

## Piece 3 — generate more sound effects (new bridge action)

New action kind `generate_sfx{prompt, at:{trackIndex,startTime}, seconds?}`.
Routes to Dramatis' CLAP-retrieval SFX engine (a new studio endpoint
`POST /api/sfx/retrieve {query, seconds}` over the existing
`engines/sfx/retrieve.mjs`), lands the clip on the SFX track at true gain.
This is the "generate more sound effects" ask — the AI can hear a scene is dry
(the TOC/orchestrator flags it) and place a cue. Deferred detail: if retrieval
is below threshold, the action reports "no confident match" rather than placing
noise (dramatis law: don't guess).

## Piece 4 — Descript-style transcript navigation (frontend)

"Click anywhere on the transcript and the playhead goes there." The transcript
system exists (`asset.transcript`, word timestamps, captions_from_transcript).
Build a transcript PANEL: the stitched dialogue of the cut as clickable words,
each carrying its timeline-seconds; click → seek the playhead; the current word
highlights as it plays (karaoke follow). This is the editing surface that makes
the whole production reviewable as a SCRIPT — and it is what an AI's "seek to
line 40" maps onto. Threading: dramatis word-alignment sidecars already exist
per line; surface them into `asset.transcript` on import so the panel lights up.

## Features we need but weren't asked for (Robert invited these)

- **Undo visibility for agent edits** — every agent action already lands as one
  undo step; surface a subtle "AI edited: <summary>" toast + an activity log so
  the human always knows what the assistant did and can Ctrl+Z it.
- **Dry-run / propose mode** — `edit_timeline{dryRun:true}` validates and
  returns what WOULD happen without mutating, so an AI (or the orchestrator)
  can plan a batch and show it before committing.
- **Selection context** — expose the user's current selection + playhead in the
  read model, so "tighten THIS" and "regenerate the line I'm on" work.
- **Safe-by-default** — destructive actions (delete_clip) in an agent batch
  get surfaced in the toast with a one-click undo; nothing bypasses the undo
  stack (already true) — make it visible.

## Research anchors (the "based on research" ask)

- MCP spec (stdio JSON-RPC, initialize/tools) — the interface contract.
- Descript's transcript-first editing — words ARE the timeline; the model to
  match for click-to-seek + karaoke follow.
- OpenTimelineIO naming for interchange (already informing the TOC).
- The TOC's index-then-drill pattern (llms.txt convention) — the read side an
  MCP AI uses so a 300-clip production costs ~300 tokens to survey.

## Phases (each green + committed)

1. **MCP server** with the three read tools + edit_timeline (wraps existing
   endpoints only). Zero-dep, smoke-tested by piping JSON-RPC, then verified
   live against the running backend. ← start here.
2. **regenerate_line** action (renderer applier + MCP tool) + test.
3. **generate_sfx** action + Dramatis SFX endpoint + test.
4. **Transcript panel** (Descript-style click-to-seek + karaoke) + alignment
   threading.
5. **The "needed" features**: agent-edit toast/log, dry-run, selection context.

## Verification bar

Zero-dep MCP server: a `mcp/smoke.mjs` that spawns it, does the initialize
handshake, lists tools, and calls get_timeline against a fake bridge — plus a
live check against Robert's running app. Bridge actions: pytest on the queue +
vitest on the applier. tsc ×2, vitest, pytest, pyright 0. No purple.
