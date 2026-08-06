# H3 Multishot — the learning battery

*Purpose: after the 30s captain proof, learn as much as possible per GPU-hour
about what multishot actually unlocks — specifically whether it can carry a
music video. Robert reviews the outputs; findings decide what gets built into
Directors Desktop.*

All tests: int8 fl DiT (+ ref2va for T6), nvfp4 Heretic encoder, 20 steps,
`seed_per_shot: true` (the pack author measured this HOLDS identity; one seed
everywhere makes face and voice drift), 243 frames/shot (~10.1s).

| # | Test | What it isolates | The question it answers |
|---|------|------------------|-------------------------|
| T1 | **Rap performance, 9:16** (3 shots, 480×832) | Musical audio + vertical + performance energy | Can the chain RAP on beat continuously? Does vertical work? |
| T2 | **Artist identity from a photo** (MEMORY sampler, anchor=1, start_image = the floral-shirt artist ref) | Real-character chains | Does a REAL artist's likeness survive a chain — the #1 music-video requirement? |
| T3 | **Coverage variety** (CU → wide → tracking, same scene) | Reframing tolerance | Can one chain deliver MV-style coverage, or does last-frame anchoring fight big reframes? |
| T4 | **Hard location cuts** (street → rooftop night → back) | Scene-change tolerance | Can a chain CUT locations like an MV, or is it same-scene-only? This decides the MV architecture (one chain per section vs per location). |
| T5 | **60-second verse** (MEMORY sampler, 6 shots) | Long-chain drift + runtime scaling | Does identity hold at 6 hops? What does a minute actually cost? |
| T6 | **Voice reference** (single shot, ref2va DiT + `H3ReferenceAudio`, the captain's own 8s voice as `ref_audio_0`) | Voice conditioning | Can we FEED a voice and get performances in that voice — the artist-voice lever? |

**Review rubric per test (Robert):** identity across seams · audio continuity
(voice/beat through cuts) · did the prompt's staging actually happen ·
would you put this in a video?

**Known-unknowns deliberately NOT in round 1:** keyframe-anchored chains
(storyboard→video), 720p chains, LoRA-in-chain, lipsync to an EXISTING song
(ref-audio conditions voice character, not sync — sync remains Seedance's or
the A2V pipeline's job until proven otherwise).

**If the battery passes:** wire `generate_multishot` into the h3 client + a
Multishot toggle in the Playground, then the big one — Music Video sections
rendered as single chains (continuous voice + identity per verse/hook).
