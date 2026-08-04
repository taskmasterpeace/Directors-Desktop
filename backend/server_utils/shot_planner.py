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
import re
from dataclasses import dataclass

from services.audio_analysis import AudioAnalysis

MIN_SHOT_SECONDS = 2.0
MAX_SHOT_SECONDS = 8.0
GEN_MIN_SECONDS = 4
GEN_MAX_SECONDS = 15
MAX_TOTAL_SHOTS = 60

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")

_SECTION_FLAVOR = {
    "intro": "opening mood, slow reveal",
    "verse": "steady narrative moment, grounded framing",
    "chorus": "peak energy, dynamic camera movement",
    "bridge": "shifting tone, transitional imagery",
    "outro": "closing image, receding motion",
}

_TYPE_DESC = {
    "establishing": "Wide establishing shot",
    "broll": "Cinematic b-roll detail shot",
}
_DEFAULT_ARTIST = "the artist"

# Performance coverage rotates like a real music video instead of repeating
# one setup (#59). Every variant keeps the face large — that is what makes
# lip-sync read. Selected deterministically by shot index (and energy bumps
# the pick so choruses favor the punchier setups).
_PERFORMANCE_FRAMINGS = (
    "Medium shot of {artist} performing to camera, moving with the music, framed from the waist up so the face stays large",
    "Close-up of {artist} singing straight into the lens, face filling the frame, shallow depth of field",
    "Slow push-in on {artist} performing, chest-up framing, the face growing larger through the shot",
    "Low-angle hero shot of {artist} performing, framed waist-up, face prominent against the sky of the scene",
    "Three-quarter profile of {artist} singing, head and shoulders framing, face large and lit",
    "Handheld medium close-up of {artist} performing with energy, framed chest-up so the mouth stays clear",
)


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
    artist_name: str = "",
    story_beat: str = "",
    director_style: str = "",
    wardrobe_look: str = "",
    variant_seed: int = 0,
) -> str:
    if shot_type == "performance":
        pick = (variant_seed + (2 if energy >= 0.66 else 0)) % len(_PERFORMANCE_FRAMINGS)
        desc = _PERFORMANCE_FRAMINGS[pick].replace(
            "{artist}", artist_name.strip() or _DEFAULT_ARTIST
        )
    else:
        desc = _TYPE_DESC.get(shot_type, _TYPE_DESC["broll"]).replace(
            "{artist}", artist_name.strip() or _DEFAULT_ARTIST
        )
    parts = [desc]
    concept = concept.strip()
    if concept:
        parts.append(concept)
    parts.append(_SECTION_FLAVOR.get(section_label, _SECTION_FLAVOR["verse"]))
    if energy >= 0.66:
        parts.append("kinetic motion, high intensity")
    elif energy <= 0.33:
        parts.append("calm, lingering camera")
    if director_style:
        parts.append(director_style)
    if wardrobe_look and shot_type != "broll":
        # The performer's look reads on people shots; pure b-roll has no one
        # to dress and the text would leak wardrobe into empty scenery.
        parts.append(f"{artist_name.strip() or _DEFAULT_ARTIST} wearing {wardrobe_look}")
    prompt = ", ".join(parts)
    # Narrative shots (establishing/b-roll) carry the story; the performer
    # carries the words. This is how a video tells a story ACROSS the song
    # instead of being 40 disconnected performance clips.
    if story_beat and shot_type != "performance":
        prompt += f". Story beat: {story_beat}"
    if lyric_line and shot_type == "performance":
        prompt += f'. They sing the words "{lyric_line}" in sync with the music'
    return prompt


def wardrobe_for_section(section_label: str, wardrobe: list[str]) -> str:
    """Map looks to sections the music-video way: look A carries the story
    (verses/intro/outro), look B owns the chorus, look C takes the bridge."""
    looks = [w.strip() for w in wardrobe if w.strip()]
    if not looks:
        return ""
    if section_label == "chorus" and len(looks) >= 2:
        return looks[1]
    if section_label == "bridge" and len(looks) >= 3:
        return looks[2]
    return looks[0]


