# Test & Improvement Loop — live progress report

**Mode:** read-only. This loop runs suites and probes; it does **not** change app code.
**Cadence:** every 20 min (cron `cd49caed`). **Baseline commit:** `a59d423`.
**Last updated:** 2026-08-04, **iteration 17**.

Stop me any time — this file is always current as of the timestamp above.

---

## Suite status

| Suite | I1–I8 | I9 | I10–I16 | I17 |
|---|---|---|---|---|
| Backend pytest | 612 ×8 | 1 FAILED / 611 (retry 612) | 612 ×8 | **612 passed** (68s) |
| Frontend vitest | 164 each | 164 | 164 each | **164 passed** |
| pyright (strict) | 0 each | 0 | 0 each | **0 errors** |
| tsc — frontend / electron | clean | clean | clean | **clean** |

**Full-suite flake rate to date: 1 failure in 19 runs (~5%).**

---

## 🎯 The single clearest finding of this loop

**All four persistence layers have now been probed. Three are crash-safe. The one holding
your API keys is not.**

| File | Atomic write | Keeps a corrupt copy | Verified |
|---|---|---|---|
| Library store (characters/refs/recipes) | ✅ tmp+`os.replace`, **PID-suffixed** | ✅ `.corrupt-<timestamp>` | iter 17 — 13/13 |
| Agent-bridge mirror | ✅ tmp+`os.replace` | ✅ degrades + self-repairs | iter 15 — 19/20 |
| Job queue | ✅ | ⚠️ degrades to empty | iter 8 — 10/11 |
| **settings.json (CREDENTIALS)** | ❌ **writes in place** | ❌ **wipes to defaults** | iter 16 — **F14** |

The library store even documents *why* it works this way: *"previously the next save would
persist the empty list over the user's data, making the loss permanent."* That lesson was
learned and fixed — but never applied to the credentials file. **F14 is a three-line fix
copying a pattern that already exists in the same repo, twice over.**

---

## 🔴 Open defects (9 confirmed — none fixed; this loop does not change code)

| ID | Defect | Impact | Fix |
|---|---|---|---|
| **F14** | settings.json non-atomic — a torn write silently wipes every setting incl. API keys | user loses credentials, no message | S |
| **F10** | Pruned Director job → **second paid job** on resume | 💰 the only proven overcharge | S |
| **F13** | FCPXML: fps hardcoded to 24; speed/reversed/muted dropped | Premiere/DaVinci hand-off wrong | S–M |
| **F8** | Split / Cut-to-Beats ignores `clip.speed` | core blade cuts wrong frame | S |
| **F11** | Director threads leak across tests (**proven**, 16/run); 1-in-19 flake | CI trust / isolation | S–M |
| **F6** | Caption bold/italic/font vanish at export | 5 of 6 presets misrepresent themselves | M |
| **F7** | Word-pop cues overlap above 8.3 words/sec | 23/24 cues at double-time rap | S |
| **F12** | Captions on a REVERSED clip come out mirrored | captions land on wrong words | S |
| **F9** | Load-order-dependent circular import | new entry points crash | M |

---

## 🧭 Two patterns, one message

**1. source↔timeline conversion** — five consumers, three right, two wrong:

| Consumer | `speed` | `reversed` |
|---|---|---|
| `transcript-ripple.ts` | ✅ documented | n/a |
| Caption mapping | ✅ | ❌ **F12** |
| Agent bridge `trim_clip` | ✅ | n/a |
| **Blade / Cut-to-Beats** | ❌ **F8** | — |
| **FCPXML export** | ❌ **F13** | ❌ **F13** |

**2. durable writes** — see the table above; three of four are right.

**Both patterns say the same thing: the correct implementation already exists in this
codebase. The defects are the places that don't use it.** That makes these unusually
cheap, low-risk fixes — copying a local precedent, not inventing a design.

---

## ✅ Verified clean — 197 probe assertions across 16 areas

