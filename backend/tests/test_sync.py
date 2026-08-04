"""Tests for Palette sync routes."""
from __future__ import annotations


class TestSyncStatus:
    def test_disconnected_by_default(self, client):
        resp = client.get("/api/sync/status")
        assert resp.status_code == 200
        data = resp.json()
        assert data["connected"] is False
        assert data["user"] is None

    def test_connected_after_setting_api_key(self, client):
        client.post("/api/settings", json={"paletteApiKey": "dp_valid_key"})
        resp = client.get("/api/sync/status")
        assert resp.status_code == 200
        data = resp.json()
        assert data["connected"] is True
        assert data["user"]["email"] == "test@example.com"

    def test_connection_fails_with_invalid_key(self, client, fake_services):
        fake_services.palette_sync_client.raise_on_validate = RuntimeError("Invalid API key")
        client.post("/api/settings", json={"paletteApiKey": "dp_bad_key"})
        resp = client.get("/api/sync/status")
        data = resp.json()
        assert data["connected"] is False


class TestSyncCredits:
    def test_credits_when_connected(self, client):
        client.post("/api/settings", json={"paletteApiKey": "dp_valid_key"})
        resp = client.get("/api/sync/credits")
        assert resp.status_code == 200
        data = resp.json()
        assert data["balance_cents"] == 5000
        assert "pricing" in data

    def test_credits_when_disconnected(self, client):
        resp = client.get("/api/sync/credits")
        assert resp.status_code == 200
        data = resp.json()
        assert data["balance_cents"] is None
        assert data["connected"] is False


class TestGenerationKeyProvisioning:
    """Browser sign-in yields a session token — good for credits and library
    sync, useless for v2 image generation. The desktop spends that session on
    Palette's key endpoint so the user never hunts for an API key."""

    def test_session_connection_is_not_generation_ready(self, client):
        client.post("/api/settings", json={"paletteApiKey": "session-jwt-token"})
        data = client.get("/api/sync/status").json()
        assert data["connected"] is True
        assert data["generationReady"] is False

    def test_provision_swaps_in_a_dp_key(self, client, fake_services):
        client.post("/api/settings", json={"paletteApiKey": "session-jwt-token"})

        resp = client.post("/api/sync/provision-key")
        assert resp.status_code == 200
        assert resp.json()["ok"] is True
        assert fake_services.palette_sync_client.provision_calls == ["session-jwt-token"]

        data = client.get("/api/sync/status").json()
        assert data["generationReady"] is True

    def test_provision_is_a_no_op_once_ready(self, client):
        client.post("/api/settings", json={"paletteApiKey": "dp_valid_key"})
        body = client.post("/api/sync/provision-key").json()
        assert body["ok"] is True
        assert body["alreadyReady"] is True

    def test_provision_failure_keeps_the_session_intact(self, client, fake_services):
        fake_services.palette_sync_client.provision_error = (
            "KEY_PROVISION_UNAVAILABLE: not deployed"
        )
        client.post("/api/settings", json={"paletteApiKey": "session-jwt-token"})

        body = client.post("/api/sync/provision-key").json()
        assert body["ok"] is False
        assert "KEY_PROVISION_UNAVAILABLE" in body["error"]
        # Sync/credits must keep working so the fallback paste path stays usable.
        assert client.get("/api/sync/status").json()["connected"] is True
