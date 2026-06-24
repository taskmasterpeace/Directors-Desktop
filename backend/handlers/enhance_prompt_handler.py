"""Prompt enhancement handler (Palette proxy or Gemini fallback).

Two modes:
- **Generate** (empty prompt): create a random cinematic prompt from scratch
- **Enhance** (has prompt): expand a rough prompt into a detailed, model-optimized one

System prompts are tailored per model family (LTX-Video, Seedance, image models).
"""
from __future__ import annotations

import logging
from threading import RLock
from typing import Any

from _routes._errors import HTTPError
from handlers.base import StateHandlerBase
from pydantic import BaseModel, Field, ValidationError
from services.interfaces import HTTPClient, HttpTimeoutError, JSONValue
from state.app_state_types import AppState

logger = logging.getLogger(__name__)

PALETTE_BASE_URL = "https://directorspal.com"  # live domain ("directorspalette.com" is dead)

# ---------------------------------------------------------------------------
# Gemini response parsing
# ---------------------------------------------------------------------------

class _GeminiPart(BaseModel):
    text: str


class _GeminiContent(BaseModel):
    parts: list[_GeminiPart] = Field(min_length=1)


class _GeminiCandidate(BaseModel):
    content: _GeminiContent


class _GeminiResponsePayload(BaseModel):
    candidates: list[_GeminiCandidate] = Field(min_length=1)


def _extract_gemini_text(payload: object) -> str:
    try:
        parsed = _GeminiResponsePayload.model_validate(payload)
    except ValidationError:
        raise HTTPError(500, "GEMINI_PARSE_ERROR")
    return parsed.candidates[0].content.parts[0].text


# ---------------------------------------------------------------------------
# Palette response parsing
# ---------------------------------------------------------------------------

class _PaletteResponsePayload(BaseModel):
    enhanced_prompt: str | None = Field(None, alias="enhanced_prompt")
    expanded_prompt: str | None = Field(None, alias="expandedPrompt")


class _OpenRouterMessage(BaseModel):
    content: str


class _OpenRouterChoice(BaseModel):
    message: _OpenRouterMessage


class _OpenRouterResponse(BaseModel):
    choices: list[_OpenRouterChoice] = Field(min_length=1)


def _extract_openrouter_text(payload: object) -> str:
    """Parse OpenAI-compatible chat completion response."""
    try:
        parsed = _OpenRouterResponse.model_validate(payload)
    except ValidationError:
        raise HTTPError(500, "OPENROUTER_PARSE_ERROR")
    text = parsed.choices[0].message.content.strip()
    if not text:
        raise HTTPError(500, "OPENROUTER_PARSE_ERROR")
    return text


def _extract_palette_text(payload: object) -> str:
    try:
        parsed = _PaletteResponsePayload.model_validate(payload)
    except ValidationError:
        raise HTTPError(500, "PALETTE_PARSE_ERROR")
    text = parsed.enhanced_prompt or parsed.expanded_prompt or ""
    if not text.strip():
        raise HTTPError(500, "PALETTE_PARSE_ERROR")
    return text.strip()


# ---------------------------------------------------------------------------
# Model-specific system prompts
# ---------------------------------------------------------------------------

_LTX_VIDEO_RULES = (
    "LTX-2.3 PROMPTING RULES (follow strictly):\n"
    "- Direct the scene like a director: specify spatial layout (left/right, "
    "foreground/background, facing toward/away)\n"
    "- Use specific action verbs for motion: who moves, what moves, how they move, "
    "what the camera does\n"
    "- Describe texture and material: fabric types, hair texture, surface finish, "
    "environmental wear\n"
    "- Avoid static photo-like descriptions — include movement to reduce frozen outputs\n"
    "- Specify camera motion explicitly: 'camera slowly pushes forward', "
    "'camera tracks right', 'camera holds steady'\n"
    "- Be specific about the number of subjects and their positions\n"
    "- Describe lighting: source direction, color temperature, quality (soft/hard)\n"
)

_LTX_I2V_EXTRA = (
    "- IMPORTANT for image-to-video: describe only motion and camera movement. "
    "Do NOT redescribe what is already visible in the image. Focus on what CHANGES: "
    "who moves, what moves, camera direction. Explicitly state if subjects should "
    "remain still. State 'no other people enter the frame' if the scene should stay "
    "contained.\n"
)

_SEEDANCE_RULES = (
    "SEEDANCE PROMPTING RULES:\n"
    "- Seedance excels at dance, human motion, and dynamic physical movement\n"
    "- Describe body movement in detail: gestures, dance styles, footwork\n"
    "- Specify camera angle and movement\n"
    "- Include environment and lighting details\n"
    "- Describe clothing and how it moves with the body\n"
)