### NEW (iteration 17) — library store: 13/13
- **Atomic writes**: tmp file is **PID-suffixed** (two processes can't collide) then
  `os.replace`d; no `.tmp` residue.
- **Corrupt file is quarantined**, not discarded — a torn `characters.json` was preserved
  as `characters.json.corrupt-20260804-142910`, and **the user's data was still inside it**.
- **A later save does not destroy the quarantined original** — hand-recovery stays possible.
- Round-trip fidelity: unicode names (`Ünïcode Ártist 🎬`) exact, **51 entries** all persisted.
- Creates its directory on demand.

### The money sweep (complete — all four spending paths)
Queue credits 16/16 · Director cancel+resume 18/18 · Recast 19/19 · Palette v2 14/14.
**F10 remains the only demonstrated way this app can overcharge someone.**

### Also verified
- **Agent bridge read-model — 19/20** (atomic mirror; `publishedAt` monotonic under 12
  concurrent publishes; corrupt-file self-repair; correct transcript stitching).
- **Settings — 11/14**: API keys round-trip byte-exact (512-char, whitespace, unicode);
  corrupt file never locks the user out. Misses are F14 + unknown-field loss.
- **Caption alignment under speed — 13/14**; **bridge action queue — 12/13**;
  **queue durability — 10/11**; **sidecars — 9/9**; **Cut-to-Beats math 11/12**;
  **9:16 export wiring correct**; **`draft_concept` 10/10**.

---

## 📋 Robustness notes (not defects)

- API keys sit in **plaintext** in settings.json — normal for a local desktop app and
  consistent with the project's model; worth stating in the docs.
- **Unknown settings keys are dropped** on load→save (older build erases newer settings).
- Snapshot aliasing in `publish()` is **latent only** — the route hands over a freshly
  deserialised body.
- No explicit "editor is open" signal in the read-model; only `publishedAt`.
- Bridge action queue is bounded **only when actions finish** (600 vs a 200 cap).
- Recast uploads the whole file when no trim params are passed — billing is per second.

---

## Findings scoreboard

| ID | Finding | Status |
|---|---|---|
| F1 | "3 identical shot prompts" | ❌ **FALSE ALARM** — my own 80-char truncation |
| F2 | Prompt differentiation at END of string | ✅ Confirmed (~40% unique per song) |
| F3 | "Hallucinated lyrics corrupt prompts" | ❌ **LARGELY FALSE** — 0 of 38 prompts |
| F4 | Coverage gaps | ✅ Confirmed — hid F6, F7, F8 |
| F5 | `draft_concept` robust; "lyrics: 1 words" | ✅ Confirmed (cosmetic) |
| F6–F14 | see defect table | 🔴 9 real defects |

**Tally: 2 claims falsified · 9 genuine defects · 16 areas proven clean (197 assertions).**

---

## Ranked improvement backlog

| # | Improvement | Evidence | Effort | Confidence |
|---|---|---|---|---|
| 1 | **Atomic settings write + quarantine** (copy `library_store._write_json`) | F14 — a crash wipes the user's API keys silently | S | High |
| 2 | **Protect `director`-tagged jobs from pruning** | F10 — the only proven overcharge | S | High |
| 3 | **Pass `settings.fps` to `generateFCPXML`** | F13 — one line; every non-24fps XML is wrong | S | High |
| 4 | **Scale split offset by `clip.speed`** (copy `transcript-ripple.ts`) | F8 — in-repo implementations disagree | S | High |
| 5 | **Fail the suite on leaked threads at teardown** | F11 — proven on 100% of runs | S | High |
| 6 | **One shared source↔timeline helper** | pattern 1 — prevents F8, F12, half of F13 | M | High |
| 7 | Honour bold/italic in export (or hide the controls) | F6 | M | High |
| 8 | Clamp word-pop cue end to the next word's start | F7 | S | High |
| 9 | Mirror caption mapping when `clip.reversed` | F12 | S | High |
| 10 | Emit `timeMap` + reverse + mute in FCPXML, or document the losses | F13 | M | Med |
| 11 | Adopt the 16 credit-safety assertions as real tests | I7 | S | High |
| 12 | Preserve unknown settings keys across load→save | I16 note | S | Med |
| 13 | Defensive copy in `publish()`; "editor live" hint in the read-model | I15 notes | S | Med |
| 14 | Guard/warn when recast is called without trim params | I11 note | S | Med |
| 15 | Break the `state` ↔ `app_handler` import cycle | F9 | M | High |
| 16 | Restructure prompt order — shot-specific clause first | F2 | M | High |
| 17 | Adopt the 18 adversarial Director assertions as tests | I6 | S | High |
| 18 | Cap bridge actions even when none finish | I9 note | S | Med |
| 19 | Lock `draft_concept` in tests | F4/F5 | S | High |
| 20 | Test caption preset + cue math | F4 | S | High |
| 21 | Fix "1 words" pluralisation | F5 | S | High |
| 22 | Extract cut-to-beats math to a testable lib fn | F4 | M | Med |
| 23 | Billing retry when Palette deduction throws | I7 | M | Low |

**Dropped:** "lyric-confidence floor" — F3 disproved it.

---

## Iteration log

- **Iter 1–2**: green. **Corrected F1 and F3** (my own false alarms). Found F2, F5.
- **Iter 3–5**: green. **Found F6, F7, F8, F9.**
- **Iter 6**: green. Director phase machine 18/18 adversarial.
- **Iter 7**: green. Credit path 16/16. *Note:* first probe showed 5 false failures from my
  own race — fixed before reporting.
- **Iter 8**: green. **Found F10** (money).
- **Iter 9**: **first red run**; logged F11.
- **Iter 10**: green ×2. **Proved** the thread leak; declined to claim it causes the flake.
- **Iter 11–12**: green. **Money sweep complete** (recast 19/19, Palette v2 14/14).
- **Iter 13**: green. **Found F12.**
- **Iter 14**: green. **Found F13**; added the source↔timeline pattern table.
- **Iter 15**: green. Read-model 19/20; classified snapshot aliasing as latent rather than
  inflating the defect count.
- **Iter 16**: green. **Found F14** (settings write); added the durable-write table.
- **Iter 17**: green. Library store **13/13** — atomic PID-suffixed writes *and*
  corrupt-file quarantine that preserves the user's data. This completes the persistence
  sweep and sharpens F14 into the loop's clearest result: **three of four persisters are
  crash-safe, and the exception is the file holding the user's credentials** — fixable by
  copying `library_store._write_json` verbatim.
