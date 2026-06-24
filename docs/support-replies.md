# Director's Desktop — Canned Support Replies

Paste-ready ticket replies for Director's Desktop v1.0.1. Tone: warm, specific, no blame, always a next
step. Fill in `{{placeholders}}`. Each links to the matching [FAQ](FAQ.md) / `help.html` anchor.

---

### Greeting / first response  ·  (universal)
Hi {{name}}, thanks for reaching out — happy to help! {{one_line_restatement_of_their_issue}} Let me get
you sorted. {{next_step}}

### Need more info  ·  (universal)
Hi {{name}}, thanks for the report! To track this down, could you share: your OS (Windows/macOS), the app
version (Settings → About), whether you were in local or API/Director's Palette mode, and the exact message
on the failed job? A screenshot of the job is perfect.

### How do I connect Director's Palette?  ·  → `#director-s-palette-accounts-how-do-i-connect-my-director-s-palette-account`
Hi {{name}}! Open **Settings → Palette Connection** and sign in with your Director's Palette email and
password. Once you're connected, your credit balance shows in the header and your saved characters appear
in the `@` picker. Don't have an account yet? You can create one free at https://directorspal.com and it
takes a minute.

### My `@` character menu is empty  ·  → `#characters-references-the-system-my-menu-is-empty-what-s-wrong`
Hi {{name}}, the `@` menu pulls from your Director's Palette characters and your local Characters/References
libraries. If it's empty, connect Director's Palette (**Settings → Palette Connection**) or add a few
entries under the **Characters** library, then reopen the picker with `@`. Let me know if they still don't
show and I'll dig in.

### Generation failed — no credits / key  ·  → `#troubleshooting-my-generation-failed-or-the-placeholder-shows-an-error-what-now`
Hi {{name}}, thanks for flagging this. That model runs in the cloud, so it needs either a connected
Director's Palette account with credits or the matching API key. Check **Settings** for the key (or your
balance in the header), top up/add it, and retry from the placeholder. If it still fails, send me the exact
error text and I'll take a closer look.

### Out of VRAM / out-of-memory on local generation  ·  → `#troubleshooting-i-m-out-of-vram-getting-out-of-memory-errors-on-local-generation`
Hi {{name}}, sorry about that! Local generation is VRAM-hungry. Three quick fixes: (1) use a smaller model
format for your GPU — open **Settings → Models → Open Model Guide** for the recommended one; (2) lower the
resolution or clip duration; or (3) switch that job to API/Director's Palette mode, which doesn't use your
GPU at all. Tell me your GPU and I'll suggest the best format.

### App crashed on startup / kept relaunching  ·  → `#troubleshooting-the-app-crashed-on-startup-kept-relaunching-is-that-fixed`
Hi {{name}}, good news — this was a known startup crash and it's **fixed in v1.0.1**. Please update to the
latest build from the Releases page. It was an internal Electron issue (not your GPU), so there's nothing to
change in your settings. If you're already on the latest and still see it, reply here with the version and
I'll escalate.

### It's using API mode when I wanted local (or vice-versa)  ·  → `#local-vs-api-mode-what-s-the-difference-between-local-and-api-mode`
Hi {{name}}! The mode follows the model you pick: cloud/`dp-` models always run via the API, and local LTX
formats run on your GPU when you have ≥32 GB VRAM. Choose the model that matches the mode you want in
**Settings → Models** and the generation panel, and you'll be set.

### Billing / credits question  ·  → `#api-keys-credits-cost-when-do-i-get-charged-credits`
Hi {{name}}, thanks for asking! Credits are only used for cloud generations (cloud video, Seedance, cloud
image) — **local GPU generations are free**, and cloud **text encoding is free** too. The cost estimate
shows on the Generate button before you confirm. For balance or billing specifics on your Director's Palette
account, the best place is https://directorspal.com. Anything specific I can clarify?

### Where are my files / generated videos?  ·  → `#export-projects-where-are-my-files-and-settings-stored`
Hi {{name}}! Generated media shows up in the **Gallery**, and the files live in the app's outputs folder.
App data (settings, models, logs) is in `%LOCALAPPDATA%\LTXDesktop\` on Windows or
`~/Library/Application Support/LTXDesktop/` on macOS. Generated **videos stay local** by design (they're
large); images are designed to sync to your Director's Palette gallery.

### My clip didn't land on the timeline  ·  → `#the-ai-native-timeline-workflow-does-the-generated-clip-really-drop-itself-onto-the-timeline`
Hi {{name}}, thanks for the report. Auto-placement is most reliable through the timeline/transcript
generate-into-the-gap flow today (a placeholder holds the spot, then the finished clip swaps in). Generating
into any arbitrary position from every panel is being generalized. If your clip generated but didn't place,
it's safe in the **Gallery** — you can drag it onto the timeline manually while we finish that work.

### Feature request — decline / defer  ·  (universal)
Hi {{name}}, I love this idea — thank you for taking the time to suggest it. It's not on the immediate
roadmap (we're focused on the core AI-native timeline loop right now), but I've logged it so it's captured.
I'll follow up here if it gets scheduled. Really appreciate you helping shape the product.

### Bug acknowledgement  ·  (universal)
Hi {{name}}, thanks for the detailed report — you're right, that's a bug, and I've filed it. {{workaround_if_any}}
I'll update this ticket when there's a fix. Sorry for the friction, and thanks for your patience.

### Escalation  ·  (universal)
Hi {{name}}, I want to get this fully resolved, so I'm escalating it to the team with everything you've sent.
{{eta_or_next_touchpoint}} Thanks for bearing with me — I'll keep you posted right here.

### Closing  ·  (universal)
Hi {{name}}, glad that's working now! I'll close this out, but reply anytime to reopen if anything comes
back. Happy creating — and if you haven't yet, your Director's Palette characters make the `@` workflow a
lot faster: https://directorspal.com
