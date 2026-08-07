# Directors Desktop — MCP server

Let any MCP-speaking AI (Claude Desktop, Cursor, Claude Code, …) act as your
**assistant editor** on the production open in Directors Desktop right now. The
AI reads the timeline, drills into chapters, and applies edits — all through the
app's agent bridge, so every change lands on your undo stack (one Ctrl+Z) and
nothing bypasses the app's validation.

Zero dependencies — it's a single Node file. Directors Desktop must be running
(the MCP server discovers it automatically via the app's `agent-bridge.json`).

## Tools

- `get_timeline` — the whole production as a compact table of contents
  (chapters, cast, transitions, per-chapter summaries) + an EDITING guide. Start
  here; a 300-clip production is ~300 tokens.
- `get_chapter{chapter}` — time-coded per-line detail for one chapter.
- `get_project_json` — the full read model (escape hatch for deep dives).
- `edit_timeline{actions}` — apply bounded edits (move/trim/delete clips,
  markers, captions, generate-and-place); each action is reported back as
  applied or rejected with a reason.

More tools land as the pipeline grows: `regenerate_line` (re-perform a
character's line as a new take), `generate_sfx` (place a sound effect).

## Point a client at it

**Claude Desktop / Cursor** — add to the MCP servers config:

```json
{
  "mcpServers": {
    "directors-desktop": {
      "command": "node",
      "args": ["D:/git/directors-desktop/mcp/dd-mcp-server.mjs"]
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add directors-desktop -- node D:/git/directors-desktop/mcp/dd-mcp-server.mjs
```

## Test it

```bash
node mcp/smoke.mjs   # hermetic: fake bridge + real MCP handshake, PASS/FAIL
```

## How it finds the app

Reads `%LOCALAPPDATA%\LTXDesktop\agent-bridge.json` (mac: `~/Library/Application
Support/LTXDesktop/…`), which the app writes while running: `{url, token, pid}`.
A stale file (app closed) yields a clear "open Directors Desktop" error. Override
with `DD_BRIDGE_URL` / `DD_BRIDGE_TOKEN` for non-default installs.
