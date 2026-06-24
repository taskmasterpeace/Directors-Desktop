"""LIVE practice: story-aware transcript->prompt via OpenRouter (the handler's model).

Mirrors handlers.enhance_prompt_handler._transcript_system_prompt exactly (inlined to avoid
the handlers-package import cycle when run standalone), then calls the real OpenRouter model
so we can eyeball prompt quality: story-aware vs plain, image vs video.
Reads OPENROUTER_API_KEY from directors-palette-v2/.env.local (never printed).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.http_client.http_client_impl import HTTPClientImpl

_MAX_STORY = 6000
_OR_MODEL = "google/gemini-2.5-flash"

# --- inlined copy of _transcript_system_prompt (kept identical to the handler) ---
_IMG = "Describe a strong static composition, framing, lens, and lighting.\n\n"
_VID = "Describe camera and motion — what moves and how the camera moves.\n\n"


def system_prompt(*, story_aware: bool, full_story: str, media_type: str, model: str) -> str:
    is_video = media_type == "video"
    medium = "short cinematic video" if is_video else "single still image"
    base = (
        "You are a creative director's assistant. Convert a spoken-word excerpt from a video "
        f"transcript into ONE vivid {medium} generation prompt. The user message holds the "
        "excerpt (ignore any 'Enhance this prompt:' wrapper). Visualize what the words describe "
        "or evoke — do NOT quote or transcribe them.\n\n"
    )
    context = ""
    if story_aware and full_story.strip():
        story = full_story.strip()
        if len(story) > _MAX_STORY:
            story = story[:_MAX_STORY] + " …"
        context = (
            "FULL STORY (the entire transcript, for context only):\n"
            f'"""\n{story}\n"""\n\n'
            "You are depicting ONE moment from THIS story. Keep the setting, characters, "
            "wardrobe, lighting, time of day, and visual continuity consistent.\n\n"
        )
    guidance = _VID if is_video else _IMG
    return base + context + guidance + "Output: ONLY the prompt, 2-4 sentences."


def _read_key() -> str:
    env = Path(r"D:/git/directors-palette-v2/.env.local")
    for line in env.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("OPENROUTER_API_KEY"):
            return line.partition("=")[2].strip().strip('"').strip("'")
    raise SystemExit("OPENROUTER_API_KEY not found")


def run(http, key, *, story_aware, media_type, story, excerpt) -> str:
    sys_text = system_prompt(story_aware=story_aware, full_story=story, media_type=media_type, model="seedance-2.0")
    resp = http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json_payload={
            "model": _OR_MODEL,
            "messages": [{"role": "system", "content": sys_text}, {"role": "user", "content": f"Enhance this prompt: {excerpt}"}],
            "temperature": 0.7,
            "max_tokens": 256,
        },
        timeout=60,
    )
    if resp.status_code != 200:
        return f"<HTTP {resp.status_code}: {resp.text[:200]}>"
    return resp.json()["choices"][0]["message"]["content"].strip()


def main() -> None:
    key = _read_key()
    print(f"OpenRouter key loaded (len={len(key)})")
    http = HTTPClientImpl()
    story = (
        "Mara walked the rain-soaked neon streets of Neo-Kyoto, hunting the data-ghost that "
        "killed her partner. Red umbrellas drifted past flickering holograms. She traced its "
        "signal to an abandoned arcade, its dead machines humming in the dark. The ghost was "
        "waiting, a shimmer of broken light between the cabinets."
    )
    excerpt = "she traced its signal to an abandoned arcade"

    print("\n=== STORY-AWARE · IMAGE ===")
    print(run(http, key, story_aware=True, media_type="image", story=story, excerpt=excerpt))
    print("\n=== STORY-AWARE · VIDEO ===")
    print(run(http, key, story_aware=True, media_type="video", story=story, excerpt=excerpt))
    print("\n=== PLAIN · IMAGE (no story context) ===")
    print(run(http, key, story_aware=False, media_type="image", story=story, excerpt=excerpt))


if __name__ == "__main__":
    main()
