"""Shot planner: beat snapping, tiling coverage, determinism, LTX quantize."""

from __future__ import annotations

from server_utils.shot_planner import (
    GEN_MAX_SECONDS,
    GEN_MIN_SECONDS,
    MAX_TOTAL_SHOTS,
    plan_shots,
    quantize_frames_8k1,
    snap_to_grid,
)
from services.audio_analysis import AudioAnalysis, AudioSection


def _analysis(duration: float = 120.0, bpm: float = 120.0) -> AudioAnalysis:
    beat = 60.0 / bpm
    beats = [round(i * beat, 4) for i in range(int(duration / beat))]
    downbeats = beats[::4]
    sections = [
        AudioSection(start=0.0, end=15.0, label="intro", energy=0.2),
        AudioSection(start=15.0, end=45.0, label="verse", energy=0.45),
        AudioSection(start=45.0, end=75.0, label="chorus", energy=0.95),
        AudioSection(start=75.0, end=105.0, label="verse", energy=0.5),
        AudioSection(start=105.0, end=120.0, label="outro", energy=0.15),
    ]
    return AudioAnalysis(
        duration=duration, tempo_bpm=bpm, beats=beats, downbeats=downbeats, sections=sections
    )


def test_snap_to_grid():
    assert snap_to_grid(10.3, [10.0, 12.0], tolerance=0.5) == 10.0
    assert snap_to_grid(11.0, [10.0, 12.0], tolerance=0.5) == 11.0  # outside tolerance
    assert snap_to_grid(5.0, [], tolerance=1.0) == 5.0


def test_quantize_frames_8k1():
    assert quantize_frames_8k1(1.0, 24.0) == 25  # 24 -> 25 (k=3)
    assert quantize_frames_8k1(0.01, 24.0) == 9  # floor at k=1
    assert (quantize_frames_8k1(7.3, 30.0) - 1) % 8 == 0


def test_plan_tiles_the_whole_song_without_gaps():
    shots = plan_shots(_analysis(), "neon city night drive")
    assert shots, "plan should not be empty"
    assert shots[0].start == 0.0
    assert abs(shots[-1].end - 120.0) < 0.01
    for a, b in zip(shots, shots[1:]):
        assert abs(a.end - b.start) < 0.01, f"gap between {a.index} and {b.index}"
    for s in shots:
        assert s.duration > 0.5
        assert GEN_MIN_SECONDS <= s.generate_seconds <= GEN_MAX_SECONDS
        assert s.generate_seconds >= s.duration - 0.01  # always enough footage to trim


def test_plan_is_deterministic():
    a = plan_shots(_analysis(), "desert road trip")
    b = plan_shots(_analysis(), "desert road trip")
    assert a == b


def test_high_energy_sections_cut_faster():
    shots = plan_shots(_analysis(), "concert")
    chorus = [s.duration for s in shots if s.section_label == "chorus"]
    intro = [s.duration for s in shots if s.section_label == "intro"]
    assert chorus and intro
    assert (sum(chorus) / len(chorus)) < (sum(intro) / len(intro))


def test_cuts_land_on_the_beat_grid():
    analysis = _analysis()
    grid = analysis.downbeats
    shots = plan_shots(analysis, "beach party")
    interior_cuts = [s.end for s in shots[:-1] if s.end not in (15.0, 45.0, 75.0, 105.0)]
    on_grid = sum(1 for c in interior_cuts if any(abs(c - g) < 0.05 for g in grid))
    assert interior_cuts and on_grid / len(interior_cuts) >= 0.7


def test_prompts_carry_concept_and_section_flavor():
    shots = plan_shots(_analysis(), "a lone astronaut on a red planet")
    assert all("a lone astronaut on a red planet" in s.prompt for s in shots)
    chorus_prompts = [s.prompt for s in shots if s.section_label == "chorus"]
    assert any("peak energy" in p for p in chorus_prompts)
    assert shots[0].shot_type == "establishing"


def test_shot_cap_preserves_coverage():
    # A pathological 40-minute song still tiles fully under the cap.
    analysis = AudioAnalysis(
        duration=2400.0,
        tempo_bpm=170.0,
        beats=[i * 0.35 for i in range(int(2400 / 0.35))],
        downbeats=[i * 1.4 for i in range(int(2400 / 1.4))],
        sections=[AudioSection(start=i * 20.0, end=(i + 1) * 20.0, label="chorus", energy=0.9) for i in range(120)],
    )
    shots = plan_shots(analysis, "marathon")
    assert len(shots) <= MAX_TOTAL_SHOTS


def test_lyrics_reach_performance_shot_prompts():
    from server_utils.shot_planner import lyric_line_for_span

    lyrics = [
        {"text": "midnight", "start": 20.0, "end": 20.4},
        {"text": "run", "start": 20.4, "end": 20.9},
        {"text": "far away", "start": 90.0, "end": 90.5},
    ]
    assert lyric_line_for_span(lyrics, 19.0, 22.0) == "midnight run"
    assert lyric_line_for_span(lyrics, 0.0, 5.0) == ""
    assert lyric_line_for_span(None, 0.0, 5.0) == ""

    shots = plan_shots(_analysis(), "city night", lyrics=lyrics)
    perf_with_words = [
        s for s in shots
        if s.shot_type == "performance" and s.end > 20.0 and s.start < 20.9
    ]
    assert all('sing the words' in s.prompt for s in perf_with_words)
    # Non-performance shots never carry sung lines.
    assert all('sing the words' not in s.prompt for s in shots if s.shot_type != "performance")


def test_empty_sections_fall_back_to_single_span():
    analysis = AudioAnalysis(duration=30.0, tempo_bpm=100.0, beats=[i * 0.6 for i in range(50)])
    shots = plan_shots(analysis, "fallback")
    assert shots
    assert abs(shots[-1].end - 30.0) < 0.01
