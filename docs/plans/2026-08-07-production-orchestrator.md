# The Production Orchestrator — DD's own AI reviews the production and sends it back

**Robert, 2026-08-06 (after the first real edit session):** "Put together an
orchestration layer that kinda sends it back and has it go more than once…
this can't be you, this has to be the AI that is a part of Director's Desktop
doing this."

The pipeline can now move a whole production into DD with provenance and
surgical regen. What it cannot do yet is NOTICE what's wrong. Robert's ear
found in one session what no gate caught: SFX buried, ambience missing where
scenes felt dry, all of ch-03's cues crammed into the last third, zero music
cues in the whole book. The orchestrator is the layer that finds those things
itself, requests fixes from the app that owns them, and goes around again.

## Division of responsibility (unchanged — DD-06 still rules)

- The orchestrator LIVES in DD's backend and uses DD's own LLM access (the
  enhance-prompt service path). It never renders audio itself.
- Every fix is a REQUEST to Dramatis over the Studio HTTP surface it already
  exposes: hints (`POST /api/books/:id/hints`), cue approval
  (`/cues/:cueId`), takes (`/api/takes/render|select`), chapter re-produce
  (`POST /api/render`). Dramatis stays the only thing that generates.
- The terminal agent (Claude) is a CONSUMER of this feature at most — the
  orchestrator must run from a button in the GUI with no terminal anywhere.

## The loop (one "pass" = review → plan → execute → verify)

```
importable chapter (dd-elements v2)
   │
   ▼
REVIEW  — deterministic audits first, LLM judgment second
   │        A. coverage: cues per scene vs scene length (ch-03: 7 cues, all
   │           63–96% — flagged), beds per scene ambience intent, music cues
   │           present at all (this book: zero), silent stretches > Ns
   │        B. levels: per-clip effective dB vs the dialogue anchor; flags
   │           anything the NON_DIALOG_LIFT_DB calibration still leaves buried
   │        C. media: missing files, stale chapters, un-levelled takes
   │        D. LLM pass (production script + scene visuals + existing cues in,
   │           JSON out): propose NEW cues with text anchors + spec, music
   │           placements with mood, performance flags ("this line's emotion
   │           hint says fear but it reads flat — candidate for a directed take")
   ▼
PLAN    — one JSON plan: [{kind: add_cue|add_music|retake_line|re_produce|
   │        adjust_volume, target, why, request}] — every item carries its WHY
   │        so the user can judge it
   ▼
GATE    — the plan renders in the Story Stage as a checklist; user approves
   │        items (or "auto" mode approves audits, LLM items still gated)
   ▼
EXECUTE — approved items become Studio calls (hints/cues/takes) followed by
   │        ONE `POST /api/render` re-produce when anything upstream changed;
   │        volume-only fixes apply directly to the DD timeline
   ▼
VERIFY  — re-read the fresh dd-elements, re-run REVIEW; if new findings and
            passes < max (default 3), go again. Report every pass's findings
            and what changed — the trail is the product.
```

## Backend shape (house pattern)

- `_routes/orchestrator.py` (thin) → `handlers/orchestrator_handler.py` →
  `services/production_review/` (Protocol + real + Fake for tests)
- `POST /api/orchestrator/review {book, chapter}` → findings JSON (pure, fast)
- `POST /api/orchestrator/run {book, chapter, approved: [ids], maxPasses}` →
  run state machine (queue-worker style thread, poll via
  `GET /api/orchestrator/status?runId=`), each pass logged
- LLM calls through the same service the enhance-prompt path uses; the review
  prompt gets the production script + manifest summaries, NEVER raw audio
- Deterministic audits are pure functions in `server_utils/production_audit.py`
  — testable without LLM or Studio

## Frontend

- Story Stage: "Review production" button per chapter → findings checklist
  (severity chips, WHY lines, approve boxes) → "Run fixes (N approved)" →
  live pass log (SSE or poll) → "Re-place on timeline" when the chapter
  re-produced (v2: in-place re-sync of the open project)
- The same findings surface in the editor via a panel later (v2)

## Honest limits (named now)

- New-cue suggestions go through dramatis's own anchor/approval machinery —
  the orchestrator proposes; the cue engine still retrieves + gates.
- LLM music/cue taste is a draft, not a mix decision — the gate exists so the
  ear stays the final check (dramatis law 1).
- Re-produce cost: qwen3 lines are cached; only NEW/changed lines render.
- Max 3 passes by default — a loop that cannot converge must stop and say so.

## Also in this workstream (QOL from the same session)

- Transcript surface: thread dramatis word alignments (align sidecars already
  exist per line) into `asset.transcript` so the editor's transcript tools
  light up on dialogue; make the read-along view discoverable from Story Stage.
- Investigate the log-panel error Robert saw (paper icon, top right).

## Phases

1. Deterministic audits + `POST /api/orchestrator/review` + Story Stage
   findings panel (no LLM, no writes — pure visibility). Tests: pytest on the
   audit functions with the real monkeys-paw manifests as fixtures.
2. Execute path for the SAFE fixes: volume adjustments (DD-side) + directed
   takes (existing takes API) with the approval gate + pass log.
3. LLM review pass (cue/music/performance proposals) + hints/cues writes +
   re-produce + the full multi-pass loop.
4. In-place re-sync of an open project after re-produce (today: re-place).
