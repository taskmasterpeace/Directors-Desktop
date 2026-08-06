# The Production Pipeline — manifest, surgical regeneration, retained takes

**Goal (Robert, 2026-08-06):** Dramatis (and the MV pipelines) must not export a
flattened deliverable — they export an **editable production package** that
Directors Desktop understands. DD is where generated work receives its final
human-directed polish. Every asset knows what it is; any element can be
regenerated surgically without touching the rest; regeneration never destroys
the previous take. Music videos get the same treatment ("so we can make new
takes"). Division of responsibility (DD-06): Dramatis owns story, voices,
performance, regeneration; DD owns timeline, editing, take selection, final
export. **DD requests generation — it does not duplicate generators.**

Builds directly on `2026-08-06-dramatis-story-stage.md` (shipped this morning:
dd-elements emitter + Story Stage import). This plan is the second half:
provenance, the regen round trip, takes, and MV parity.

## What the recon established (both repos, file:line verified)

**Dramatis** (`D:\git\dramatis`):
- Uniform per-line render contract already exists: `renderLines([line], voices,
  cacheRoot) -> {lineId: absWavPath}` — used by auditions, `/api/say`, casting.
- Cache keys are computed INSIDE each engine (`contentKey(...)`,
  `src/util.mjs:22`) and discarded; `renderLines` returns only paths. The
  manifest needs them threaded out.
- Emotion is an 8-key vocabulary; there is NO free-text director-note path.
  Notes enter the key naturally for qwen3 (instruct), gemini (prompt),
  elevenlabs v3 (text tag). Kokoro ignores direction entirely.
- `levelLine` (mix.mjs) is module-private; a drop-in timeline take needs the
  `-lvl48k.wav` sibling, so it must be exported.
- `line.id` (`lin_0000`) is positional — takes must pair it with `configHash`.
- Filesystem-is-the-database: derived artifacts in `out/<book>/ch-NN/`,
  decisions in `book.json` (via `chapterConfigHash.relevant` for staleness),
  immutable audio in `out/cache/`.
- `scenes[].visual` is always null in dd-elements — compile drops the field
  (real bug; book.json scenes carry visuals for the motion phase).

**Directors Desktop**:
- Takes are an ASSET concept and fully built: `AssetTake`, `addTakeToAsset`
  (appends + bumps `activeTakeIndex`), per-clip `takeIndex` pin, N/M stepper on
  clip + context menu + LeftPanel drill-in. Replace Person is the canonical
  "job completes -> addTakeToAsset -> clip.takeIndex" pattern
  (VideoEditor.tsx:1939-1974).
- Dramatis/MV imported clips are `assetId: null` (`baseClip`) — no asset, no
  takes UI, no AI context-menu section. Provenance survives only in clip id
  strings; bookId/chapter/entity are dropped at the loader.
- No `origin`/metadata field exists on Asset or TimelineClip.
- Story Stage talks to Studio :4600 straight from the renderer (liveness pill);
  no process management, none needed for v1 (offline -> honest pill + toast).
- Director runs retain everything needed to re-render a shot (prompt, model,
  resolution, keyframe, refs — no seed) but `reroll` overwrites result_path;
  Palette-MV beats keep their metadata only in a loader side-return that is
  currently discarded.

## Design

### 1. Manifest v2 (dramatis emits, DD consumes)

`dd-elements.json` version 1 -> **2**, strictly additive:

```
{ version: 2, sourceApp: "dramatis", generatedAt, book, bookTitle, chapter,
  configHash,                       // from production-script — staleness anchor
  durationSec, stemGains,
  entities[{id,kind,names,visual}],
  scenes[{id,start,end,visual,ambience}],        // visual FIXED (threaded from book)
  lines[{ id, entity, kind, sceneId, start, dur, text, cite, emotion?,
          wav,                                    // levelled, absolute (unchanged)
          gen: { engine, voiceKey, key, rawWav, note?, take? } }],
  cues[...unchanged], beds[...], music[...] }
```

`gen` is collected AT RENDER TIME (single authority): `renderLines` gains an
optional collector argument `meta` (`meta[line.id] = {engine, voiceKey, key}`)
filled by each engine beside its existing key computation. Additive — existing
callers pass nothing and see no change. Hybrid threads it through. `produce`
passes one collector down and hands it to `mix()`, which joins it into lines.
Cache hits still fill it (the key is computed before the cache check).

### 2. Takes (dramatis: `src/takes.mjs` + studio endpoints)

- **Note threading**: new optional `line.note` (free text). qwen3: appended to
  `instruct()`; gemini: appended to the voice prompt; elevenlabs: emotion tags
  only (notes NOT supported v1); kokoro: cannot perform — a noted line ROUTES
  to the best available directed engine (qwen3 -> gemini fallback). The note
  reaches the cache key wherever it changes audio (law 5). Re-roll without a
  note: optional `line.take` N appended to the key ONLY when > 1 (kokoro-lang
  conditional precedent, so the existing 446-file cache stays valid).
- **Store**: `out/<book>/ch-NN/takes.json` (derived, atomic writes):
  `{ configHash, lines: { <lineId>: [ {take, key, engine, voiceKey, note,
  wav, lvlWav, dur, renderedAt} ] } }`. Audio lives in `out/cache/` as always.
- **Selection is a decision** -> `book.json` `takes[lineId] = {note, take,
  engine}` and included in `chapterConfigHash.relevant`, so compile threads the
  selection into the line and the next produce/mix re-renders with it
  (cache-hit) and staleness chips tell the truth.
- **Endpoints on the Studio server** (:4600 — the process DD already probes;
  handlers live in `studio/takes-api.mjs` so the hub can mount them later):
  - `POST /api/takes/render {book, chapter, line, note?, engine?}` -> renders
    ONE line (render + exported `levelLine`), appends to takes.json, returns
    the record. 409 when configHash mismatches (manuscript moved under us).
  - `GET  /api/takes/{book}/{chapter}` -> takes.json
  - `POST /api/takes/select {book, chapter, line, key}` -> book.json decision.

### 3. DD: assets with provenance (the clip knows what it is)

- `Asset.origin?: AssetOrigin` — one structured optional field:
  `{ app: 'dramatis'|'palette-mv'|'director', bookId?, chapter?, lineId?,
     entity?, text?, engine?, voiceKey?, cacheKey?, configHash?,
     runId?, shotIndex?, beatId?, prompt?, model? }`
  (also `AssetTake.note?: string` so the stepper can tooltip the direction).
- `dramatis-loader` creates a REAL Asset per dialogue line / cue / bed / music
  clip (type 'audio', prompt = line text, origin filled from manifest v2);
  `importDramatisChapter` persists `assets` on the new project. The whole
  existing takes UI then works unmodified. Inspector: importedName stays; the
  clip context menu gains provenance lines from origin (book/chapter/entity/
  engine) — DD never sees `audio_48392.wav` again.
- Loader tolerates manifest v1 (no gen blocks) — origin gets what exists.

### 4. DD: the regen round trip (recast pattern, renderer-direct)

Context menu on a dramatis audio clip -> **"New take (Dramatis)…"** -> small
modal (note text, optional engine) -> renderer fetches
`POST http://127.0.0.1:4600/api/takes/render` (same-origin pattern as Story
Stage; Studio offline -> toast pointing at the Story Stage pill). While
pending: `clip.isRegenerating`. On response: `addTakeToAsset(projectId,
assetId, {url: pathToFileUrl(lvlWav), path: lvlWav, note})` + pin
`clip.takeIndex` to the new take (Replace-Person pattern). Old take retained,
stepper appears, selection switchable. Optionally POST select back when the
user flips the active take (v1: fire-and-forget on take switch of a dramatis
asset).

### 5. MV parity (new takes for shots)

- `director-import.ts` and `story-loader.ts` create real Assets per video shot
  clip (origin: director run/shot or palette-mv beat, prompt/model carried).
- **"New take (re-render shot)…"** on those clips -> submits a normal DD queue
  video job from the stored params (prompt [+ optional note appended], model,
  resolution, duration, keyframe/still as image conditioning) -> completion
  lands via the recast polling pattern as a new take on the asset. Old render
  untouched. Local models free; cloud models show the usual points estimate.
- Palette-side server regen (Palette v2 video endpoint) is DEFERRED and named:
  DD generates MV takes with its own queue for now — same division as Director.

### 6. Edge cases (explicit, not luck)

- Studio offline -> pill + toast, menu item disabled with reason.
- configHash drift (manuscript/book edited since import) -> 409 from takes
  API -> toast "chapter changed — re-render + re-import", no silent wrong-line.
- Kokoro line + note -> routed engine recorded in the take record + shown.
- Take render fails (engine error) -> no takes.json append, error toast, clip
  unflagged. Levelling failure -> raw wav take with `lvlWav: null` + warning.
- Same note twice -> same cache key -> instant cache-hit take (dedupe by key:
  takes.json refuses duplicate keys, returns the existing record).
- Deleting takes in DD never touches dramatis files (cache is content-addressed
  and shared) — DD deletes its AssetTake entry only.
- Imported project outlives dramatis cache prune -> take swap fails media check
  -> flagged clip (existing missing-media pattern).
- MV shot with no keyframe (pure t2v) -> job without image conditioning.
- Alt-track Director imports (old "keep old" answer) still work; takes are the
  new default, alt tracks remain for whole-pass comparisons.

## Phases (each lands green + committed before the next)

1. **Dramatis manifest v2** — meta collector through engines/hybrid/produce,
   scenes.visual fix, emitter v2, node:test on emitter + collector.
2. **Dramatis takes** — takes.mjs, note threading (qwen3/gemini + routing),
   conditional take-nonce in keys, levelLine export, studio endpoints,
   takes.json + select decision, tests (kokoro/cache fast) + smoke entry.
3. **DD provenance assets** — types (origin, AssetTake.note), loader assets +
   origin, importDramatisChapter persists assets, vitest incl. v1 tolerance.
4. **DD round trip** — context-menu item + modal + fetch + addTake + pin,
   isRegenerating, offline handling; pytest untouched (renderer-direct), vitest
   for the pure bits; live e2e on monkeys-paw.
5. **MV parity** — assets+origin in director-import/story-loader, "New take"
   queue submission + landing, vitest; live check on a Director run.
6. **Proof + critic** — end-to-end demo (regen a line "with more anger", hear
   it, old take intact; MV shot new take), fresh-context critic review, fix
   findings, gates both repos, HANDOFF/memory updates.

## Verification bar

Dramatis: `npm test` green (new emitter/takes/note tests included),
`studio/smoke.mjs` green with a takes round-trip check. DD: `pnpm typecheck`
x2, vitest, backend pytest + pyright 0, Vite build. End-to-end: monkeys-paw
ch-01 regen round trip verified IN THE APP; a Director-run shot take verified
in the app. No purple anywhere. Costs shown honestly (local = free).
