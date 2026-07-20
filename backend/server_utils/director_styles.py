"""Director personas — distilled from Directors Palette's director fingerprints.

Palette's music-lab defines rich DirectorFingerprint profiles (parody personas
of iconic music-video directors). Until Palette exposes them over a desktop
API, DD vendors this distilled essence: enough voice to flavor every shot
prompt the way that director would shoot it. Source of truth for the full
profiles: directors-palette-v2 src/features/music-lab/data/directors.data.ts.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class DirectorStyle:
    id: str
    name: str
    description: str  # one line for pickers
    style: str  # comma fragment appended to EVERY shot prompt
    performance_note: str  # extra flavor for performance shots
    keyframe_note: str  # extra flavor for storyboard stills
    wardrobe: tuple[str, str, str]  # the director's three signature looks (A=story, B=chorus, C=bridge)


DIRECTOR_STYLES: dict[str, DirectorStyle] = {
    "mylan-kooler": DirectorStyle(
        id="mylan-kooler",
        name="Mylan Kooler",
        description="Emotion and legacy — intimate, warm, character-first",
        style=(
            "intimate shallow-focus framing, warm naturalistic light, anamorphic glow, "
            "emotionally grounded staging"
        ),
        performance_note="the performance feels confessional, eyes carrying the story",
        keyframe_note="film still with warm Kodak tones and human-scale intimacy",
        wardrobe=(
            "worn denim jacket over a plain white tee, small gold chain, lived-in and warm",
            "deep burgundy leather jacket, clean silhouette, quiet confidence",
            "heirloom knit sweater in earth tones, story in the texture",
        ),
    ),
    "flint-vestwood": DirectorStyle(
        id="flint-vestwood",
        name="Flint Vestwood",
        description="Restraint — still camera, hard shadows, unhurried",
        style=(
            "locked-off composed frames, hard directional shadow, muted desaturated palette, "
            "patient unhurried pacing"
        ),
        performance_note="minimal movement, weight in the stillness",
        keyframe_note="austere composed film still, negative space doing the talking",
        wardrobe=(
            "dusty long coat over a plain shirt, weathered boots, no ornament",
            "black western shirt with bone buttons, stark and simple",
            "rain-darkened canvas jacket, collar up, functional",
        ),
    ),
    "damir-pincher": DirectorStyle(
        id="damir-pincher",
        name="Damir Pincher",
        description="Precision dread — clinical moves, green-slate grade",
        style=(
            "surgically precise camera moves, cold green-slate grade, controlled symmetry "
            "with an undercurrent of dread"
        ),
        performance_note="performance shot like surveillance — exact, unblinking",
        keyframe_note="clinical film still, perfect geometry, low-key contrast",
        wardrobe=(
            "slate-gray tailored shirt, precise fit, no logos, surgical minimalism",
            "black turtleneck under a charcoal coat, controlled and exact",
            "muted olive utility jacket, every zipper deliberate",
        ),
    ),
    "vess-zanderson": DirectorStyle(
        id="vess-zanderson",
        name="Vess Zanderson",
        description="Symmetry and pastel — deadpan storybook tableaux",
        style=(
            "perfectly centered symmetrical tableau, flat frontal staging, pastel storybook "
            "palette, whip-pan transitions"
        ),
        performance_note="deadpan direct-to-camera performance inside a dollhouse frame",
        keyframe_note="storybook film still, centered one-point perspective, pastel wardrobe",
        wardrobe=(
            "mustard corduroy suit with a powder-blue shirt, storybook neat",
            "pastel pink blazer with a monogrammed pocket square, deadpan formal",
            "vintage track jacket in cream and burgundy stripes, museum-piece casual",
        ),
    ),
    "hype-trillions": DirectorStyle(
        id="hype-trillions",
        name="Hype Trillions",
        description="Fisheye gloss — shiny-suit spectacle, bullet-time flash",
        style=(
            "glossy high-shine music-video sheen, fisheye energy, low-angle hero framing, "
            "blacklight accents and chrome"
        ),
        performance_note="in-your-face wide-lens performance, larger than life",
        keyframe_note="high-gloss film still, barrel-distorted hero shot, wet reflective surfaces",
        wardrobe=(
            "high-shine metallic puffer, oversized, catching every light",
            "all-white fur coat over chrome accents, larger than life",
            "patent-leather two-piece with gold hardware, blacklight-ready",
        ),
    ),
}


def get_director_style(style_id: str) -> DirectorStyle | None:
    return DIRECTOR_STYLES.get(style_id)
