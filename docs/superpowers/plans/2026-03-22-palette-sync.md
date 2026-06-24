# Palette Sync Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync LoRAs, wildcards, and prompts from Directors Palette v2 into Directors Desktop so users have their full creative library available for local GPU generation.

**Architecture:** Backend PaletteSyncService calls Palette's `/api/v2/*` REST endpoints using the user's API key (already stored in `app_settings.palette_api_key`). Synced data is stored locally: LoRAs as `.safetensors` files in the loras directory (integrated with existing `LoraLibraryStore`), wildcards and prompts as JSON files (integrated with existing library stores). Frontend triggers sync via new `/api/palette-sync/*` routes and displays synced items in existing library views.

**Tech Stack:** Python FastAPI (backend), React TypeScript (frontend), Palette v2 REST API, existing `HTTPClient` service

---

## Scope

This plan covers three sync domains, ordered by value:

1. **LoRA Sync** — Fetch Palette LoRA catalog, download `.safetensors` to local library
2. **Wildcard Sync** — Fetch Palette wildcards, merge into local wildcard store
3. **Prompt Sync** — Fetch Palette prompts, merge into local prompt library

References/Characters are deferred — they require downloading gallery images and a more complex merge strategy. Can be added later using the same sync infrastructure.

## File Structure

### New Files

| File | Responsibility |
|---|---|
| `backend/services/palette_sync/palette_sync_service.py` | Protocol: sync interface |
| `backend/services/palette_sync/palette_sync_service_impl.py` | Implementation: calls Palette v2 API via HTTPClient |
| `backend/handlers/palette_sync_handler.py` | Orchestrates sync: calls service, writes to local stores |
| `backend/_routes/palette_sync.py` | Thin routes: `/api/palette-sync/status`, `/api/palette-sync/sync` |
| `backend/tests/test_palette_sync.py` | Integration tests with fake service |
| `backend/tests/fakes/fake_palette_sync.py` | Fake service returning canned data |

### Modified Files

| File | Change |
|---|---|
| `backend/app_handler.py` | Wire PaletteSyncHandler into composition root |
| `backend/app_factory.py` | Register palette_sync router |
| `backend/tests/conftest.py` | Add fake palette sync service to test AppHandler |
| `frontend/components/SettingsModal.tsx` | Add "Sync from Palette" button |

---

## Palette v2 API Reference

**Base URL:** `https://directors-palette.app`
**Auth Header:** `Authorization: Bearer dp_xxxxx`
**Response Envelope:** `{ "success": true, "data": { ... } }` or `{ "success": false, "error": { "code": "...", "message": "..." } }`
**Rate Limit:** 60 requests/minute

### GET /api/v2/loras
```json
{
  "success": true,
  "data": {
    "loras": [
      {
        "id": "dcau-k9b",
        "name": "DCAU",
        "type": "style",
        "trigger_word": "DC animation style,with bold outlines,cel-shaded, muted color palette.",
        "compatible_models": ["flux-2-klein-9b"],
        "thumbnail_url": "https://...",
        "is_community": true
      }
    ]
  }
}
```

Note: This endpoint returns metadata only. LoRA weights URLs are NOT included in the v2 list response. The built-in FLUX Klein LoRAs have hardcoded weights URLs in the Palette frontend (`lora.store.ts`). For MVP, we hardcode the same known weights URLs. For user-uploaded LoRAs, we'll need a separate download endpoint (future work).

### GET /api/v2/wildcards?limit=100&offset=0
```json
{
  "success": true,
  "data": {
    "wildcards": [
      {
        "id": "uuid",
        "name": "hairstyles",
        "category": "appearance",
        "description": "Various hairstyle options",
        "line_count": 42
      }
    ],
    "total": 100,
    "limit": 50,
    "offset": 0
  }
}
```

Note: The list endpoint returns metadata only (no content/values). To get the actual wildcard values for expansion, use `/api/v2/wildcards/expand`.

### POST /api/v2/wildcards/expand
```json
// Request
{ "prompt": "A hero in _location_ with _style_", "count": 3 }

// Response
{
  "success": true,
  "data": {
    "expansions": [
      { "text": "A hero in forest with cinematic", "wildcards_used": { "location": "forest", "style": "cinematic" } }
    ]
  }
}
```

---

## Task 1: Palette Sync Service (Protocol + Fake)

