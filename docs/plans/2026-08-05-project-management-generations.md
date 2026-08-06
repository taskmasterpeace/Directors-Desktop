# Project management for generations — where renders live, and who owns them

*Status: PLAN (approved direction from Robert's 2026-08-05 session: "we need some type
of thing… figure out how we're gonna do project management"). Nothing here is built
except where marked shipped.*

## The map today (verified in code, 2026-08-05)

| Surface | What it shows | Where results go |
|---|---|---|
| **Gallery** (left nav) | EVERYTHING ever generated, newest first | `/api/gallery/local` scans the outputs dir (`%LOCALAPPDATA%\LTXDesktop\outputs` in packaged builds) |
| **Playground** | The one result you just made | Outputs dir only → visible in Gallery, owned by no project |
| **Gen Space** (per project) | The project's asset grid | Outputs dir + `addAsset(currentProjectId, …)` — **but only if Gen Space is still mounted when the render completes** (`GenSpace.tsx` ~1670) |
| **Video Editor** (per project) | The project bin; `Asset.bin?: string` names folders | Whatever was imported or added to the project |

So: yes, there IS "a gallery for the playground" — the global Gallery covers every
render from every surface. The folders under Edit are per-project bins. The March
"test" folder pointed at files in `Downloads\Ltx Desktop Assets` that no longer
exist (now rendered as explicit "Missing file" cards, `bf115b0`).

## The hole

**Generations belong to the queue, not to a project.** Jobs carry a `tags` field
(the Director already uses `['director', run_id]`), but Gen Space and Playground
submit untagged jobs. Consequences:

1. **Complete-while-away orphans the render from its project.** It exists only in
   the Gallery; the project grid never learns about it. (Re-attach, shipped
   `bf115b0`, fixes *watching* a render after navigation — and completion while
   re-attached does file it — but completion while fully away still orphans.)
2. The Gallery can't answer "which project did this come from."
3. Nothing can be re-homed after the fact.

## The plan

### Phase 1 — jobs know their project (small; kills the orphan bug)
- Gen Space submits jobs with `tags: ['project:<projectId>']`; Playground with
  `tags: ['playground']`. (Backend queue already stores/returns tags — no backend
  change.)
- On Gen Space mount: fetch queue, find **completed** jobs tagged for this project
  whose `result_paths` aren't in the project's assets yet → `addAsset` each
  (silent adopt, newest first, capped sanely). The render you left behind is
  sitting in the grid when you come back.

### Phase 2 — the Gallery learns projects (the "compensate for it")
- Filter chips: All · per-project · Playground (driven by job tags matched to
  gallery files by result path).
- Right-click a Gallery item → **"Send to project…"** (adds to that project's
  assets; the file never moves — same re-home mental model as Palette's
  reference workspaces).

### Phase 3 — project home truths
- Project card / Gen Space header: recent renders count, last render time,
  missing-file count with a one-click "clean up dead entries" sweep.

### Phase 4 — folders grow up (later)
- Promote `Asset.bin` folders into first-class Gen Space groups (create/rename/
  drag-to-folder), synced with the editor bin view.

## Test backlog Robert named (2026-08-05)
- 720p tier matrix (same rig as the 480p/10s one — measured table exists).
- Director end-to-end on a real song — still the #1 untested flow.
- One cloud render through Palette points (Seedance + Nano Banana — key now active).
- Fresh-machine installer test (needs the v1.0.1 GitHub release published).
