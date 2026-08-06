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


class TestCreditDeductionRetry:
    """#23 — a delivered render whose deduction hits a transient blip must not
    leak as free usage; but a retry must never be able to double-charge."""

    def _connect(self, test_state):
        test_state.state.app_settings.palette_api_key = "dp_key"

    def test_transient_failure_is_retried_then_succeeds(self, test_state):
        self._connect(test_state)
        test_state.palette_sync_client.deduct_fail_times = 2  # fail twice, then work
        result = test_state.sync.deduct_credits("video_i2v", 1, {"job_id": "j1"})
        assert result["deducted"] is True
        assert len(test_state.palette_sync_client.deduct_calls) == 3

    def test_insufficient_credits_is_terminal_and_not_retried(self, test_state):
        self._connect(test_state)
        test_state.palette_sync_client.deduct_raise_insufficient = True
        result = test_state.sync.deduct_credits("video_i2v", 1, {"job_id": "j1"})
        assert result["deducted"] is False
        assert result.get("insufficient") is True
        assert len(test_state.palette_sync_client.deduct_calls) == 1  # no retry

    def test_persistent_transient_failure_gives_up_without_raising(self, test_state):
        from handlers.sync_handler import _DEDUCT_MAX_ATTEMPTS

        self._connect(test_state)
        test_state.palette_sync_client.deduct_fail_times = 99  # never recovers
        result = test_state.sync.deduct_credits("video_i2v", 1, {"job_id": "j1"})
        assert result["deducted"] is False
        assert "error" in result
        assert len(test_state.palette_sync_client.deduct_calls) == _DEDUCT_MAX_ATTEMPTS

    def test_every_attempt_carries_the_same_idempotency_metadata(self, test_state):
        # The retry is only double-charge-safe because each attempt sends the
        # same job_id; verify the handler doesn't mutate it between tries.
        self._connect(test_state)
        test_state.palette_sync_client.deduct_fail_times = 2
        test_state.sync.deduct_credits("video_i2v", 1, {"job_id": "same-job"})
        job_ids = {c["metadata"]["job_id"] for c in test_state.palette_sync_client.deduct_calls}
        assert job_ids == {"same-job"}


class TestGenerationKeySplit:
    """#84: the dp_ generation key lives apart from the session credential, so
    signing in can never silently kill cloud generation again."""

    def test_connect_with_dp_key_fills_both_fields(self, client, test_state):
        resp = client.post("/api/sync/connect", json={"token": "dp_generation_key"})
        assert resp.json()["connected"] is True
        assert test_state.state.app_settings.palette_generation_key == "dp_generation_key"
        assert test_state.state.app_settings.palette_api_key == "dp_generation_key"

    def test_session_connect_preserves_generation_key(self, client, test_state):
        client.post("/api/sync/connect", json={"token": "dp_generation_key"})
        resp = client.post("/api/sync/connect", json={"token": "eyJ.session.jwt", "refresh_token": "r1"})
        assert resp.json()["connected"] is True
        assert test_state.state.app_settings.palette_api_key == "eyJ.session.jwt"
        assert test_state.state.app_settings.palette_generation_key == "dp_generation_key"
        status = client.get("/api/sync/status").json()
        assert status["generationReady"] is True

    def test_session_connect_promotes_presplit_dp_key(self, client, test_state):
        # Pre-split state: the dp_ key sits in the session slot only.
        test_state.state.app_settings.palette_api_key = "dp_old_single_field"
        test_state.state.app_settings.palette_generation_key = ""
        client.post("/api/sync/connect", json={"token": "eyJ.session.jwt"})
        assert test_state.state.app_settings.palette_generation_key == "dp_old_single_field"
        assert test_state.state.app_settings.palette_api_key == "eyJ.session.jwt"

    def test_login_promotes_presplit_dp_key(self, client, test_state):
        test_state.state.app_settings.palette_api_key = "dp_old_single_field"
        client.post("/api/sync/login", json={"email": "a@b.c", "password": "x"})
        assert test_state.state.app_settings.palette_generation_key == "dp_old_single_field"
        assert test_state.state.app_settings.palette_api_key == "fake-jwt-token"

    def test_generation_ready_falls_back_to_presplit_key(self, client, test_state):
        test_state.state.app_settings.palette_api_key = "dp_old_single_field"
        test_state.state.app_settings.palette_generation_key = ""
        status = client.get("/api/sync/status").json()
        assert status["generationReady"] is True

    def test_session_only_is_not_generation_ready(self, client, test_state):
        test_state.state.app_settings.palette_api_key = "eyJ.session.jwt"
        status = client.get("/api/sync/status").json()
        assert status["generationReady"] is False

    def test_disconnect_clears_generation_key_too(self, client, test_state):
        client.post("/api/sync/connect", json={"token": "dp_generation_key"})
        client.post("/api/sync/disconnect")
        assert test_state.state.app_settings.palette_generation_key == ""
        assert test_state.state.app_settings.palette_api_key == ""

    def test_settings_response_reports_generation_key(self, client):
        client.post("/api/sync/connect", json={"token": "dp_generation_key"})
        data = client.get("/api/settings").json()
        assert data["hasPaletteGenerationKey"] is True
