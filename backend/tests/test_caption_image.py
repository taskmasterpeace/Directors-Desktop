"""Tests for image captioning for video prompt generation."""

from __future__ import annotations

from pathlib import Path

from PIL import Image

from tests.fakes.services import FakeResponse


class TestCaptionImage:
    def _write_test_image(self, tmp_path: Path) -> str:
        img = Image.new("RGB", (512, 288), "red")
        p = tmp_path / "test.jpg"
        img.save(p, format="JPEG")
        return str(p)

    def test_missing_openrouter_key_errors(self, client, test_state, tmp_path):
        test_state.state.app_settings.openrouter_api_key = ""
        image_path = self._write_test_image(tmp_path)
        r = client.post(
            "/api/caption-image",
            json={"imagePath": image_path, "targetModel": "ltx-fast"},
        )
        assert r.status_code == 400
        assert "openrouter" in r.text.lower() or "api key" in r.text.lower()

    def test_caption_image_ltx_uses_cinematic_system_prompt(
        self, client, test_state, fake_services, tmp_path
    ):
        test_state.state.app_settings.openrouter_api_key = "sk-or-test"
        image_path = self._write_test_image(tmp_path)
        fake_services.http.queue(
            "post",
            FakeResponse(
                status_code=200,
                json_payload={
                    "choices": [
                        {"message": {"content": "Slow dolly-in as smoke curls from the pipe."}}
                    ]
                },
            ),
        )
        r = client.post(
            "/api/caption-image",
            json={"imagePath": image_path, "targetModel": "ltx-fast"},
        )
        assert r.status_code == 200
        assert r.json()["prompt"] == "Slow dolly-in as smoke curls from the pipe."
        # Inspect the request that was sent
        call = fake_services.http.calls[-1]
        assert call.json_payload is not None
        body = call.json_payload
        system_msg = body["messages"][0]
        assert system_msg["role"] == "system"
        assert "cinematic" in system_msg["content"].lower()
        assert "motion" in system_msg["content"].lower()

    def test_caption_image_seedance_uses_seedance_system_prompt(
        self, client, test_state, fake_services, tmp_path
    ):
        test_state.state.app_settings.openrouter_api_key = "sk-or-test"
        image_path = self._write_test_image(tmp_path)
        fake_services.http.queue(
            "post",
            FakeResponse(
                status_code=200,
                json_payload={"choices": [{"message": {"content": "Camera pans right."}}]},
            ),
        )
        r = client.post(
            "/api/caption-image",
            json={"imagePath": image_path, "targetModel": "seedance-1.5-pro"},
        )
        assert r.status_code == 200
        call = fake_services.http.calls[-1]
        assert call.json_payload is not None
        body = call.json_payload
        system_msg = body["messages"][0]
        assert "subject" in system_msg["content"].lower()
        # Seedance prompt should be concise per spec
        assert (
            "concise" in system_msg["content"].lower()
            or "under" in system_msg["content"].lower()
        )

    def test_caption_image_uses_configured_captioner_model(
        self, client, test_state, fake_services, tmp_path
    ):
        test_state.state.app_settings.openrouter_api_key = "sk-or-test"
        test_state.state.app_settings.vision_captioner_model = "google/gemma-3-27b-it"
        image_path = self._write_test_image(tmp_path)
        fake_services.http.queue(
            "post",
            FakeResponse(
                status_code=200,
                json_payload={"choices": [{"message": {"content": "Pan left."}}]},
            ),
        )
        r = client.post(
            "/api/caption-image",
            json={"imagePath": image_path, "targetModel": "ltx-fast"},
        )
        assert r.status_code == 200
        call = fake_services.http.calls[-1]
        assert call.json_payload is not None
        body = call.json_payload
        assert body["model"] == "google/gemma-3-27b-it"