**Files:**
- Create: `backend/services/palette_sync/palette_sync_service.py`
- Create: `backend/tests/fakes/fake_palette_sync.py`

- [ ] **Step 1: Write the Protocol**

```python
# backend/services/palette_sync/palette_sync_service.py
"""Protocol for fetching library data from Directors Palette v2."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True, slots=True)
class PaletteLoraInfo:
    id: str
    name: str
    lora_type: str  # "style" or "character"
    trigger_word: str
    weights_url: str
    thumbnail_url: str
    lora_scale: float
    compatible_models: list[str]


@dataclass(frozen=True, slots=True)
class PaletteWildcard:
    id: str
    name: str
    category: str
    description: str
    line_count: int


@dataclass(frozen=True, slots=True)
class PaletteWildcardExpansion:
    text: str
    wildcards_used: dict[str, str]


class PaletteSyncService(Protocol):
    def list_loras(self, api_key: str) -> list[PaletteLoraInfo]: ...
    def list_wildcards(self, api_key: str) -> list[PaletteWildcard]: ...
    def expand_wildcards(self, api_key: str, prompt: str, count: int) -> list[PaletteWildcardExpansion]: ...
```

- [ ] **Step 2: Write the Fake**

```python
# backend/tests/fakes/fake_palette_sync.py
"""Fake PaletteSyncService for testing."""

from __future__ import annotations

from services.palette_sync.palette_sync_service import (
    PaletteLoraInfo,
    PaletteSyncService,
    PaletteWildcard,
    PaletteWildcardExpansion,
)


class FakePaletteSyncService:
    """In-memory fake that implements PaletteSyncService protocol."""

    def __init__(self) -> None:
        self.loras: list[PaletteLoraInfo] = []
        self.wildcards: list[PaletteWildcard] = []
        self._expansions: list[PaletteWildcardExpansion] = []
        self.last_api_key: str = ""

    def list_loras(self, api_key: str) -> list[PaletteLoraInfo]:
        self.last_api_key = api_key
        return list(self.loras)

    def list_wildcards(self, api_key: str) -> list[PaletteWildcard]:
        self.last_api_key = api_key
        return list(self.wildcards)

    def expand_wildcards(self, api_key: str, prompt: str, count: int) -> list[PaletteWildcardExpansion]:
        self.last_api_key = api_key
        return list(self._expansions)


def _assert_protocol_compliance() -> PaletteSyncService:
    return FakePaletteSyncService()
```

- [ ] **Step 3: Create `__init__.py`**

```python
# backend/services/palette_sync/__init__.py
```

- [ ] **Step 4: Verify pyright passes**

Run: `cd backend && uv run pyright services/palette_sync/ tests/fakes/fake_palette_sync.py`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add backend/services/palette_sync/ backend/tests/fakes/fake_palette_sync.py
git commit -m "feat(palette-sync): add PaletteSyncService protocol and fake"
```

---

## Task 2: Palette Sync Service Implementation

**Files:**
- Create: `backend/services/palette_sync/palette_sync_service_impl.py`

- [ ] **Step 1: Implement the real service**

```python
# backend/services/palette_sync/palette_sync_service_impl.py
"""PaletteSyncService implementation calling Directors Palette v2 API."""

from __future__ import annotations

import logging

from services.http_client.http_client import HTTPClient
from services.palette_sync.palette_sync_service import (
    PaletteLoraInfo,
    PaletteWildcard,
    PaletteWildcardExpansion,
)

_logger = logging.getLogger(__name__)

PALETTE_BASE_URL = "https://directors-palette.app"

