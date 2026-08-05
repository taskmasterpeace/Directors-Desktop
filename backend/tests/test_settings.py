"""Tests for GET /api/settings and POST /api/settings."""

from __future__ import annotations

import json
import os

from state.app_settings import AppSettings, UpdateSettingsRequest
from state import build_initial_state
from app_handler import ServiceBundle
from tests.fakes.services import FakeServices


class TestGetSettings:
    def test_default_settings(self, client, default_app_settings):
        r = client.get("/api/settings")
        assert r.status_code == 200
        data = r.json()
        assert data["useTorchCompile"] is False
        assert data["loadOnStartup"] is False
        assert data["hasLtxApiKey"] is False
        assert data["userPrefersLtxApiVideoGenerations"] is False
        assert data["hasReplicateApiKey"] is False
        assert data["imageModel"] == "flux-klein-9b"
        assert data["videoModel"] == "ltx-fast"
        # Fork policy: LTX cloud encoding is disabled, local is the only path.
        assert data["useLocalTextEncoder"] is True
        assert data["fastModel"] == {"useUpscaler": True}
        assert data["proModel"] == {"steps": 20, "useUpscaler": True}
        assert data["promptCacheSize"] == 100
        assert data["promptEnhancerEnabledT2V"] is True
        assert data["promptEnhancerEnabledI2V"] is False
        assert data["hasGeminiApiKey"] is False
        assert data["seedLocked"] is False
        assert data["lockedSeed"] == 42
        assert data["batchSoundEnabled"] is True
        assert data["visionCaptionerModel"] == "qwen/qwen-2.5-vl-72b-instruct"
        assert "ltxApiKey" not in data
        assert "replicateApiKey" not in data
        assert "geminiApiKey" not in data

    def test_reflects_changed_settings(self, client, test_state):
        test_state.state.app_settings.use_torch_compile = True
        r = client.get("/api/settings")
        assert r.json()["useTorchCompile"] is True

    def test_has_api_key_true_when_set(self, client, test_state):
        test_state.state.app_settings.ltx_api_key = "test-key-123"
        r = client.get("/api/settings")
        data = r.json()
        assert data["hasLtxApiKey"] is True
        assert "ltxApiKey" not in data


