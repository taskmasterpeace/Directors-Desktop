"""Transcription handler — word-level transcripts via Replicate incredibly-fast-whisper.

Uses the shared HTTP client directly (like EnhancePromptHandler) rather than a DI service.
"""

from __future__ import annotations

import base64
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

from _routes._errors import HTTPError
from api_types import TranscribeRequest, TranscribeResponse, TranscriptWordModel
from server_utils.media_validation import normalize_optional_path

if TYPE_CHECKING:
    from services.interfaces import HTTPClient
    from state.app_state_types import AppState

_MODEL = "vaibhavs10/incredibly-fast-whisper"
_BASE_URL = "https://api.replicate.com/v1"
_POLL_INTERVAL_SECONDS = 2
_POLL_TIMEOUT_SECONDS = 300
_AUDIO_MIME = {
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    "m4a": "audio/mp4",
    "ogg": "audio/ogg",
    "flac": "audio/flac",
    # incredibly-fast-whisper accepts video too (it extracts the audio track).
    "mp4": "video/mp4",
    "mov": "video/quicktime",
    "webm": "video/webm",
    "mkv": "video/x-matroska",
}


class TranscriptionHandler:
    def __init__(self, state: "AppState", http: "HTTPClient") -> None:
        self._state = state
        self._http = http

    def transcribe(self, req: TranscribeRequest) -> TranscribeResponse:
        api_key = self._state.app_settings.replicate_api_key.strip()
        if not api_key:
            raise HTTPError(400, "REPLICATE_API_KEY_NOT_CONFIGURED")

        audio_uri = self._audio_to_data_uri(req.audioPath)
        if audio_uri is None:
            raise HTTPError(400, f"Audio file not found: {req.audioPath}")

        output = self._run_prediction(api_key, audio_uri)
        words, language = self._parse_output(output)
        return TranscribeResponse(words=words, language=language)

    @staticmethod
    def _audio_to_data_uri(audio_path: str) -> str | None:
        normalized = normalize_optional_path(audio_path)
        if normalized is None:
            return None
        file = Path(normalized)
        if not file.exists():
            return None
        ext = file.suffix.lstrip(".").lower()
        mime = _AUDIO_MIME.get(ext, "audio/mpeg")
        b64 = base64.b64encode(file.read_bytes()).decode("ascii")
        return f"data:{mime};base64,{b64}"

    def _resolve_latest_version(self, api_key: str) -> str:
        """Resolve the model's latest version id.

        ``vaibhavs10/incredibly-fast-whisper`` is a community model: the
        ``/models/{owner}/{name}/predictions`` shortcut 404s for it, so we must POST to
        ``/predictions`` with an explicit version id (verified against the live API).
        """
        resp = self._http.get(
            f"{_BASE_URL}/models/{_MODEL}",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=30,
        )
        if resp.status_code != 200:
            raise HTTPError(502, f"Could not resolve transcription model ({resp.status_code})")
        data = self._json_object(resp.json())
        version = data.get("latest_version")
        if isinstance(version, dict):
            vid = cast(dict[str, Any], version).get("id")
            if isinstance(vid, str) and vid:
                return vid
        raise HTTPError(502, "Transcription model has no published version")

    def _run_prediction(self, api_key: str, audio_uri: str) -> dict[str, Any]:
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Prefer": "wait",
        }
        version = self._resolve_latest_version(api_key)
        resp = self._http.post(
            f"{_BASE_URL}/predictions",
            headers=headers,
            json_payload={
                "version": version,
                "input": {"audio": audio_uri, "task": "transcribe", "timestamp": "word"},
            },
            timeout=300,
        )
        if resp.status_code not in (200, 201):
            detail = resp.text[:300] if resp.text else "Unknown error"
            raise HTTPError(502, f"Transcription failed ({resp.status_code}): {detail}")
        prediction = self._json_object(resp.json())

        status = prediction.get("status", "")
        if status == "succeeded":
            return prediction
        if status in ("failed", "canceled"):
            raise HTTPError(502, f"Transcription {status}: {prediction.get('error', 'Unknown error')}")

        poll_url = prediction.get("urls", {}).get("get") or f"{_BASE_URL}/predictions/{prediction.get('id', '')}"
        deadline = time.monotonic() + _POLL_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            time.sleep(_POLL_INTERVAL_SECONDS)
            poll = self._http.get(poll_url, headers={"Authorization": f"Bearer {api_key}"}, timeout=30)
            if poll.status_code != 200:
                raise HTTPError(502, f"Transcription poll failed ({poll.status_code})")
            data = self._json_object(poll.json())
            if data.get("status") == "succeeded":
                return data
            if data.get("status") in ("failed", "canceled"):
                raise HTTPError(502, f"Transcription {data.get('status')}: {data.get('error', 'Unknown error')}")
        raise HTTPError(504, "Transcription timed out")

    @staticmethod
    def _parse_output(prediction: dict[str, Any]) -> tuple[list[TranscriptWordModel], str | None]:
        output = prediction.get("output")
        if not isinstance(output, dict):
            return [], None
        out = cast(dict[str, Any], output)
        words: list[TranscriptWordModel] = []
        chunks = out.get("chunks")
        if isinstance(chunks, list):
            for chunk in cast(list[Any], chunks):
                if not isinstance(chunk, dict):
                    continue
                c = cast(dict[str, Any], chunk)
                ts = c.get("timestamp")
                if not isinstance(ts, list) or len(cast(list[Any], ts)) != 2:
                    continue
                ts_list = cast(list[Any], ts)
                start, end = ts_list[0], ts_list[1]
                if start is None or end is None:
                    continue
                words.append(
                    TranscriptWordModel(text=str(c.get("text", "")).strip(), start=float(start), end=float(end))
                )
        language = out.get("language")
        return words, language if isinstance(language, str) else None

    @staticmethod
    def _json_object(payload: object) -> dict[str, Any]:
        if isinstance(payload, dict):
            return cast(dict[str, Any], payload)
        raise HTTPError(502, "Unexpected transcription response format")
