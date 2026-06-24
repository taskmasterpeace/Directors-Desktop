# Director's Desktop — promo short (production script)

**Format:** 9:16 vertical · 15s (extendable to 30s) · retention-first (earn second one, reset every ~3s, loop).
**Goal:** show the one-move workflow and drive to **directorspal.com**. **Brand:** Electric Amber `#eaa118`
+ teal `#2db3a0`, dark UI. **No purple.**

Two ways to produce this:
1. **Now, free:** open [`director-desktop-short.html`](director-desktop-short.html) and screen-record the
   `.reel` frame (405×720) → that's a postable MP4 / animatic.
2. **Later, generated (needs paid gen — get the OK first):** use the VO + shotlist below with
   ad-lab (voiceover) and Director's Palette / Seedance (B-roll), then animate + caption.

---

## Voiceover script (≈14s, punchy, confident)

> Generating AI video shouldn't mean *leaving your edit.*
> Pick the moment on the timeline. Say what you want — and `@mention` your character.
> It generates **right there**, lands in place, and remembers everything.
> Director's Desktop. Powered by Director's Palette.

*(Alt opener for a colder audience: "Stop downloading clips and dragging them in.")*

## Shotlist / storyboard (timed to the VO)

| # | Time | On screen | VO / caption | Motion |
|---|---|---|---|---|
| 1 | 0.0–2.2s | Headline: "Generate. Download. Drag it in. Repeat." — last line struck through in amber | "…shouldn't mean leaving your edit." | text punches in; amber strike sweeps across "Drag it in." |
| 2 | 2.2–5.5s | Timeline with two clips + an amber selection sweeping a gap; a `3.0s clip` badge pops | "Pick the moment on the timeline." | selection scales from left; duration badge pops |
| 3 | 5.5–9.0s | Prompt box: teal `@Truthful` chip + typed "riding through a muddy forest, headlights, cinematic" | "Say what you want — and @mention your character." | caret types the line; "character + duration attached" chip fades up |
| 4 | 9.0–12.0s | A dashed amber "GENERATING" placeholder in the track with a fill bar → swaps to a solid teal "YOUR SHOT" clip | "It generates right there, lands in place…" | placeholder progress fills, then clip pops in with a teal glow |
| 5 | 12.0–15.0s | Logo lockup "Director's Desktop" + "POWERED BY DIRECTOR'S PALETTE" + pulsing teal **directorspal.com** pill | "Powered by Director's Palette." | logo settles; URL pill pulses; hold for loop |

## B-roll prompts (for the generated version, via Director's Palette / Seedance)

- **Hero clip (scene 4 payoff):** `@<character> riding a four-wheeler through a muddy forest at night,
  cinematic music-video style, dramatic headlights, slow-motion mud splashing, 3-second clip` — exactly the
  app's example prompt, so the demo matches the product.
- **Optional cutaways:** a hand scrubbing a timeline; a transcript with a lyric highlighting; an editor UI
  push-in. Keep them ≤2s each so attention resets.

## Captions / on-screen text

Word-by-word karaoke captions on the VO (if using the tiktok caption-animation lane), amber active word on a
dark pill. Keep persistent lower-third minimal — the UI demo is the star.

## Hooks to A/B test (first 1s)

1. "Stop downloading clips."  2. "Your editor should generate the shot."  3. "Pick the moment → get the clip."

## Music

Driving, modern, ~110–125 BPM, builds to the scene-4 payoff and resolves on the CTA. (Generate in ad-lab:
`node scripts/generate-music.js -g electronic --instrumental`.)

## Export & verify

9:16, H.264, ≥30fps. Verify by probing the MP4 (duration ~15s, 1080×1920) and eyeballing stills at the five
scene marks. Loops cleanly (scene 5 fades out to scene 1).