class TestPostSettings:
    def test_update_single_field(self, client, test_state):
        r = client.post("/api/settings", json={"useTorchCompile": True})
        assert r.status_code == 200
        assert test_state.state.app_settings.use_torch_compile is True

    def test_update_multiple_fields(self, client, test_state):
        r = client.post("/api/settings", json={"useTorchCompile": True, "loadOnStartup": True})
        assert r.status_code == 200
        assert test_state.state.app_settings.use_torch_compile is True
        assert test_state.state.app_settings.load_on_startup is True

    def test_save_openrouter_api_key_persists_and_masks(self, client, test_state):
        r = client.post("/api/settings", json={"openrouterApiKey": "or-secret-key"})
        assert r.status_code == 200
        assert test_state.state.app_settings.openrouter_api_key == "or-secret-key"
        data = client.get("/api/settings").json()
        assert data["hasOpenrouterApiKey"] is True
        assert "openrouterApiKey" not in data  # the raw key is never returned

    def test_empty_openrouter_key_does_not_clobber_saved_one(self, client, test_state):
        test_state.state.app_settings.openrouter_api_key = "keep-me"
        # an empty value (e.g. from a masked settings sync) must not wipe the saved key
        r = client.post("/api/settings", json={"openrouterApiKey": ""})
        assert r.status_code == 200
        assert test_state.state.app_settings.openrouter_api_key == "keep-me"

    def test_update_fast_model(self, client, test_state):
        r = client.post("/api/settings", json={"fastModel": {"useUpscaler": False}})
        assert r.status_code == 200
        assert test_state.state.app_settings.fast_model.use_upscaler is False

    def test_update_pro_model(self, client, test_state):
        r = client.post("/api/settings", json={"proModel": {"steps": 30, "useUpscaler": False}})
        assert r.status_code == 200
        assert test_state.state.app_settings.pro_model.steps == 30
        assert test_state.state.app_settings.pro_model.use_upscaler is False

    def test_deep_partial_patch_preserves_nested_fields(self, client, test_state):
        assert test_state.state.app_settings.pro_model.use_upscaler is True
        r = client.post("/api/settings", json={"proModel": {"steps": 30}})
        assert r.status_code == 200
        assert test_state.state.app_settings.pro_model.steps == 30
        assert test_state.state.app_settings.pro_model.use_upscaler is True

    def test_prompt_cache_size_clamped_max(self, client, test_state):
        r = client.post("/api/settings", json={"promptCacheSize": 5000})
        assert r.status_code == 200
        assert test_state.state.app_settings.prompt_cache_size <= 1000

    def test_prompt_cache_size_clamped_min(self, client, test_state):
        r = client.post("/api/settings", json={"promptCacheSize": -10})
        assert r.status_code == 200
        assert test_state.state.app_settings.prompt_cache_size >= 0

    def test_locked_seed_clamped_range(self, client, test_state):
        r = client.post("/api/settings", json={"lockedSeed": 9_999_999_999})
        assert r.status_code == 200
        assert test_state.state.app_settings.locked_seed == 2_147_483_647

    def test_prompt_cache_shrinks_cache(self, client, test_state):
        te = test_state.state.text_encoder
        assert te is not None
        for i in range(5):
            te.prompt_cache[(f"key_{i}", False)] = f"value_{i}"  # type: ignore[assignment]

        r = client.post("/api/settings", json={"promptCacheSize": 2})
        assert r.status_code == 200
        assert len(te.prompt_cache) <= 2

    def test_update_api_keys(self, client, test_state):
        r = client.post(
            "/api/settings",
            json={
                "ltxApiKey": "ltx-key-abc",
                "geminiApiKey": "gemini-key-xyz",
                "replicateApiKey": "rep-key-123",
            },
        )
        assert r.status_code == 200
        assert test_state.state.app_settings.ltx_api_key == "ltx-key-abc"
        assert test_state.state.app_settings.gemini_api_key == "gemini-key-xyz"
        assert test_state.state.app_settings.replicate_api_key == "rep-key-123"

    def test_update_user_prefers_api_video_generations(self, client, test_state):
        r = client.post("/api/settings", json={"userPrefersLtxApiVideoGenerations": True})
        assert r.status_code == 200
        assert test_state.state.app_settings.user_prefers_ltx_api_video_generations is True

    def test_empty_string_does_not_erase_key(self, client, test_state):
        test_state.state.app_settings.ltx_api_key = "real-key"
        test_state.state.app_settings.replicate_api_key = "rep-key"
        r = client.post("/api/settings", json={"ltxApiKey": "", "replicateApiKey": ""})
        assert r.status_code == 200
        assert test_state.state.app_settings.ltx_api_key == "real-key"
        assert test_state.state.app_settings.replicate_api_key == "rep-key"

    def test_omitted_key_does_not_erase_key(self, client, test_state):
        test_state.state.app_settings.ltx_api_key = "real-key"
        r = client.post("/api/settings", json={"useTorchCompile": True})
        assert r.status_code == 200
        assert test_state.state.app_settings.ltx_api_key == "real-key"

    def test_unknown_field_rejected(self, client):
        r = client.post("/api/settings", json={"unknownSetting": True})
        assert r.status_code == 422


class TestVideoModel:
    def test_video_model_roundtrips(self, client, test_state):
        resp = client.post("/api/settings", json={"videoModel": "seedance-1.5-pro"})
        assert resp.status_code == 200
        assert test_state.state.app_settings.video_model == "seedance-1.5-pro"

        get_resp = client.get("/api/settings")
        assert get_resp.json()["videoModel"] == "seedance-1.5-pro"