_IMAGE_RULES = (
    "IMAGE GENERATION RULES:\n"
    "- Expand vague descriptions into specific, vivid details\n"
    "- Add lighting direction, color temperature, mood, and atmosphere\n"
    "- Describe texture, material, and surface detail precisely\n"
    "- Specify camera angle, lens characteristics (shallow DOF, wide angle, etc)\n"
    "- Include color palette and tonal mood\n"
)


def _get_system_prompt(*, model: str, mode: str, is_generate: bool, has_image: bool = False) -> str:
    """Build a system prompt tailored to the model, mode, and action."""
    is_image = mode in ("text-to-image", "t2i")
    is_i2v = mode in ("image-to-video", "i2v") or has_image
    is_ltx = model.startswith("ltx")
    is_seedance = "seedance" in model
    is_transcript = mode == "transcript"

    if is_transcript:
        action = (
            "The user message is a spoken-word excerpt from a video transcript "
            "(it may be wrapped in an instruction like 'Enhance this prompt:' — ignore that wrapper "
            "and treat the remaining text as the transcript excerpt). Convert the spoken content into "
            "a single vivid, cinematic visual generation prompt depicting what the words describe or "
            "evoke. Do not quote or transcribe the words — visualize them. Write only the prompt.\n\n"
        )
    elif is_generate and has_image:
        action = (
            "The user has provided a starting image. Analyze what you see in the image — "
            "the subjects, setting, lighting, mood, composition — and create a motion-aware "
            "prompt that will animate this image into a cinematic video. Focus on describing "
            "MOTION: what should move, how the camera should move, what stays still. "
            "Do NOT just describe the image statically. Direct the scene.\n\n"
        )
    elif is_generate:
        action = (
            "The user wants you to invent a creative, cinematic prompt from scratch. "
            "Come up with something visually stunning and unexpected. Vary your ideas — "
            "don't default to the same themes. Mix genres: sci-fi, nature, fashion, "
            "documentary, abstract, horror, comedy, noir, fantasy. "
            "Write only the prompt, nothing else.\n\n"
        )
    elif has_image:
        action = (
            "The user has provided a starting image and a rough prompt. Look at the image, "
            "understand the scene, and enhance the prompt into a detailed, motion-aware "
            "description. Keep the user's intent but add specificity about motion, camera, "
            "and what should happen in the scene.\n\n"
        )
    else:
        action = (
            "The user provides a rough prompt. Your job is to enhance it into a "
            "detailed, production-ready description while keeping the core intent.\n\n"
        )

    if is_image:
        rules = _IMAGE_RULES
    elif is_seedance:
        rules = _SEEDANCE_RULES
    elif is_ltx:
        rules = _LTX_VIDEO_RULES + (_LTX_I2V_EXTRA if is_i2v else "")
    else:
        rules = _LTX_VIDEO_RULES  # default to LTX rules for unknown video models

    return (
        f"You are a creative director's assistant specializing in AI "
        f"{'image' if is_image else 'video'} generation.\n\n"
        + action
        + rules
        + "\nOutput format:\n"
        "- Write 2-4 sentences max\n"
        "- Write ONLY the prompt, no labels, explanations, or quotation marks\n"
    )


_MAX_STORY_CONTEXT_CHARS = 6000


