# Releasing Director's Desktop (Windows)

What a user downloads from GitHub and double-clicks, and what has to be uploaded
next to it for the app to work.

## What ships

| Asset | Size | Why |
|---|---|---|
| `Director's Desktop-Setup.exe` | ~150–300 MB | The app: Electron shell, frontend, Python **source** backend. NSIS installer — choose install dir, shortcuts, uninstaller. |
| `python-embed-win32.manifest.json` | tiny | Tells the app what parts to fetch. |
| `python-embed-win32.tar.gz.partN` | ~1.8 GB each | The embedded Python runtime (torch + CUDA). Downloaded **on demand**, only when the user first runs a local GPU generation. |

The AI model weights (LTX-2.3 etc., tens of GB) are never in a release — the app
downloads them through Model Status with progress.

**Why Python is not inside the .exe:** `python-embed` is 5.0 GB on disk (4.2 GB
of that is `torch/lib` — NVIDIA's cuBLAS/cuDNN/cuFFT libraries). Bundled, the
installer would exceed GitHub's **2 GB per-asset limit**. Splitting the runtime
into its own parts keeps the installer small and lets cloud-only users skip the
5 GB entirely.

## Build steps

```powershell
# 1. Prepare the Python runtime (only needed when deps change; ~10 min)
pwsh scripts/prepare-python.ps1

# 2. Build the installer  (frontend + electron-builder → release/)
npx pnpm build:win

# 3. Package the runtime into release archives → release/python-dist/
pwsh scripts/package-python.ps1
```

## Publish

Create a GitHub release on **`taskmasterpeace/Directors-Desktop`** tagged
**`v<version>`** exactly matching `package.json` → `version` (currently `1.0.1`).
`electron/python-setup.ts` builds its download URL as:

```
https://github.com/taskmasterpeace/Directors-Desktop/releases/download/v<version>/python-embed-win32.manifest.json
```

Upload to that release:
- `release/Director's Desktop-Setup.exe`
- everything in `release/python-dist/` (the manifest + all parts)

**If the tag or the assets are missing, the installer still installs — but the
first local generation fails when it tries to fetch the runtime.** There is no
fallback CDN by design (`FALLBACK_CDN_BASE = null`): the upstream Lightricks
mirror was removed under the no-LTX-cloud policy.

Bumping `version` in `package.json` means a new tag **and** re-uploading the
python archives to that new tag.

## Code signing

Unset on purpose. The upstream config used Lightricks' Azure certificate, which
is not ours to use, so it was removed. Consequences:

- Unsigned installers trigger a SmartScreen "Windows protected your PC" warning
  (More info → Run anyway). Reputation builds up over downloads.
- To sign with a Machine King Labs certificate, set `CSC_LINK` (path/base64 of
  the .pfx) and `CSC_KEY_PASSWORD` before `build:win`; electron-builder picks
  them up automatically.

## Accounts and gating

The app requires a **Directors Palette account** — `PaletteAuthGate` blocks every
view until `/api/sync/status` reports connected (sign in via browser, email +
password, or a `dp_` API key). A successful check is cached, with a 7-day offline
grace window so a network blip doesn't brick a working session.

That gate is a product requirement and entitlement check, **not DRM** — a patched
desktop build can bypass a client-side check. Anything that spends money is
enforced server-side: cloud generation deducts Palette points before dispatch.
End-user builds ship no provider keys. See `CLAUDE.md` § "Billing & Security".

## Pre-flight checklist

- [ ] `npx pnpm typecheck` and both test suites green
- [ ] `version` bumped in `package.json`
- [ ] Installer built and launched once from `release/win-unpacked` (sign-in gate appears)
- [ ] `scripts/package-python.ps1` run; parts each < 2 GB
- [ ] GitHub release `v<version>` created with the .exe + manifest + all parts
- [ ] Fresh-machine test: install → sign in → run one local generation (proves the runtime download) → run one cloud generation (proves points)
