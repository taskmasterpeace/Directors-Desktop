"""Deterministic music-video shot planning over an AudioAnalysis.

Pure functions — no I/O, no randomness — so plans are reproducible and unit
testable. The heuristic grammar gives every song a usable plan out of the box;
an LLM (or Claude via the agent bridge) can rewrite `prompt` fields afterwards
without touching the timing math.

Timing model:
- Shot boundaries live in song seconds and are snapped to beats (downbeats
  preferred) so cuts land on the music.
- Generation duration is a separate integer (Seedance accepts 4..15s); the
  assembler trims each rendered clip down to the exact fractional shot length.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from services.audio_analysis import AudioAnalysis

MIN_SHOT_SECONDS = 2.0
MAX_SHOT_SECONDS = 8.0
GEN_MIN_SECONDS = 4
GEN_MAX_SECONDS = 15
MAX_TOTAL_SHOTS = 60

_SECTION_FLAVOR = {
    "intro": "opening mood, slow reveal",
    "verse": "steady narrative moment, grounded framing",
    "chorus": "peak energy, dynamic camera movement",
    "bridge": "shifting tone, transitional imagery",
    "outro": "closing image, receding motion",
}

_TYPE_DESC = {
    "establishing": "Wide establishing shot",
    "performance": "Medium shot of the artist performing to camera, moving with the music",
    "broll": "Cinematic b-roll detail shot",
}


@dataclass(frozen=True)
class PlannedShot:
    index: int
    start: float  # song seconds, beat-aligned
    end: float
    section_label: str
    shot_type: str  # 'establishing' | 'performance' | 'broll'
    prompt: str
    generate_seconds: int  # what to ask the video model for (>= end - start)

    @property
    def duration(self) -> float:
        return self.end - self.start


def snap_to_grid(t: float, grid: list[float], tolerance: float) -> float:
    """Snap t to the nearest grid point within tolerance (else return t)."""
    if not grid:
        return t
    nearest = min(grid, key=lambda g: abs(g - t))
    return nearest if abs(nearest - t) <= tolerance else t


def quantize_frames_8k1(seconds: float, fps: float) -> int:
    """Nearest valid LTX frame count (8k+1) for a duration, minimum 9."""
    frames = max(1, round(seconds * fps))
    k = max(1, round((frames - 1) / 8))
    return 8 * k + 1


def _target_shot_seconds(energy: float) -> float:
    """High-energy music cuts faster. Linear map energy 0..1 -> max..min."""
    clamped = max(0.0, min(1.0, energy))
    return MAX_SHOT_SECONDS - clamped * (MAX_SHOT_SECONDS - MIN_SHOT_SECONDS)


def _shot_type(section_label: str, position_in_section: int) -> str:
    if position_in_section == 0:
        return "establishing"
    # Chorus leans on the performer; verses alternate performance/b-roll.
    if section_label == "chorus":
        return "performance" if position_in_section % 3 != 0 else "broll"
    return "performance" if position_in_section % 2 == 1 else "broll"


def build_prompt(
    concept: str,
    section_label: str,
    shot_type: str,
    energy: float,
    lyric_line: str = "",
) -> str:
    parts = [_TYPE_DESC.get(shot_type, _TYPE_DESC["broll"])]
    concept = concept.strip()
    if concept:
        parts.append(concept)
    parts.append(_SECTION_FLAVOR.get(section_label, _SECTION_FLAVOR["verse"]))
    if energy >= 0.66:
        parts.append("kinetic motion, high intensity")
    elif energy <= 0.33:
        parts.append("calm, lingering camera")
    prompt = ", ".join(parts)
    # Only performance shots mouth the words — burned-in lyric text on b-roll
    # reads as an artifact, and establishing shots have no performer close up.
    if lyric_line and shot_type == "performance":
        prompt += f'. They sing the words "{lyric_line}" in sync with the music'
    return prompt


def lyric_line_for_span(
    lyrics: list[dict[str, object]] | None, start: float, end: float, max_words: int = 12
) -> str:
    """The words sung inside [start, end), joined and capped for a prompt."""
    if not lyrics:
        return ""
    words: list[str] = []
    for w in lyrics:
        w_start = w.get("start")
        w_end = w.get("end")
        text = w.get("text")
        if not isinstance(w_start, (int, float)) or not isinstance(w_end, (int, float)):
            continue
        if not isinstance(text, str):
            continue
        if w_end > start and w_start < end:
            words.append(text.strip())
        if len(words) >= max_words:
            break
    return " ".join(w for w in words if w)


def plan_shots(
    analysis: AudioAnalysis,
    concept: str,
    *,
    min_shot: float = MIN_SHOT_SECONDS,
    max_shot: float = MAX_SHOT_SECONDS,
    lyrics: list[dict[str, object]] | None = None,
) -> list[PlannedShot]:
    """Tile the whole song with beat-aligned shots. Deterministic."""
    if analysis.duration <= 0:
        return []
    grid = analysis.downbeats if len(analysis.downbeats) >= 4 else analysis.beats
    beat_gap = analysis.duration
    if len(grid) >= 2:
        beat_gap = max(g2 - g1 for g1, g2 in zip(grid, grid[1:]))
    snap_tol = min(1.5, beat_gap / 2 + 0.01)

    sections = analysis.sections or []
    if not sections:
        from services.audio_analysis import AudioSection

        sections = [AudioSection(start=0.0, end=analysis.duration, label="verse", energy=0.5)]

    # Global cut list: section-by-section, energy-scaled lengths, beat-snapped.
    shots: list[PlannedShot] = []
    for section in sections:
        sec_start = max(0.0, min(section.start, analysis.duration))
        sec_end = max(sec_start, min(section.end, analysis.duration))
        if sec_end - sec_start < 0.75:
            continue
        target = max(min_shot, min(max_shot, _target_shot_seconds(section.energy)))
        count = max(1, round((sec_end - sec_start) / target))
        step = (sec_end - sec_start) / count
        position = 0
        cursor = sec_start
        while cursor < sec_end - 0.25:
            raw_end = min(sec_end, cursor + step)
            end = snap_to_grid(raw_end, grid, snap_tol)
            if end <= cursor + min_shot / 2:
                end = raw_end  # snap collapsed the shot — keep the raw cut
            end = min(end, sec_end)
            if sec_end - end < min_shot / 2:
                end = sec_end  # absorb the tail sliver into this shot
            shot_type = _shot_type(section.label, position)
            shots.append(
                PlannedShot(
                    index=len(shots),
                    start=cursor,
                    end=end,
                    section_label=section.label,
                    shot_type=shot_type,
                    prompt=build_prompt(
                        concept, section.label, shot_type, section.energy,
                        lyric_line=lyric_line_for_span(lyrics, cursor, end),
                    ),
                    generate_seconds=max(GEN_MIN_SECONDS, min(GEN_MAX_SECONDS, math.ceil(end - cursor))),
                )
            )
            cursor = end
            position += 1
        if len(shots) >= MAX_TOTAL_SHOTS:
            break

    # Hard cap: merge overflow into the final shot rather than dropping coverage.
    if len(shots) > MAX_TOTAL_SHOTS:
        head = shots[: MAX_TOTAL_SHOTS - 1]
        tail = shots[MAX_TOTAL_SHOTS - 1 :]
        last = tail[-1]
        merged = PlannedShot(
            index=len(head),
            start=tail[0].start,
            end=last.end,
            section_label=last.section_label,
            shot_type=last.shot_type,
            prompt=last.prompt,
            generate_seconds=max(GEN_MIN_SECONDS, min(GEN_MAX_SECONDS, math.ceil(last.end - tail[0].start))),
        )
        shots = head + [merged]
    return shots