def _transcript_system_prompt(
    *, mode: str, full_story: str, lyrics: str, media_type: str, model: str
) -> str:
    """System prompt for turning a transcript excerpt into an image/video generation prompt.

    ``mode`` selects the context supplied alongside the excerpt:
    - ``story``  — the whole transcript (``full_story``) is supplied for narrative continuity.
    - ``music``  — the song's ``lyrics`` are supplied; the shot should match the song's energy
      and recurring visual motifs (music-video), not literally depict the words.
    - ``plain``  — no extra context.
    ``media_type`` ('image' | 'video') tailors the guidance.
    """
    is_video = media_type == "video"
    is_seedance = "seedance" in model
    medium = "short cinematic video" if is_video else "single still image"

    base = (
        "You are a creative director's assistant. Convert a spoken-word excerpt from a video "
        f"transcript into ONE vivid {medium} generation prompt. The user message holds the "
        "excerpt (ignore any 'Enhance this prompt:' wrapper). Visualize what the words describe "
        "or evoke — do NOT quote or transcribe them.\n\n"
    )

    context = ""
    if mode == "story" and full_story.strip():
        story = full_story.strip()
        if len(story) > _MAX_STORY_CONTEXT_CHARS:
            story = story[:_MAX_STORY_CONTEXT_CHARS] + " …"
        context = (
            "FULL STORY (the entire transcript, for context only):\n"
            f'"""\n{story}\n"""\n\n'
            "You are depicting ONE moment from THIS story. Keep the setting, characters, "
            "wardrobe, lighting, time of day, and visual continuity consistent with the whole "
            "story.\n\n"
        )
    elif mode == "music" and lyrics.strip():
        song = lyrics.strip()
        if len(song) > _MAX_STORY_CONTEXT_CHARS:
            song = song[:_MAX_STORY_CONTEXT_CHARS] + " …"
        context = (
            "SONG LYRICS (the whole song, for mood/context only):\n"
            f'"""\n{song}\n"""\n\n'
            "This is a MUSIC VIDEO shot for the selected lyric. Capture the song's energy, mood, "
            "and recurring visual motifs rather than literally illustrating the words. Bold, "
            "stylized, performance- or concept-driven imagery is welcome.\n\n"
        )

    guidance = (
        "Describe camera and motion — what moves and how the camera moves.\n\n"
        if is_video
        else "Describe a strong static composition, framing, lens, and lighting.\n\n"
    )

    if is_seedance:
        rules = _SEEDANCE_RULES
    elif is_video:
        rules = _LTX_VIDEO_RULES
    else:
        rules = _IMAGE_RULES

    return (
        base
        + context
        + guidance
        + rules
        + "\nOutput: ONLY the prompt, 2-4 sentences, no labels or quotation marks.\n"
    )


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------