class TestFalApiKey:
    def test_fal_api_key_roundtrips_and_is_masked(self, client, test_state):
        resp = client.post("/api/settings", json={"falApiKey": "fal-secret-key"})
        assert resp.status_code == 200
        assert test_state.state.app_settings.fal_api_key == "fal-secret-key"

        data = client.get("/api/settings").json()
        assert data["hasFalApiKey"] is True
        assert "falApiKey" not in data

    def test_fal_api_key_absent_by_default(self, client):
        data = client.get("/api/settings").json()
        assert data["hasFalApiKey"] is False


class TestSettingsPersistence:
    def _new_state(self, test_state, default_app_settings):
        fake_services = FakeServices()
        bundle = ServiceBundle(
            http=fake_services.http,
            gpu_cleaner=fake_services.gpu_cleaner,
            model_downloader=fake_services.model_downloader,
            gpu_info=fake_services.gpu_info,
            video_processor=fake_services.video_processor,
            text_encoder=fake_services.text_encoder,
            task_runner=fake_services.task_runner,
            ltx_api_client=fake_services.ltx_api_client,
            image_api_client=fake_services.image_api_client,
            video_api_client=fake_services.video_api_client,
            fal_video_client=fake_services.fal_video_client,
            fal_upload_client=fake_services.fal_upload_client,
            video_trimmer=fake_services.video_trimmer,
            palette_image_client=fake_services.palette_image_client,
            palette_sync_client=fake_services.palette_sync_client,
            fast_video_pipeline_class=type(fake_services.fast_video_pipeline),
            gguf_video_pipeline_class=None,
            nf4_video_pipeline_class=None,
            image_generation_pipeline_class=type(fake_services.image_generation_pipeline),
            flux_klein_pipeline_class=None,
            flux_dev_pipeline_class=None,
            ic_lora_pipeline_class=type(fake_services.ic_lora_pipeline),
            a2v_pipeline_class=type(fake_services.a2v_pipeline),
            retake_pipeline_class=type(fake_services.retake_pipeline),
            ic_lora_model_downloader=fake_services.ic_lora_model_downloader,
            model_scanner=fake_services.model_scanner,
            audio_analyzer=fake_services.audio_analyzer,
            video_assembler=fake_services.video_assembler,
            recast_client=fake_services.recast_client,
        )
        return build_initial_state(test_state.config, default_app_settings.model_copy(deep=True), service_bundle=bundle)

    def test_load_settings_clamps_from_disk(self, test_state, default_app_settings):
        test_state.config.settings_file.write_text(
            json.dumps(
                {
                    "prompt_cache_size": 5000,
                    "locked_seed": -55,
                    "pro_model": {"steps": 999},
                }
            ),
            encoding="utf-8",
        )

        loaded = self._new_state(test_state, default_app_settings)
        assert loaded.state.app_settings.prompt_cache_size == 1000
        assert loaded.state.app_settings.locked_seed == 0
        assert loaded.state.app_settings.pro_model.steps == 100

    def test_legacy_prompt_enhancer_key_migrates(self, test_state, default_app_settings):
        test_state.config.settings_file.write_text(
            json.dumps({"prompt_enhancer_enabled": False}),
            encoding="utf-8",
        )

        loaded = self._new_state(test_state, default_app_settings)
        assert loaded.state.app_settings.prompt_enhancer_enabled_t2v is False
        assert loaded.state.app_settings.prompt_enhancer_enabled_i2v is False

    def test_user_prefers_api_video_generations_persists(self, client, test_state, default_app_settings):
        r = client.post("/api/settings", json={"userPrefersLtxApiVideoGenerations": True})
        assert r.status_code == 200
        assert test_state.state.app_settings.user_prefers_ltx_api_video_generations is True

        loaded = self._new_state(test_state, default_app_settings)
        assert loaded.state.app_settings.user_prefers_ltx_api_video_generations is True