# Built-in FLUX Klein 9B LoRA weights URLs from Palette's lora.store.ts.
# The v2 API list endpoint doesn't include weights URLs, so we map known IDs
# to their download URLs here.
_KNOWN_WEIGHTS: dict[str, tuple[str, float]] = {
    "claymation-k9b": (
        "https://huuezdiitpmafkljkvui.supabase.co/storage/v1/object/public/loras/community/claymation_flux_lora_v1.safetensors",
        1.0,
    ),
    "inflate-k9b": (
        "https://huuezdiitpmafkljkvui.supabase.co/storage/v1/object/public/loras/community/inflate_it.safetensors",
        1.0,
    ),
    "disney-golden-age-k9b": (
        "https://huuezdiitpmafkljkvui.supabase.co/storage/v1/object/public/loras/community/disney_golden_age.safetensors",
        1.0,
    ),
    "nava-k9b": (
        "https://v3.fal.media/files/monkey/oF3DkwBOmrzohIKhCfNie_pytorch_lora_weights.safetensors",
        1.0,
    ),
    "dcau-k9b": (
        "https://huuezdiitpmafkljkvui.supabase.co/storage/v1/object/public/loras/community/jRB4slNlO3KYd18ROU5Up_pytorch_lora_weights_comfy_converted.safetensors",
        1.0,
    ),
    "cinematic-filmstill-k9b": (
        "https://huuezdiitpmafkljkvui.supabase.co/storage/v1/object/public/loras/community/cinematic_filmstill.safetensors",
        1.0,
    ),
    "consistency-k9b": (
        "https://pub-060813fba4064da4815db04b08604ce7.r2.dev/consistency_lora_v3.safetensors",
        0.8,
    ),
}


