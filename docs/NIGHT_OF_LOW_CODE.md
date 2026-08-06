# Night of Low Code

One small, surgical improvement per entry — a single commit each, minimal
lines, maximum leverage. Running on a 15-minute loop (2026-08-06). Changes go
live in the installed app at the next installer swap.

| # | Improvement | Lines | Commit |
|---|-------------|-------|--------|
| 1 | Playground prompt helper now says **"Type @ to drop in your Characters & References"** — Robert hunted for his characters tonight and the machinery was there all along, invisible. One string. | 1 | `2e1d9a2` |
| 2 | Gallery's last two off-brand blues → amber: the loading ring and the model badge on every card. The app speaks amber everywhere else; these were LTX leftovers. | 2 | `3947b02` |
| 3 | Deleted `QueueTimers.tsx` — 92 lines of dead code. Nothing imported it since the Playground queue strip replaced it, and its hardcoded model-name map was a stale-data trap waiting for the next reader. | −92 | `f9d0c3e` |
| 4 | Gen Space now shows the **hot/cold warmth pill** when a local video model is selected — same honest residency story the Playground got. A cold engine costs ~5-15 min of load before the render; Gen Space was the one surface that still hid that. | ~13 | `9909618` |
| 5 | **Esc closes the Enhance Director modal.** Every other overlay honors Esc (queue edit, lightbox); this one trapped you into reaching for the mouse mid-flow. | 9 | `f26dd12` |
| 6 | **Copy-prompt button in the Gallery lightbox**, next to Remix. Remix reuses a prompt in-app; Copy gets it OUT — into Palette, a chat, notes. Check-mark flash confirms. | ~15 | `4157def` |
| 7 | **"clear finished" on the queue strip's done-trail.** Finished rows lingered until app restart; now one click hides them (the renders stay in the Gallery). Session-scoped dismiss set. | ~14 | (this commit) |