class TestPaletteApiKey:
    def test_palette_api_key_roundtrip(self, client, default_app_settings):
        """Palette API key can be saved and is masked in responses."""
        resp = client.post("/api/settings", json={"paletteApiKey": "dp_test_key_123"})
        assert resp.status_code == 200
        resp = client.get("/api/settings")
        data = resp.json()
        assert data["hasPaletteApiKey"] is True
        assert "dp_test_key_123" not in resp.text


class TestAbliteratedTextEncoder:
    def test_setting_roundtrips(self, client, test_state):
        resp = client.post("/api/settings", json={"useAbliteratedTextEncoder": True})
        assert resp.status_code == 200
        assert test_state.state.app_settings.use_abliterated_text_encoder is True

        get_resp = client.get("/api/settings")
        assert get_resp.json()["useAbliteratedTextEncoder"] is True

    def test_default_is_false(self, client):
        resp = client.get("/api/settings")
        assert resp.json()["useAbliteratedTextEncoder"] is False

    def test_resolve_gemma_root_uses_abliterated_when_enabled(self, test_state, create_fake_model_files):
        create_fake_model_files()
        test_state.state.app_settings.use_local_text_encoder = True
        test_state.state.app_settings.use_abliterated_text_encoder = True

        # Create abliterated encoder directory
        abliterated_dir = test_state.config.model_path("text_encoder_abliterated")
        abliterated_dir.mkdir(parents=True, exist_ok=True)
        (abliterated_dir / "model.safetensors").write_bytes(b"\x00" * 1024)

        gemma_root = test_state.text.resolve_gemma_root()
        assert gemma_root is not None
        assert "abliterated" in gemma_root

    def test_resolve_gemma_root_falls_back_when_abliterated_missing(self, test_state, create_fake_model_files):
        create_fake_model_files()
        test_state.state.app_settings.use_local_text_encoder = True
        test_state.state.app_settings.use_abliterated_text_encoder = True

        # No abliterated directory — should fall back to standard
        gemma_root = test_state.text.resolve_gemma_root()
        assert gemma_root is not None
        assert "abliterated" not in gemma_root

    def test_abliterated_not_required_for_download(self, client, test_state):
        resp = client.get("/api/models/status")
        models = resp.json()["models"]
        abliterated = next(m for m in models if "abliterated" in m["name"].lower())
        assert abliterated["required"] is False


class TestSettingsSchemaDrift:
    def test_update_request_tracks_app_settings_fields(self):
        assert set(AppSettings.model_fields) == set(UpdateSettingsRequest.model_fields)


