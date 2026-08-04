"""Shot planner: beat snapping, tiling coverage, determinism, LTX quantize."""

from __future__ import annotations

from server_utils.shot_planner import (
    GEN_MAX_SECONDS,
    GEN_MIN_SECONDS,
    MAX_TOTAL_SHOTS,
    draft_concept,
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
    # A pathological 40-minute song still respects the cap; coverage is
    # physically limited to cap * MAX_SHOT there, and truncation is explicit
    # (every shot's window fits its generation).
    analysis = AudioAnalysis(
        duration=2400.0,
        tempo_bpm=170.0,
        beats=[i * 0.35 for i in range(int(2400 / 0.35))],
        downbeats=[i * 1.4 for i in range(int(2400 / 1.4))],
        sections=[AudioSection(start=i * 20.0, end=(i + 1) * 20.0, label="chorus", energy=0.9) for i in range(120)],
    )
    shots = plan_shots(analysis, "marathon")
    assert len(shots) <= MAX_TOTAL_SHOTS
    for s in shots:
        assert s.end - s.start <= s.generate_seconds + 1e-6


def test_ordinary_loud_song_is_fully_covered_under_the_cap():
    # Review-found: a routine 4-minute banger (energy ~0.9 everywhere) used to
    # burn all 60 shots by ~177s and silently drop the final quarter.
    beat = 60.0 / 128
    duration = 240.0
    beats = [round(i * beat, 4) for i in range(int(duration / beat))]
    analysis = AudioAnalysis(
        duration=duration,
        tempo_bpm=128.0,
        beats=beats,
        downbeats=beats[::4],
        sections=[
            AudioSection(start=i * 30.0, end=(i + 1) * 30.0, label="chorus", energy=0.9)
            for i in range(8)
        ],
    )
    shots = plan_shots(analysis, "banger")
    assert len(shots) <= MAX_TOTAL_SHOTS
    assert abs(shots[-1].end - duration) < 0.01, "the whole song must be covered"
    for a, b in zip(shots, shots[1:]):
        assert abs(a.end - b.start) < 0.01


def test_sections_with_holes_are_made_contiguous():
    # Review-found: analyzer span-drops could emit sections with a gap between
    # them; the plan must never contain that hole (it becomes A/V desync).
    analysis = AudioAnalysis(
        duration=30.0,
        tempo_bpm=120.0,
        beats=[i * 0.5 for i in range(60)],
        sections=[
            AudioSection(start=0.0, end=20.0, label="verse", energy=0.5),
            AudioSection(start=20.5, end=30.0, label="chorus", energy=0.9),  # 0.5s hole
        ],
    )
    shots = plan_shots(analysis, "no holes")
    for a, b in zip(shots, shots[1:]):
        assert abs(a.end - b.start) < 0.01, f"hole between {a.index} and {b.index}"
    assert abs(shots[-1].end - 30.0) < 0.01


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


def test_tiny_trailing_sections_never_leave_a_tail_gap():
    # Fuzz-found: trailing sections under 0.75s used to be skipped outright,
    # ending the video before the song. The tail fill must cover to the end.
    analysis = AudioAnalysis(
        duration=30.0,
        tempo_bpm=120.0,
        beats=[i * 0.5 for i in range(60)],
        downbeats=[i * 2.0 for i in range(15)],
        sections=[
            AudioSection(start=0.0, end=28.9, label="verse", energy=0.5),
            AudioSection(start=28.9, end=29.5, label="outro", energy=0.1),  # sliver
            AudioSection(start=29.5, end=30.0, label="outro", energy=0.1),  # sliver
        ],
    )
    shots = plan_shots(analysis, "cover the ending")
    assert abs(shots[-1].end - 30.0) < 0.01
    for s in shots:
        # A shot never promises more coverage than its generation holds.
        assert s.end - s.start <= s.generate_seconds + 1e-6


def test_all_sliver_sections_fall_back_to_full_span():
    analysis = AudioAnalysis(
        duration=3.0,
        tempo_bpm=120.0,
        beats=[i * 0.5 for i in range(6)],
        sections=[AudioSection(start=i * 0.5, end=(i + 1) * 0.5, label="verse", energy=0.5) for i in range(6)],
    )
    shots = plan_shots(analysis, "tiny sections")
    assert shots
    assert abs(shots[-1].end - 3.0) < 0.01


def test_performance_framings_rotate():
    # #59: half of all shots are performance — they must not share one setup.
    shots = plan_shots(_analysis(), "city night", artist_name="NOVA")
    perf = [s.prompt.split(",")[0] for s in shots if s.shot_type == "performance"]
    assert len(perf) >= 4
    assert len(set(perf)) >= 3, f"performance framings too repetitive: {set(perf)}"
    # Every variant keeps the artist named (lip-sync framing intact).
    assert all("NOVA" in s.prompt for s in shots if s.shot_type == "performance")
    # Determinism holds.
    again = plan_shots(_analysis(), "city night", artist_name="NOVA")
    assert [s.prompt for s in shots] == [s.prompt for s in again]


def test_wardrobe_maps_looks_to_sections():
    from server_utils.shot_planner import wardrobe_for_section

    looks = ["denim look", "fur coat look", "leather look"]
    assert wardrobe_for_section("verse", looks) == "denim look"
    assert wardrobe_for_section("chorus", looks) == "fur coat look"
    assert wardrobe_for_section("bridge", looks) == "leather look"
    assert wardrobe_for_section("chorus", ["only look"]) == "only look"
    assert wardrobe_for_section("verse", []) == ""

    shots = plan_shots(_analysis(), "city night", artist_name="NOVA", wardrobe=looks)
    chorus_perf = [s for s in shots if s.section_label == "chorus" and s.shot_type != "broll"]
    verse_perf = [s for s in shots if s.section_label == "verse" and s.shot_type != "broll"]
    assert chorus_perf and all("fur coat look" in s.prompt for s in chorus_perf)
    assert verse_perf and all("denim look" in s.prompt for s in verse_perf)
    # Pure b-roll never dresses empty scenery.
    assert all("wearing" not in s.prompt for s in shots if s.shot_type == "broll")


def test_empty_sections_fall_back_to_single_span():
    analysis = AudioAnalysis(duration=30.0, tempo_bpm=100.0, beats=[i * 0.6 for i in range(50)])
    shots = plan_shots(analysis, "fallback")
    assert shots
    assert abs(shots[-1].end - 30.0) < 0.01


# --- draft_concept ("Surprise me" #72): locked so it stays pure & deterministic ---

def test_draft_concept_is_deterministic():
    # Same song in -> same concept out. This is the whole promise of "Surprise me".
    a = draft_concept(120.0, 0.5, ["fire", "fire", "night", "chrome"])
    b = draft_concept(120.0, 0.5, ["fire", "fire", "night", "chrome"])
    assert a == b


def test_draft_concept_pace_follows_tempo():
    assert "high-velocity" in draft_concept(140.0, 0.5, [])
    assert "confident mid-tempo" in draft_concept(110.0, 0.5, [])
    assert "head-nod groove" in draft_concept(90.0, 0.5, [])
    assert "slow-burn" in draft_concept(70.0, 0.5, [])


def test_draft_concept_mood_follows_energy():
    assert "peaking hard" in draft_concept(120.0, 0.9, [])
    assert "building steadily" in draft_concept(120.0, 0.5, [])
    assert "kept intimate" in draft_concept(120.0, 0.1, [])


def test_draft_concept_surfaces_the_top_themes_by_frequency():
    words = ["money"] * 3 + ["power"] * 2 + ["fame"] * 1 + ["the", "a", "and"]
    concept = draft_concept(120.0, 0.5, words)
    assert "'money'" in concept and "'power'" in concept and "'fame'" in concept
    # Stopwords and sub-3-char tokens never become themes.
    assert "'the'" not in concept and "'a'" not in concept


def test_draft_concept_falls_back_cleanly_with_no_usable_lyrics():
    concept = draft_concept(120.0, 0.5, ["a", "i", "the"])
    assert "instrumental visual" in concept
    assert "themes of" not in concept  # never dangles an empty theme clause


def test_draft_concept_ties_break_alphabetically_for_determinism():
    # Equal counts must resolve stably, or "same song, same concept" is a lie.
    c1 = draft_concept(120.0, 0.5, ["zebra", "apple", "mango"])
    c2 = draft_concept(120.0, 0.5, ["mango", "zebra", "apple"])
    assert c1 == c2
    assert c1.index("'apple'") < c1.index("'mango'") < c1.index("'zebra'")
