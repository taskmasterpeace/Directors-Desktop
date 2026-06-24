# Director's Desktop — FAQ

> Help center for Director's Desktop v1.0.1. The [README](../README.md) covers *how the whole thing
> works*; this answers *the one thing you're stuck on right now*. New here? Director's Desktop is the
> desktop companion to **[Director's Palette](https://directorspal.com)** — start there for an account.

## Getting started

### What is Director's Desktop?
It's an AI-native video editor: you select a moment on the timeline, describe the shot you want, and the
generated clip lands **exactly there**. Instead of generating clips somewhere else and dragging them in,
you think, generate, and edit in one place. It's the desktop companion to
**[Director's Palette](https://directorspal.com)**.

### How do I install it?
Download the latest installer from the [Releases page](../../releases), run it, and launch
**Director's Desktop**. On first run, complete setup, then connect your Director's Palette account in
**Settings → Palette Connection**. Windows and macOS (Apple Silicon) are supported.

### Do I need a powerful GPU?
No. Local generation needs an NVIDIA GPU with **≥32 GB VRAM**, but **API mode runs on any hardware**
(including macOS) — the cloud providers do the work. If you connect Director's Palette, you don't need a
local GPU at all.

### What's the very first thing I should do after installing?
Connect Director's Palette (**Settings → Palette Connection**). That unlocks your saved characters,
cloud image/video generation on your credits, and the shared gallery. Then load a project with a
transcript and try the core loop below.

## Director's Palette & accounts

### What is Director's Palette and why do I need it?
[Director's Palette](https://directorspal.com) is the cloud brain behind Director's Desktop. It stores your
characters, styles, and references, runs image and shot generation on your credits, and keeps one gallery
across web and desktop. Director's Desktop works without it, but the `@character` system and no-keys
generation are why it exists. **[Create a free account →](https://directorspal.com)**

### How do I connect my Director's Palette account?
Open **Settings → Palette Connection** and sign in with your email and password (or via the deep link from
the web app). Once connected, your credit balance shows in the header and your characters appear in the `@`
picker.

### Where do I see my credit balance and what a generation will cost?
Your balance is in the app header, and the **estimated cost shows on the Generate button** before you
submit — so there are no surprises. Credits are only used for API-backed generations; local GPU
generations are free.

### Is my Director's Palette login or API key safe?
Yes. Keys and tokens are stored locally in your app-data folder and are never committed or uploaded with
your project. Treat them like passwords.

## The AI-native timeline workflow

### How does the core "generate into the timeline" loop work?
1. Load a project (video or audio) with a transcript. 2. Highlight a lyric/sentence in the transcript, or
drag a range on the timeline. 3. Director's Desktop reads the **exact duration** you need (e.g. 1:08–1:11 →
3 seconds). 4. Type `@` to add a Director's Palette character, write your prompt, and generate. 5. A
**placeholder** holds the spot while it renders, then the finished clip swaps in automatically.

### How does it know what clip length to generate?
From your selection. Highlight a transcript range or a timeline range and it computes the duration for you
and sends it with the request — so you get a clip that fits the slot instead of guessing.

### I highlighted a transcript line but the timeline didn't move — why?
The transcript panel maps **word-level timestamps** to the timeline. Click a word to jump the playhead; if
nothing happens, the clip under that word may not have a transcript yet — generate or attach one first, and
make sure the clip you expect is on an active track.

### Does the generated clip really drop itself onto the timeline?
For the generate-into-the-timeline (gap-fill) flow, yes — a duration-sized placeholder appears at the spot
and is replaced by the finished clip. Generating into **any** arbitrary timeline position from every panel
is being generalized (tracked in the project's open issues); today it's most reliable via the
timeline/transcript flow.

### Can I use this for YouTube videos, not just music videos?
Absolutely. Highlight a sentence of narration that runs, say, 5 seconds, prompt a visual metaphor, and a
5-second clip drops in. The same loop works for explainers, commentary, news, trailers, and pitch decks.

## Characters, references & the @ system

### How do I add one of my saved characters to a generation?
Type `@` in the prompt box and pick a character from the dropdown — the same characters you saved in
Director's Palette. Its reference images attach to the generation automatically, so the character stays
consistent across shots.

### My `@` menu is empty. What's wrong?
The `@` picker pulls from your Director's Palette characters and the local Characters/References libraries.
If it's empty, connect Director's Palette (**Settings → Palette Connection**) or add entries under the
**Characters** / **References** library views, then reopen the picker.

### What's the difference between a reference and a first/last frame?
A **reference** guides likeness/consistency (a character looks like *that*). A **first/last frame** sets the
literal starting/ending image of the clip. Seedance 1.5 supports first **and** last frame; Seedance 2.0
uses image (and audio) references.

### Can I drive lip-sync from an audio clip?
Seedance 2.0 supports audio references (lip-sync) alongside an image reference. The audio-reference library
UI is still being finished, so this is partially available today — see the open issues for status.

## Generation & models

### Which video models can I use?
Local LTX 2.3 (multiple VRAM-friendly formats), **Seedance 1.5** (first + last frame, via Replicate), and
**Seedance 2.0** (reference-to-video with character + audio refs, via fal). Image generation runs through
Director's Palette's shot generator, or locally/fal.

### What are Story, Music, and Plain prompt modes?
They change how your selection becomes a prompt. **Story** keeps a narrative consistent across moments.
**Music** turns **pasted lyrics** into shot prompts that fit the song. **Plain** uses just the text you
selected. Pick the mode in the transcript panel.

### Which local model format should I download for my GPU?
32 GB+ → BF16 (auto-downloaded). 20–31 GB → FP8. 16–19 GB → GGUF Q5_K. 10–15 GB → GGUF Q4_K. The built-in
**Model Guide** (Settings → Models → Open Model Guide) detects your GPU and recommends one automatically.

### Why does my first local generation take so long?
The model weights download on first use (BF16 is ~43 GB) and the model loads into VRAM. After that,
generations are much faster. API/cloud generations skip the download entirely.

## Local vs. API mode

### What's the difference between local and API mode?
**Local** runs the model on your NVIDIA GPU (free, needs ≥32 GB VRAM). **API mode** sends generation to the
cloud (Director's Palette, Seedance, fal, LTX) and works on any hardware including macOS, using credits or
an API key.

### Can I run everything in the cloud and skip local models?
Yes — connect Director's Palette and/or add API keys, and you never need a local GPU. This is the default
path on macOS and on Windows machines without a big GPU.

## Batch generation

### How do I generate many clips at once?
Open the **Batch Builder**. Use **List** mode to add prompts one by one, **Import** to bulk-load from
CSV/JSON/text, or **Grid Sweep** to run combinations of prompts × seeds × models. You can also import an
edited timeline to re-generate all of its segments.

### Can I re-generate a whole edited timeline?
Yes — use **Timeline import** in the Batch Builder to turn your edit into a batch and regenerate each
segment.

## Export & projects

### How do I export my finished video?
Use **FFmpeg export** from the editor and choose your codec and quality. Save your editing session as a
**Video Project** so you can reopen it later.

### Are my generated videos uploaded to the cloud?
No — generated **videos stay on your machine** (they're large). Generated **images** are designed to sync to
a shared Director's Palette gallery; that image-save round-trip is being finalized on the Director's Palette
side, so for now images live in your local Gallery.

### Where are my files and settings stored?
App data (settings, models, logs) is in `%LOCALAPPDATA%\LTXDesktop\` on Windows or
`~/Library/Application Support/LTXDesktop/` on macOS. Generated media lands in the app's outputs folder and
shows up in the **Gallery**.

## API keys, credits & cost

### Which API keys do I actually need?
None are strictly required if you connect Director's Palette. Optional keys add providers: **LTX**
(free cloud text encoding + prompt enhancement; paid video), **Replicate** (Seedance 1.5), **fal**
(Seedance 2.0, Z-Image), **OpenRouter/Gemini** (prompt suggestions). Add them in **Settings**.

### Is text encoding free?
Yes — cloud **text encoding is completely free** (via LTX/Palette) and is recommended because it speeds up
inference and saves memory. Only actual video/image generation consumes credits or paid API usage.

### When do I get charged credits?
Only for API-backed generations (cloud video, Seedance, cloud image). **Local GPU generations are free.**
The cost estimate appears on the Generate button before you confirm.

## Troubleshooting

### The app crashed on startup / kept relaunching. Is that fixed?
Yes. An intermittent startup crash (a `file:` protocol recursion in the Electron layer, surfacing as a
`0xC0000005` access violation) was fixed in v1.0.1. Update to the latest build. It was **not** a GPU driver
problem, so you don't need to change GPU settings.

### My generation failed or the placeholder shows an error — what now?
Open the failed job and check the message. Common causes: no API key/credits for an API-backed model
(add a key or connect Director's Palette), an unsupported resolution/duration for that provider, or a
reference image that's too large. Fix the cause and retry from the placeholder.

### Generation is using API mode when I wanted local (or vice-versa).
The mode is chosen by your hardware and the selected model. A `dp-` or cloud model always runs via the API;
local LTX formats run on your GPU when you have ≥32 GB VRAM. Pick the model that matches the mode you want
in **Settings → Models** and the generation panel.

### I'm out of VRAM / getting out-of-memory errors on local generation.
Use a smaller model format for your GPU (FP8/GGUF — see the Model Guide), lower the resolution or duration,
or switch that job to API/Director's Palette mode. Very long or high-resolution local clips need the most
VRAM.

### How do I turn off analytics?
**Settings → General → Anonymous Analytics**. Analytics is minimal and anonymous (app version, platform, a
random install ID — no personal data or generated content), but you can disable it anytime.