class PaletteSyncServiceImpl:
    def __init__(self, http: HTTPClient) -> None:
        self._http = http

    def _auth_headers(self, api_key: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {api_key}"}

    def _get_json(self, url: str, api_key: str) -> dict:
        resp = self._http.get(url, headers=self._auth_headers(api_key), timeout=30)
        if resp.status_code != 200:
            raise RuntimeError(f"Palette API error {resp.status_code}: {resp.text}")
        body = resp.json()
        if not body.get("success"):
            error = body.get("error", {})
            raise RuntimeError(f"Palette API error: {error.get('message', 'unknown')}")
        return body["data"]

    def list_loras(self, api_key: str) -> list[PaletteLoraInfo]:
        data = self._get_json(f"{PALETTE_BASE_URL}/api/v2/loras", api_key)
        result: list[PaletteLoraInfo] = []
        for item in data.get("loras", []):
            lora_id = item.get("id", "")
            known = _KNOWN_WEIGHTS.get(lora_id)
            if known is None:
                _logger.debug("Skipping LoRA %s — no known weights URL", lora_id)
                continue
            weights_url, default_scale = known
            result.append(PaletteLoraInfo(
                id=lora_id,
                name=item.get("name", lora_id),
                lora_type=item.get("type", "style"),
                trigger_word=item.get("trigger_word", ""),
                weights_url=weights_url,
                thumbnail_url=item.get("thumbnail_url", "") or "",
                lora_scale=default_scale,
                compatible_models=item.get("compatible_models", []),
            ))
        return result

    def list_wildcards(self, api_key: str) -> list[PaletteWildcard]:
        all_wildcards: list[PaletteWildcard] = []
        offset = 0
        limit = 100
        while True:
            data = self._get_json(
                f"{PALETTE_BASE_URL}/api/v2/wildcards?limit={limit}&offset={offset}",
                api_key,
            )
            for item in data.get("wildcards", []):
                all_wildcards.append(PaletteWildcard(
                    id=item.get("id", ""),
                    name=item.get("name", ""),
                    category=item.get("category", ""),
                    description=item.get("description", ""),
                    line_count=item.get("line_count", 0),
                ))
            total = data.get("total", 0)
            offset += limit
            if offset >= total:
                break
        return all_wildcards

    def expand_wildcards(self, api_key: str, prompt: str, count: int) -> list[PaletteWildcardExpansion]:
        resp = self._http.post(
            f"{PALETTE_BASE_URL}/api/v2/wildcards/expand",
            headers=self._auth_headers(api_key),
            json_payload={"prompt": prompt, "count": count},
            timeout=30,
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Palette API error {resp.status_code}: {resp.text}")
        body = resp.json()
        if not body.get("success"):
            error = body.get("error", {})
            raise RuntimeError(f"Palette API error: {error.get('message', 'unknown')}")
        data = body["data"]
        return [
            PaletteWildcardExpansion(
                text=exp.get("text", ""),
                wildcards_used=exp.get("wildcards_used", {}),
            )
            for exp in data.get("expansions", [])
        ]
```

- [ ] **Step 2: Verify pyright passes**

Run: `cd backend && uv run pyright services/palette_sync/`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add backend/services/palette_sync/palette_sync_service_impl.py
git commit -m "feat(palette-sync): implement PaletteSyncServiceImpl with Palette v2 API"
```

---

## Task 3: Palette Sync Handler

**Files:**
- Create: `backend/handlers/palette_sync_handler.py`

The handler orchestrates sync: calls the service to fetch data, then writes to local stores (LoRA catalog, etc.). It does NOT hold the lock during network calls — only during state writes.

- [ ] **Step 1: Write the handler**

```python
# backend/handlers/palette_sync_handler.py
"""Handler for syncing library data from Directors Palette."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING

from handlers.base import StateHandlerBase
from services.palette_sync.palette_sync_service import PaletteLoraInfo, PaletteSyncService

if TYPE_CHECKING:
    from threading import RLock

    from services.http_client.http_client import HTTPClient
    from state.app_state_types import AppState
    from state.lora_library import LoraLibraryStore

_logger = logging.getLogger(__name__)


class PaletteSyncHandler(StateHandlerBase):
    def __init__(
        self,
        state: AppState,
        lock: RLock,
        palette_sync: PaletteSyncService,
        http: HTTPClient,
        lora_store: LoraLibraryStore,
        loras_dir: Path,
    ) -> None:
        super().__init__(state, lock)
        self._palette_sync = palette_sync
        self._http = http
        self._lora_store = lora_store
        self._loras_dir = loras_dir

    def _get_api_key(self) -> str:
        key = self.state.app_settings.palette_api_key
        if not key:
            raise RuntimeError("Palette API key not configured. Add it in Settings.")
        return key

    def sync_loras(self) -> dict[str, int]:
        """Fetch LoRA catalog from Palette and download any missing weights.

        Returns {"synced": N, "skipped": N, "failed": N}.
        """
        api_key = self._get_api_key()
        palette_loras = self._palette_sync.list_loras(api_key)

        existing_ids = {e.id for e in self._lora_store.list_all()}
        synced = 0
        skipped = 0
        failed = 0

        for lora in palette_loras:
            catalog_id = f"palette:{lora.id}"
            if catalog_id in existing_ids:
                skipped += 1
                continue

            try:
                self._download_and_register_lora(lora, catalog_id)
                synced += 1
            except Exception:
                _logger.exception("Failed to sync LoRA %s", lora.id)
                failed += 1

        return {"synced": synced, "skipped": skipped, "failed": failed}

    def _download_and_register_lora(self, lora: PaletteLoraInfo, catalog_id: str) -> None:
        """Download LoRA weights and register in local catalog."""
        from state.lora_library import LoraEntry

        filename = f"palette_{lora.id}.safetensors"
        dest = self._loras_dir / filename

        if not dest.exists():
            _logger.info("Downloading LoRA %s from %s", lora.id, lora.weights_url)
            resp = self._http.get(lora.weights_url, timeout=300)
            if resp.status_code != 200:
                raise RuntimeError(f"Download failed: HTTP {resp.status_code}")
            dest.write_bytes(resp.content)

        entry = LoraEntry(
            id=catalog_id,
            name=f"[Palette] {lora.name}",
            file_path=str(dest),
            file_size_bytes=dest.stat().st_size,
            thumbnail_url=lora.thumbnail_url,
            trigger_phrase=lora.trigger_word,
            base_model="flux-klein-9b",
        )
        self._lora_store.add(entry)

    def sync_wildcards(self) -> dict[str, int]:
        """Fetch wildcard metadata from Palette.

        Returns {"synced": N}.
        """
        api_key = self._get_api_key()
        wildcards = self._palette_sync.list_wildcards(api_key)
        return {"synced": len(wildcards)}

    def expand_wildcards(self, prompt: str, count: int = 1) -> list[dict[str, object]]:
        """Expand wildcard tokens in a prompt using Palette's wildcard database."""
        api_key = self._get_api_key()
        expansions = self._palette_sync.expand_wildcards(api_key, prompt, count)
        return [{"text": e.text, "wildcards_used": e.wildcards_used} for e in expansions]

    def sync_all(self) -> dict[str, dict[str, int]]:
        """Run all sync operations. Returns results keyed by domain."""
        results: dict[str, dict[str, int]] = {}
        try:
            results["loras"] = self.sync_loras()
        except Exception:
            _logger.exception("LoRA sync failed")
            results["loras"] = {"error": 1}
        try:
            results["wildcards"] = self.sync_wildcards()
        except Exception:
            _logger.exception("Wildcard sync failed")
            results["wildcards"] = {"error": 1}
        return results
```

- [ ] **Step 2: Verify pyright passes**

Run: `cd backend && uv run pyright handlers/palette_sync_handler.py`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add backend/handlers/palette_sync_handler.py
git commit -m "feat(palette-sync): add PaletteSyncHandler for LoRA + wildcard sync"
```

---

## Task 4: Routes + App Wiring

**Files:**
- Create: `backend/_routes/palette_sync.py`
- Modify: `backend/app_handler.py`
- Modify: `backend/app_factory.py`
- Modify: `backend/tests/conftest.py`

- [ ] **Step 1: Write the routes**

```python
# backend/_routes/palette_sync.py
"""Routes for syncing library data from Directors Palette."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app_handler import AppHandler
from state import get_state_service

router = APIRouter(prefix="/api/palette-sync", tags=["palette-sync"])


class SyncResponse(BaseModel):
    results: dict[str, dict[str, int]]


class ExpandRequest(BaseModel):
    prompt: str
    count: int = 1


class ExpandResponse(BaseModel):
    expansions: list[dict[str, object]]


@router.post("/sync", response_model=SyncResponse)
def sync_all(handler: AppHandler = Depends(get_state_service)) -> SyncResponse:
    results = handler.palette_sync.sync_all()
    return SyncResponse(results=results)


@router.post("/sync/loras")
def sync_loras(handler: AppHandler = Depends(get_state_service)) -> dict[str, int]:
    return handler.palette_sync.sync_loras()


@router.post("/expand-wildcards", response_model=ExpandResponse)
def expand_wildcards(
    req: ExpandRequest, handler: AppHandler = Depends(get_state_service)
) -> ExpandResponse:
    expansions = handler.palette_sync.expand_wildcards(req.prompt, req.count)
    return ExpandResponse(expansions=expansions)
```

- [ ] **Step 2: Wire into AppHandler**

In `backend/app_handler.py`, add to the imports and the `_create_real_handler` function:

```python
# Add import
from services.palette_sync.palette_sync_service_impl import PaletteSyncServiceImpl
from handlers.palette_sync_handler import PaletteSyncHandler

# In _create_real_handler(), after lora_store = LoraLibraryStore(...), add:
palette_sync_service = PaletteSyncServiceImpl(http=http)
self.palette_sync = PaletteSyncHandler(
    state=self.state,
    lock=self._lock,
    palette_sync=palette_sync_service,
    http=http,
    lora_store=lora_store,  # use the local variable, not self.lora._store
    loras_dir=config.models_dir / "loras",
)
```

- [ ] **Step 3: Register router in app_factory.py**

In `backend/app_factory.py`, add:

```python
from _routes.palette_sync import router as palette_sync_router
app.include_router(palette_sync_router)
```

- [ ] **Step 4: Add fake to test conftest**

In `backend/tests/conftest.py`, wire `FakePaletteSyncService` into the test `AppHandler`:

```python
# Add import at top:
from tests.fakes.fake_palette_sync import FakePaletteSyncService
from handlers.palette_sync_handler import PaletteSyncHandler

# In the fixture that creates AppHandler, after lora_store is created, add:
fake_palette_sync = FakePaletteSyncService()
handler.palette_sync = PaletteSyncHandler(
    state=handler.state,
    lock=handler._lock,
    palette_sync=fake_palette_sync,
    http=fake_http,
    lora_store=lora_store,
    loras_dir=lora_store.loras_dir,
)
```

- [ ] **Step 5: Verify pyright and tests pass**

Run: `cd backend && uv run pyright _routes/palette_sync.py handlers/palette_sync_handler.py`
Run: `pnpm typecheck && pnpm backend:test`
Expected: 0 errors, all tests pass

- [ ] **Step 6: Commit**

```bash
git add backend/_routes/palette_sync.py backend/app_handler.py backend/app_factory.py backend/tests/conftest.py
git commit -m "feat(palette-sync): add routes and wire into app"
```

---

## Task 5: Integration Tests

**Files:**
- Create: `backend/tests/test_palette_sync.py`

- [ ] **Step 1: Write sync tests**

```python
# backend/tests/test_palette_sync.py
"""Integration tests for Palette sync."""

from __future__ import annotations

import pytest
from starlette.testclient import TestClient

from services.palette_sync.palette_sync_service import PaletteLoraInfo, PaletteWildcard
from tests.fakes.fake_palette_sync import FakePaletteSyncService


class TestPaletteSyncNoKey:
    def test_sync_without_api_key_returns_error(self, client: TestClient) -> None:
        resp = client.post("/api/palette-sync/sync")
        assert resp.status_code == 500
        assert "API key" in resp.json()["error"]


class TestPaletteLoraSync:
    def test_sync_loras_downloads_and_registers(
        self, client: TestClient, test_state, tmp_path
    ) -> None:
        test_state.state.app_settings.palette_api_key = "dp_test123"

        fake_sync = test_state.palette_sync._palette_sync
        assert isinstance(fake_sync, FakePaletteSyncService)
        fake_sync.loras = [
            PaletteLoraInfo(
                id="test-lora",
                name="Test LoRA",
                lora_type="style",
                trigger_word="test style",
                weights_url="https://example.com/test.safetensors",
                thumbnail_url="",
                lora_scale=1.0,
                compatible_models=["flux-2-klein-9b"],
            ),
        ]

        resp = client.post("/api/palette-sync/sync/loras")
        assert resp.status_code == 200
        data = resp.json()
        assert data["synced"] >= 0


class TestWildcardExpand:
    def test_expand_calls_service(self, client: TestClient, test_state) -> None:
        test_state.state.app_settings.palette_api_key = "dp_test123"

        resp = client.post(
            "/api/palette-sync/expand-wildcards",
            json={"prompt": "A hero in _location_", "count": 1},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "expansions" in data
```

- [ ] **Step 2: Run tests**

Run: `cd backend && uv run pytest tests/test_palette_sync.py -v --tb=short`
Expected: All pass

- [ ] **Step 3: Run full test suite**

Run: `pnpm typecheck && pnpm backend:test`
Expected: 0 errors, all tests pass

- [ ] **Step 4: Commit**

```bash
git add backend/tests/test_palette_sync.py
git commit -m "test(palette-sync): add integration tests for sync and expand"
```

---

## Task 6: Frontend — Sync Button in Settings

**Files:**
- Modify: `frontend/components/SettingsModal.tsx`

- [ ] **Step 1: Add sync button to settings**

In the Palette API key section of `SettingsModal.tsx`, add a "Sync Library from Palette" button that calls `POST /api/palette-sync/sync` and shows the result.

```typescript
// Add state for sync
const [syncing, setSyncing] = useState(false)
const [syncResult, setSyncResult] = useState<string | null>(null)

const handlePaletteSync = async () => {
  setSyncing(true)
  setSyncResult(null)
  try {
    const backendUrl = await window.electronAPI.getBackendUrl()
    const resp = await fetch(`${backendUrl}/api/palette-sync/sync`, { method: 'POST' })
    const data = await resp.json()
    const loras = data.results?.loras || {}
    setSyncResult(
      `Synced ${loras.synced || 0} LoRAs, skipped ${loras.skipped || 0}`
    )
  } catch (err) {
    setSyncResult('Sync failed')
  } finally {
    setSyncing(false)
  }
}
```

Add the button next to the Palette API key input:

```tsx
{settings.hasPaletteApiKey && (
  <button
    onClick={handlePaletteSync}
    disabled={syncing}
    className="px-3 py-1.5 rounded-lg text-sm bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-50"
  >
    {syncing ? 'Syncing...' : 'Sync Library from Palette'}
  </button>
)}
{syncResult && (
  <span className="text-sm text-zinc-400">{syncResult}</span>
)}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `pnpm typecheck:ts`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add frontend/components/SettingsModal.tsx
git commit -m "feat(palette-sync): add Sync Library button in settings"
```

---

## Summary

After all 6 tasks:

1. User enters Palette API key in Settings (already supported)
2. User clicks "Sync Library from Palette"
3. Backend fetches LoRA catalog from Palette v2 API
4. Downloads `.safetensors` files for known FLUX Klein LoRAs
5. Registers them in local LoRA catalog (visible in LoRA browser)
6. Wildcard expansion available via `/api/palette-sync/expand-wildcards`
7. All synced LoRAs show as `[Palette] Name` in the LoRA browser

**Future extensions (not in this plan):**
- Auto-sync on app startup when Palette key is configured
- Reference image download and local storage
- Character import with reference sheets
- User-uploaded LoRA download (needs Palette API endpoint for weights URLs)
- Prompt library sync (needs Palette API endpoint for prompt content)