def distribute_treatment(section_count: int, chorus_flags: list[bool], treatment: str) -> list[str]:
    """Spread the treatment's sentences across NON-chorus sections, in order.

    Chorus sections get "" (they are the performance hook); narrative sections
    receive the story's sentences evenly so the arc progresses start->finish.
    """
    sentences = [t.strip() for t in _SENTENCE_SPLIT.split(treatment.strip()) if t.strip()]
    beats: list[str] = [""] * section_count
    narrative = [i for i in range(section_count) if not (i < len(chorus_flags) and chorus_flags[i])]
    if not sentences or not narrative:
        return beats
    for slot_pos, section_idx in enumerate(narrative):
        # Even mapping: narrative section k of N reads sentence floor(k*S/N) —
        # early sections get the setup, late sections get the payoff.
        beats[section_idx] = sentences[min(len(sentences) - 1, slot_pos * len(sentences) // len(narrative))]
    return beats


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
    treatment: str = "",
    artist_name: str = "",
    director_style: str = "",
    wardrobe: list[str] | None = None,
) -> list[PlannedShot]:
    """Tile the whole song with beat-aligned shots. Deterministic."""
    if analysis.duration <= 0:
        return []
    grid = analysis.downbeats if len(analysis.downbeats) >= 4 else analysis.beats
    beat_gap = analysis.duration
    if len(grid) >= 2:
        beat_gap = max(g2 - g1 for g1, g2 in zip(grid, grid[1:]))
    snap_tol = min(1.5, beat_gap / 2 + 0.01)

    from services.audio_analysis import AudioSection

    # Sanitize sections: clamp to the song, drop unusable slivers. If nothing
    # usable survives (degenerate segmentation), treat the whole song as one
    # span — the planner must always cover the full runtime.
    usable: list[AudioSection] = []
    for section in analysis.sections or []:
        sec_start = max(0.0, min(section.start, analysis.duration))
        sec_end = max(sec_start, min(section.end, analysis.duration))
        if sec_end - sec_start >= 0.75:
            usable.append(AudioSection(start=sec_start, end=sec_end, label=section.label, energy=section.energy))
    # Force contiguity from 0: any hole between sections (imperfect
    # segmentation) would become missing picture and permanent A/V drift
    # after assembly. Each section starts where the previous ended.
    contiguous: list[AudioSection] = []
    cursor_edge = 0.0
    for section in usable:
        end = max(cursor_edge, min(section.end, analysis.duration))
        if end - cursor_edge < 0.05:
            continue
        contiguous.append(
            AudioSection(start=cursor_edge, end=end, label=section.label, energy=section.energy)
        )
        cursor_edge = end
    if not contiguous:
        contiguous = [AudioSection(start=0.0, end=analysis.duration, label="verse", energy=0.5)]
    sections = contiguous
    story_beats = distribute_treatment(
        len(sections), [sec.label == "chorus" for sec in sections], treatment
    )

    # Cap-aware pacing: with at most MAX_TOTAL_SHOTS shots, average shot length
    # must be at least duration/budget or the tail of the song goes uncovered
    # (energy-0.9 four-minute songs used to lose their final quarter). The
    # budget discounts per-section count rounding (up to half a shot each) and
    # the floor never exceeds what one generation can hold.
    budget = max(MAX_TOTAL_SHOTS - (len(sections) + 1) // 2, MAX_TOTAL_SHOTS // 2)
    min_shot = max(min_shot, min(analysis.duration / budget, float(GEN_MAX_SECONDS)))

    # Global cut list: section-by-section, energy-scaled lengths, beat-snapped.
    def _tile(floor: float) -> list[PlannedShot]:
        tiled: list[PlannedShot] = []
        for section in sections:
            sec_start = section.start
            sec_end = section.end
            target = max(floor, min(max_shot, _target_shot_seconds(section.energy)))
            count = max(1, round((sec_end - sec_start) / target))
            step = (sec_end - sec_start) / count
            position = 0
            cursor = sec_start
            while cursor < sec_end - 0.25:
                raw_end = min(sec_end, cursor + step)
                end = snap_to_grid(raw_end, grid, snap_tol)
                if end <= cursor + floor / 2:
                    end = raw_end  # snap collapsed the shot — keep the raw cut
                end = min(end, sec_end)
                if sec_end - end < floor / 2:
                    end = sec_end  # absorb the tail sliver into this shot
                # One generation holds at most GEN_MAX seconds — never plan a
                # window the model can't fill (it would freeze-frame the excess).
                end = min(end, cursor + GEN_MAX_SECONDS)
                shot_type = _shot_type(section.label, position)
                tiled.append(
                    PlannedShot(
                        index=len(tiled),
                        start=cursor,
                        end=end,
                        section_label=section.label,
                        shot_type=shot_type,
                        prompt=build_prompt(
                            concept, section.label, shot_type, section.energy,
                            lyric_line=lyric_line_for_span(lyrics, cursor, end),
                            artist_name=artist_name,
                            story_beat=story_beats[sections.index(section)],
                            director_style=director_style,
                            wardrobe_look=wardrobe_for_section(section.label, wardrobe or []),
                            variant_seed=len(tiled),
                        ),
                        generate_seconds=max(GEN_MIN_SECONDS, min(GEN_MAX_SECONDS, math.ceil(end - cursor))),
                    )
                )
                cursor = end
                position += 1
            if len(tiled) >= MAX_TOTAL_SHOTS:
                break
        return tiled

    # Beat-snapping pulls cuts to the grid line below, shrinking shots past the
    # pacing floor — a single pass can hit the cap short of the song's end.
    # Escalate the floor until the tiling fits (or the physical GEN_MAX limit).
    def _needs_longer_shots(tiled: list[PlannedShot]) -> bool:
        if not tiled:
            return False
        # Capped and short of the song's end — coverage lost outright.
        if len(tiled) >= MAX_TOTAL_SHOTS and tiled[-1].end < analysis.duration - 0.25:
            return True
        # Over the cap with an overflow span no single generation can hold —
        # the merge fallback would silently truncate coverage.
        if len(tiled) > MAX_TOTAL_SHOTS:
            overflow_span = tiled[-1].end - tiled[MAX_TOTAL_SHOTS - 1].start
            if overflow_span > GEN_MAX_SECONDS + 1e-6:
                return True
        return False

    shots = _tile(min_shot)
    attempts = 0
    while attempts < 4 and min_shot < GEN_MAX_SECONDS and _needs_longer_shots(shots):
        min_shot = min(min_shot * 1.35, float(GEN_MAX_SECONDS))
        shots = _tile(min_shot)
        attempts += 1

    # Tail fill: dropped sliver sections (or a cap break) can leave the song's
    # ending uncovered — a video that stops while the song plays on. Tile the
    # remainder with plain shots until covered or the cap is hit.
    tail_section = sections[-1]
    tail_position = 1  # never 'establishing' mid-song
    while shots and shots[-1].end < analysis.duration - 0.25 and len(shots) < MAX_TOTAL_SHOTS:
        start = shots[-1].end
        end = min(analysis.duration, start + max_shot)
        shot_type = _shot_type(tail_section.label, tail_position)
        shots.append(
            PlannedShot(
                index=len(shots),
                start=start,
                end=end,
                section_label=tail_section.label,
                shot_type=shot_type,
                prompt=build_prompt(
                    concept, tail_section.label, shot_type, tail_section.energy,
                    lyric_line=lyric_line_for_span(lyrics, start, end),
                    artist_name=artist_name,
                    story_beat=story_beats[-1] if story_beats else "",
                    director_style=director_style,
                    wardrobe_look=wardrobe_for_section(tail_section.label, wardrobe or []),
                    variant_seed=len(shots),
                ),
                generate_seconds=max(GEN_MIN_SECONDS, min(GEN_MAX_SECONDS, math.ceil(end - start))),
            )
        )
        tail_position += 1

    # At the cap with song left over: extend the final shot to its physical
    # limit; anything beyond cap * GEN_MAX truncates EXPLICITLY (the video
    # ends early) rather than freezing frames.
    if (
        shots
        and len(shots) >= MAX_TOTAL_SHOTS
        and shots[-1].end < analysis.duration - 0.25
    ):
        last = shots[-1]
        new_end = min(analysis.duration, last.start + GEN_MAX_SECONDS)
        if new_end > last.end:
            shots[-1] = PlannedShot(
                index=last.index,
                start=last.start,
                end=new_end,
                section_label=last.section_label,
                shot_type=last.shot_type,
                prompt=last.prompt,
                generate_seconds=max(GEN_MIN_SECONDS, min(GEN_MAX_SECONDS, math.ceil(new_end - last.start))),
            )

    # Sub-threshold residue (<0.25s): stretch the final shot over it.
    if shots and 0.001 < analysis.duration - shots[-1].end <= 0.25:
        last = shots[-1]
        shots[-1] = PlannedShot(
            index=last.index,
            start=last.start,
            end=analysis.duration,
            section_label=last.section_label,
            shot_type=last.shot_type,
            prompt=last.prompt,
            generate_seconds=max(
                GEN_MIN_SECONDS, min(GEN_MAX_SECONDS, math.ceil(analysis.duration - last.start))
            ),
        )

    # Hard cap: merge overflow into one final shot — but never promise more
    # coverage than one generation can physically hold (GEN_MAX). Beyond that
    # the plan truncates EXPLICITLY (video ends early) instead of freezing.
    if len(shots) > MAX_TOTAL_SHOTS:
        head = shots[: MAX_TOTAL_SHOTS - 1]
        tail = shots[MAX_TOTAL_SHOTS - 1 :]
        merged_start = tail[0].start
        merged_end = min(tail[-1].end, merged_start + GEN_MAX_SECONDS)
        last = tail[-1]
        merged = PlannedShot(
            index=len(head),
            start=merged_start,
            end=merged_end,
            section_label=last.section_label,
            shot_type=last.shot_type,
            prompt=last.prompt,
            generate_seconds=max(GEN_MIN_SECONDS, min(GEN_MAX_SECONDS, math.ceil(merged_end - merged_start))),
        )
        shots = head + [merged]
    return shots


_DRAFT_STOPWORDS = frozenset(
    "the a an and or but of to in on at for with is are was were be been i you he she it we "
    "they me my your his her its our their this that these those so no not do does did dont "
    "cant wont im its na la oh yeah uh huh got get like just".split()
)


def draft_concept(
    tempo_bpm: float, avg_energy: float, lyric_words: list[str]
) -> str:
    """#72 'Surprise me': when the creator gives no concept, draft one from the
    song itself. Pure + deterministic — same song, same concept."""
    if tempo_bpm >= 132:
        pace, world = "high-velocity", "strobing warehouse party, bodies in motion"
    elif tempo_bpm >= 104:
        pace, world = "confident mid-tempo", "neon-lit city streets after rain"
    elif tempo_bpm >= 84:
        pace, world = "head-nod groove", "golden-hour rooftops over the city"
    else:
        pace, world = "slow-burn", "moody late-night interiors, haze and practical lights"
    mood = "peaking hard" if avg_energy >= 0.66 else ("building steadily" if avg_energy >= 0.33 else "kept intimate")

    counts: dict[str, int] = {}
    for raw in lyric_words:
        word = "".join(ch for ch in raw.lower() if ch.isalpha())
        if len(word) < 3 or word in _DRAFT_STOPWORDS:
            continue
        counts[word] = counts.get(word, 0) + 1
    top = [w for w, _ in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:3]]
    if top:
        themes = ", ".join(f"'{w}'" for w in top)
        return f"A {pace} music video set in {world}, energy {mood}, themes of {themes}"
    return f"A {pace} instrumental visual set in {world}, energy {mood}"