class EnhancePromptHandler(StateHandlerBase):
    def __init__(self, state: AppState, lock: RLock, http: HTTPClient) -> None:
        super().__init__(state, lock)
        self._http = http

    def enhance(
        self, prompt: str, mode: str, model: str = "ltx-fast", *, image_path: str | None = None,
    ) -> dict[str, str]:
        """Enhance an existing prompt or generate one from scratch (empty prompt).

        When *image_path* is provided the handler asks the AI to describe the
        image and craft a motion-aware prompt based on what it sees.
        """
        palette_api_key = self.state.app_settings.palette_api_key
        if palette_api_key:
            return self._enhance_via_palette(prompt, palette_api_key, mode, model)

        gemini_api_key = self.state.app_settings.gemini_api_key
        if gemini_api_key:
            return self._enhance_via_gemini(prompt, mode, model, gemini_api_key, image_path=image_path)

        openrouter_api_key = self.state.app_settings.openrouter_api_key
        if openrouter_api_key:
            return self._enhance_via_openrouter(prompt, mode, model, openrouter_api_key, image_path=image_path)

        raise HTTPError(400, "NO_AI_SERVICE_CONFIGURED")

    def transcript_to_prompt(
        self,
        text: str,
        target_model: str = "ltx-fast",
        *,
        full_story: str | None = None,
        story_aware: bool = False,
        media_type: str = "image",
        mode: str | None = None,
        lyrics: str | None = None,
    ) -> dict[str, str]:
        """Convert a spoken transcript excerpt into a generation prompt (Phase 3 bridge).

        ``mode`` ('story' | 'music' | 'plain') selects the context: 'story' uses the whole
        transcript (``full_story``); 'music' uses the song ``lyrics`` for a music-video shot;
        'plain' uses none. ``story_aware`` is the legacy boolean (True→'story', False→'plain')
        used when ``mode`` is omitted. ``media_type`` ('image' | 'video') tailors the guidance.
        Skips Palette (no transcript mode) and goes straight to Gemini → OpenRouter.
        """
        excerpt = text.strip()
        if not excerpt:
            raise HTTPError(400, "EMPTY_TRANSCRIPT_SPAN")

        resolved_mode = mode or ("story" if story_aware else "plain")
        system_text = _transcript_system_prompt(
            mode=resolved_mode,
            full_story=full_story or "",
            lyrics=lyrics or "",
            media_type=media_type,
            model=target_model,
        )

        gemini_api_key = self.state.app_settings.gemini_api_key
        if gemini_api_key:
            return self._enhance_via_gemini(
                excerpt, "transcript", target_model, gemini_api_key, system_text_override=system_text
            )

        openrouter_api_key = self.state.app_settings.openrouter_api_key
        if openrouter_api_key:
            return self._enhance_via_openrouter(
                excerpt, "transcript", target_model, openrouter_api_key, system_text_override=system_text
            )

        raise HTTPError(400, "NO_AI_SERVICE_CONFIGURED")

    # --- Provider: Palette API ---

    def enhance_i2v_motion(self, image_path: str) -> str:
        """Generate an i2v motion prompt (used by queue worker for extend chains)."""
        result = self.enhance("", "image-to-video", "ltx-fast")
        return result.get("enhancedPrompt", "")

    def _enhance_via_palette(
        self, prompt: str, api_key: str, mode: str = "text-to-video", model: str = "ltx-fast",
    ) -> dict[str, str]:
        """Proxy to Director's Palette /api/prompt-expander endpoint."""
        url = f"{PALETTE_BASE_URL}/api/prompt-expander"
        payload: dict[str, Any] = {
            "prompt": prompt,
            "level": "2x",
            "mode": mode,
            "model": model,
        }
        if not prompt.strip():
            payload["action"] = "generate"

        try:
            response = self._http.post(
                url,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_key}",
                },
                json_payload=payload,
                timeout=30,
            )
        except HttpTimeoutError as exc:
            raise HTTPError(504, "Palette prompt expander request timed out") from exc
        except Exception as exc:
            raise HTTPError(500, str(exc)) from exc

        if response.status_code != 200:
            # Fall through to Gemini if Palette can't handle generate mode
            gemini_api_key = self.state.app_settings.gemini_api_key
            if gemini_api_key:
                return self._enhance_via_gemini(prompt, mode, model, gemini_api_key)
            raise HTTPError(response.status_code, f"Palette API error: {response.text}")

        enhanced = _extract_palette_text(response.json())
        return {"enhancedPrompt": enhanced.strip()}

    # --- Provider: Gemini ---

    def _enhance_via_gemini(
        self,
        prompt: str,
        mode: str,
        model: str,
        gemini_api_key: str,
        *,
        image_path: str | None = None,
        system_text_override: str | None = None,
    ) -> dict[str, str]:
        """Enhance or generate prompt using Gemini API (supports multimodal with image)."""
        has_image = bool(image_path)
        is_generate = not prompt.strip()
        system_text = system_text_override or _get_system_prompt(
            model=model, mode=mode, is_generate=is_generate, has_image=has_image,
        )

        # Build user content parts (text + optional image)
        user_parts: list[dict[str, JSONValue]] = []

        if has_image and image_path:
            image_b64 = self._read_image_as_base64(image_path)
            if image_b64:
                inline: dict[str, JSONValue] = {"mime_type": "image/jpeg", "data": image_b64}
                user_parts.append({"inline_data": inline})

        if is_generate and has_image:
            user_parts.append({"text": "Look at this image and create a cinematic motion prompt for it."})
        elif is_generate:
            user_parts.append({"text": "Generate a creative, cinematic prompt."})
        elif has_image:
            user_parts.append({"text": f"Look at this image and enhance this prompt for it: {prompt}"})
        else:
            user_parts.append({"text": f"Enhance this prompt: {prompt}"})

        gemini_url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
        parts_list: JSONValue = user_parts  # type: ignore[assignment]
        gemini_payload: dict[str, JSONValue] = {
            "contents": [{"role": "user", "parts": parts_list}],
            "systemInstruction": {"parts": [{"text": system_text}]},
            "generationConfig": {
                "temperature": 0.9 if is_generate else 0.7,
                "maxOutputTokens": 256,
            },
        }

        try:
            response = self._http.post(
                gemini_url,
                headers={"Content-Type": "application/json", "x-goog-api-key": gemini_api_key},
                json_payload=gemini_payload,
                timeout=30,
            )
        except HttpTimeoutError as exc:
            raise HTTPError(504, "Gemini API request timed out") from exc
        except Exception as exc:
            raise HTTPError(500, str(exc)) from exc

        if response.status_code != 200:
            raise HTTPError(response.status_code, f"Gemini API error: {response.text}")

        enhanced = _extract_gemini_text(response.json()).strip()
        return {"enhancedPrompt": enhanced}

    # --- Provider: OpenRouter (OpenAI-compatible) ---

    def _enhance_via_openrouter(
        self,
        prompt: str,
        mode: str,
        model: str,
        openrouter_api_key: str,
        *,
        image_path: str | None = None,
        system_text_override: str | None = None,
    ) -> dict[str, str]:
        """Enhance or generate prompt using OpenRouter (OpenAI chat completions API)."""
        has_image = bool(image_path)
        is_generate = not prompt.strip()
        system_text = system_text_override or _get_system_prompt(
            model=model, mode=mode, is_generate=is_generate, has_image=has_image,
        )

        # Build user message content (text + optional image)
        content: list[dict[str, JSONValue]] = []

        if has_image and image_path:
            image_b64 = self._read_image_as_base64(image_path)
            if image_b64:
                content.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"},
                })

        if is_generate and has_image:
            content.append({"type": "text", "text": "Look at this image and create a cinematic motion prompt for it."})
        elif is_generate:
            content.append({"type": "text", "text": "Generate a creative, cinematic prompt."})
        elif has_image:
            content.append({"type": "text", "text": f"Look at this image and enhance this prompt for it: {prompt}"})
        else:
            content.append({"type": "text", "text": f"Enhance this prompt: {prompt}"})

        # Gemini 2.5 Flash via OpenRouter (it is multimodal, so it covers the image case too).
        # NB: the old "google/gemini-2.0-flash-001" id was de-listed from OpenRouter (404).
        or_model = "google/gemini-2.5-flash"

        user_msg_content: JSONValue = content  # type: ignore[assignment]
        messages: JSONValue = [
            {"role": "system", "content": system_text},
            {"role": "user", "content": user_msg_content},
        ]
        openrouter_payload: dict[str, JSONValue] = {
            "model": or_model,
            "messages": messages,
            "temperature": 0.9 if is_generate else 0.7,
            "max_tokens": 256,
        }

        try:
            response = self._http.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {openrouter_api_key}",
                },
                json_payload=openrouter_payload,
                timeout=30,
            )
        except HttpTimeoutError as exc:
            raise HTTPError(504, "OpenRouter request timed out") from exc
        except Exception as exc:
            raise HTTPError(500, str(exc)) from exc

        if response.status_code != 200:
            raise HTTPError(response.status_code, f"OpenRouter API error: {response.text}")

        enhanced = _extract_openrouter_text(response.json())
        return {"enhancedPrompt": enhanced}

    def caption_image_for_video(
        self,
        image_path: str,
        target_model: str,
    ) -> str:
        """Generate a short video animation prompt describing motion/camera for an image.

        Uses OpenRouter with the configured vision_captioner_model. System prompt
        is tailored per target video model (LTX vs Seedance).
        """
        openrouter_api_key = self.state.app_settings.openrouter_api_key
        if not openrouter_api_key:
            raise HTTPError(400, "OpenRouter API key is required for image captioning")

        image_b64 = self._read_image_as_base64(image_path)
        if not image_b64:
            raise HTTPError(400, f"Could not read image: {image_path}")

        captioner_model = self.state.app_settings.vision_captioner_model

        if target_model == "ltx-fast":
            system_text = (
                "You are writing a short video animation prompt. Look at the image "
                "and write 1-2 sentences (under 50 words) describing the motion, "
                "camera movement, and action that should happen in the video. Use "
                "cinematic language (e.g., dolly in, pan, push, tilt, slow reveal). "
                "Do NOT describe what the image shows — describe what should move "
                "and how the camera should behave."
            )
        else:  # seedance-1.5-pro
            system_text = (
                "You are writing a concise video prompt for the Seedance model. "
                "Look at the image and write under 40 words describing the subject "
                "motion and camera direction. Be specific about what moves and where "
                "the camera goes. Do not describe the scene itself."
            )

        user_content: list[dict[str, JSONValue]] = [
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"},
            },
            {"type": "text", "text": "Write the video prompt for this image."},
        ]

        messages: JSONValue = [
            {"role": "system", "content": system_text},
            {"role": "user", "content": user_content},  # type: ignore[dict-item]
        ]

        payload: dict[str, JSONValue] = {
            "model": captioner_model,
            "messages": messages,
            "temperature": 0.6,
            "max_tokens": 120,
        }

        try:
            response = self._http.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {openrouter_api_key}",
                },
                json_payload=payload,
                timeout=30,
            )
        except HttpTimeoutError as exc:
            raise HTTPError(504, "OpenRouter caption request timed out") from exc
        except Exception as exc:
            raise HTTPError(500, str(exc)) from exc

        if response.status_code != 200:
            raise HTTPError(response.status_code, f"OpenRouter caption error: {response.text}")

        caption = _extract_openrouter_text(response.json())
        return caption.strip()

    @staticmethod
    def _read_image_as_base64(image_path: str) -> str | None:
        """Read an image file and return base64-encoded string."""
        import base64
        from pathlib import Path
        p = Path(image_path)
        if not p.exists() or not p.is_file():
            return None
        try:
            raw = p.read_bytes()
            return base64.b64encode(raw).decode("ascii")
        except Exception:
            return None
