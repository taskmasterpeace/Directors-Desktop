# Vendored: @openreel/core

- **Source:** https://github.com/Augani/openreel-video
- **Path:** `packages/core` (plus root `LICENSE` and `mediabunny.d.ts`)
- **Commit:** `5711925046478cb77b04a976b755a9b2bcfc7dbe` (2026-06-01, v0.5.x line)
- **License:** MIT (see `LICENSE` in this directory)
- **Vendored:** 2026-07-18

## Why vendored

Directors Desktop is adopting OpenReel's editor engines (action-based undoable
editing, timeline managers, WebCodecs playback/export) as the foundation for a
full-featured editor, per `docs/superpowers/specs/2026-07-18-editor-foundation-design.md`.
The package is source-shipped upstream (`main: ./src/index.ts`, consumed via
bundler), so we vendor the TypeScript source and resolve it through a Vite
alias (`@openreel/core` → `vendor/openreel-core/src`).

## Local modifications

Keep this list exhaustive — it is the diff-against-upstream contract.

- `tsconfig.json` rewritten to be self-contained (upstream extends a monorepo
  base config we did not vendor). Upstream original preserved in
  `package.json.orig` / upstream repo.
- Internal `*.test.ts` files are excluded from `pnpm typecheck:vendor` (they
  need `fast-check`, which we do not install) and are NOT run by DD's vitest
  (its include is pinned). They remain on disk to ease future upstream diffs.
- No source-file edits. If a source edit ever becomes necessary, record it here
  with file + reason.

## Updating

1. `git clone --depth 1 --filter=blob:none --sparse https://github.com/Augani/openreel-video`
2. `git sparse-checkout set packages/core`
3. Replace `src/` here, re-apply the (none, ideally) local modifications above,
   update the commit hash in this file.
4. `pnpm typecheck:vendor && pnpm test:frontend` must pass.

## Known gaps

- `src/wasm/*/build/*.wasm` binaries are not committed upstream; audio
  FFT/beat-detection features require an AssemblyScript build
  (`asc`, see `package.json.orig` scripts) before they can be used.