class TestSettingsDurability:
    """F14 — settings.json holds the API keys the app gates on.

    Writing it in place meant a crash mid-write truncated the file, load fell
    back to defaults, and the next save persisted those defaults over the user's
    data. Because the Palette gate treats an empty key as a real sign-out (the
    offline grace window only covers an unreachable backend), that silently
    locked the user out of their own app.
    """

    def test_save_is_atomic_and_leaves_no_temp_file(self, test_state):
        test_state.settings.state.app_settings.palette_api_key = "dp_secret"
        test_state.settings.save_settings()

        path = test_state.config.settings_file
        assert json.loads(path.read_text(encoding="utf-8"))["palette_api_key"] == "dp_secret"
        # A stray .tmp would be mistaken for real state by anything globbing the dir.
        assert not list(path.parent.glob(f"{path.name}.*.tmp"))

    def test_a_reader_never_observes_a_truncated_file(self, test_state):
        """The actual crash-safety property: the file is only ever whole.

        Written as an invariant over repeated saves rather than a simulated
        crash — with os.replace the target is swapped, never truncated, so any
        read between saves must parse.
        """
        path = test_state.config.settings_file
        for i in range(20):
            test_state.settings.state.app_settings.palette_api_key = f"dp_{i}"
            test_state.settings.save_settings()
            assert json.loads(path.read_text(encoding="utf-8"))["palette_api_key"] == f"dp_{i}"

    def test_corrupt_settings_are_quarantined_with_the_data_still_inside(self, test_state, default_app_settings):
        path = test_state.config.settings_file
        path.write_text('{"palette_api_key": "dp_keep_me", TRUNCATED', encoding="utf-8")

        test_state.settings.load_settings(default_app_settings)

        quarantined = list(path.parent.glob(f"{path.name}.corrupt-*"))
        assert len(quarantined) == 1, "corrupt settings must be preserved, not discarded"
        assert "dp_keep_me" in quarantined[0].read_text(encoding="utf-8")

    def test_a_later_save_does_not_destroy_the_quarantined_original(self, test_state, default_app_settings):
        path = test_state.config.settings_file
        path.write_text('{"palette_api_key": "dp_keep_me", TRUNCATED', encoding="utf-8")
        test_state.settings.load_settings(default_app_settings)

        # The app carries on and saves defaults — recovery must stay possible.
        test_state.settings.save_settings()

        quarantined = list(path.parent.glob(f"{path.name}.corrupt-*"))
        assert len(quarantined) == 1
        assert "dp_keep_me" in quarantined[0].read_text(encoding="utf-8")

    def test_a_failed_write_leaves_the_previous_settings_intact(self, test_state):
        """The property the in-place write did not have.

        Blocks the temp path with a directory so the write raises partway through
        save_settings. Under the old ``open(path, "w")`` the real file was already
        truncated by this point and the keys were gone; with tmp+replace the
        original is untouched.
        """
        path = test_state.config.settings_file
        test_state.settings.state.app_settings.palette_api_key = "dp_original"
        test_state.settings.save_settings()

        blocker = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        blocker.mkdir()
        try:
            test_state.settings.state.app_settings.palette_api_key = "dp_never_written"
            test_state.settings.save_settings()  # swallows the error by design
            assert json.loads(path.read_text(encoding="utf-8"))["palette_api_key"] == "dp_original"
        finally:
            blocker.rmdir()

    def test_unknown_keys_from_a_newer_build_survive_a_downgrade(self, test_state, default_app_settings):
        """#12 — an older build must not erase a newer build's settings.

        AppSettings is extra="ignore", so a key the running build has never heard
        of is dropped on load. If save then wrote only known fields, opening a
        project once in last month's build wiped this month's settings.
        """
        path = test_state.config.settings_file
        path.write_text(
            '{"palette_api_key": "dp_x", "future_feature_flag": true, '
            '"future_nested": {"a": 1}}',
            encoding="utf-8",
        )
        test_state.settings.load_settings(default_app_settings)

        # A normal save (e.g. the user toggles anything) must keep the unknowns.
        test_state.settings.save_settings()
        written = json.loads(path.read_text(encoding="utf-8"))
        assert written["future_feature_flag"] is True
        assert written["future_nested"] == {"a": 1}
        assert written["palette_api_key"] == "dp_x"  # known keys still round-trip

    def test_a_known_key_always_wins_over_a_stale_preserved_copy(self, test_state, default_app_settings):
        # If a key later becomes known, the model's value must win, not the stashed one.
        path = test_state.config.settings_file
        path.write_text('{"prompt_cache_size": 50}', encoding="utf-8")
        test_state.settings.load_settings(default_app_settings)
        test_state.settings.state.app_settings.prompt_cache_size = 999
        test_state.settings.save_settings()
        assert json.loads(path.read_text(encoding="utf-8"))["prompt_cache_size"] == 999

    def test_keys_survive_a_save_load_cycle_byte_exact(self, test_state, default_app_settings):
        secret = "dp_" + "x" * 509  # 512 chars, the length the loop probed
        test_state.settings.state.app_settings.palette_api_key = secret
        test_state.settings.save_settings()

        reloaded = test_state.settings.load_settings(default_app_settings)
        assert reloaded.palette_api_key == secret
