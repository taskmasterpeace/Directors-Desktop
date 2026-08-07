#!/usr/bin/env node
/**
 * Directors Desktop MCP server — the door any AI walks through to edit the
 * production open in the editor RIGHT NOW.
 *
 * Zero dependencies on purpose (matches the dramatis studio's ethos): MCP over
 * stdio is newline-delimited JSON-RPC 2.0, a small subset (initialize /
 * tools/list / tools/call) not worth an SDK that could hang a headless install.
 *
 * Point any MCP client at:  node mcp/dd-mcp-server.mjs
 * It discovers the running app via %LOCALAPPDATA%\LTXDesktop\agent-bridge.json,
 * forwards to the agent bridge (the ONE authority — undo stack + validation),
 * and holds no editing logic of its own.
 *
 * Env overrides (for tests / non-default installs):
 *   DD_BRIDGE_URL, DD_BRIDGE_TOKEN  — skip discovery, talk to this bridge
 *   DD_BRIDGE_FILE                  — read discovery from this path instead
 */
import { readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'directors-desktop', version: '1.0.0' }

// ── bridge discovery ─────────────────────────────────────────────────────────
function bridgeFilePath() {
  if (process.env.DD_BRIDGE_FILE) return process.env.DD_BRIDGE_FILE
  if (platform() === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local')
    return path.join(local, 'LTXDesktop', 'agent-bridge.json')
  }
  // mac/linux app-paths.ts userData dir
  if (platform() === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'LTXDesktop', 'agent-bridge.json')
  }
  return path.join(homedir(), '.config', 'LTXDesktop', 'agent-bridge.json')
}

function pidAlive(pid) {
  if (!pid) return true // no pid to check — assume live and let the fetch fail honestly
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/** Returns {url, token} or throws a human error the AI can relay to the user. */
function resolveBridge() {
  if (process.env.DD_BRIDGE_URL) {
    return { url: process.env.DD_BRIDGE_URL.replace(/\/$/, ''), token: process.env.DD_BRIDGE_TOKEN || '' }
  }
  const file = bridgeFilePath()
  let raw
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch {
    throw new Error('Directors Desktop is not running (no agent-bridge file). Open the app, then try again.')
  }
  if (!raw.url) throw new Error('The agent-bridge file has no url — restart Directors Desktop.')
  if (!pidAlive(raw.pid)) {
    throw new Error('The agent-bridge file is stale (its process is gone). Open Directors Desktop, then try again.')
  }
  return { url: String(raw.url).replace(/\/$/, ''), token: raw.token || '' }
}

async function bridgeFetch(pathAndQuery, init = {}) {
  const { url, token } = resolveBridge()
  const headers = { ...(init.headers || {}) }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${url}${pathAndQuery}`, { ...init, headers })
  const text = await res.text()
  if (!res.ok) {
    // The bridge returns {detail} on HTTPError — surface it, don't swallow.
    let detail = text
    try { detail = JSON.parse(text).detail ?? text } catch { /* text is fine */ }
    throw new Error(`bridge ${res.status}: ${detail}`)
  }
  return text
}

/**
 * Submit bounded editor actions and poll until each resolves (or the wait caps).
 * Long-running kinds (generate_and_place, regenerate_with_reference) report late,
 * so unresolved ids come back as `in_flight` rather than a false "done".
 */
async function submitAndAwait(actions) {
  const submit = JSON.parse(
    await bridgeFetch('/api/project/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions }),
    }),
  )
  const ids = new Set(submit.ids ?? [])
  if (ids.size === 0) return { note: 'no actions accepted', submit }
  const deadline = Date.now() + 20_000
  let statuses = []
  for (let i = 0; i < 25; i++) {
    const data = JSON.parse(await bridgeFetch('/api/project/actions/status'))
    statuses = (data.actions ?? []).filter((a) => ids.has(a.id))
    const resolved = statuses.filter((a) => a.status === 'applied' || a.status === 'rejected')
    if (resolved.length === ids.size) break
    if (Date.now() > deadline) break
    await sleep(800)
  }
  const seen = new Set(statuses.map((s) => s.id))
  for (const id of ids) {
    if (!seen.has(id)) statuses.push({ id, status: 'in_flight', reason: 'still rendering — check back with get_timeline (a new take lands on the clip when done)' })
  }
  return { results: statuses }
}

// ── tools ────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'get_timeline',
    description:
      'Read the whole open production as a compact table of contents (chapters, cast, sections, ' +
      'detected transitions, per-chapter summaries) plus a self-documenting EDITING guide. Start here: ' +
      'the entire map of a 300-clip production costs ~300 tokens. Clip ids in (parens) are stable — use ' +
      'them with edit_timeline. Drill into one chapter with get_chapter.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => bridgeFetch('/api/project/toc?format=text'),
  },
  {
    name: 'get_chapter',
    description:
      'Time-coded, per-event detail for one chapter (1-based): every clip with its stable id, speaker, ' +
      'kind, source line/beat id, engine, and a text snippet. Use after get_timeline to read a chapter ' +
      'closely before editing it.',
    inputSchema: {
      type: 'object',
      properties: { chapter: { type: 'integer', minimum: 1, description: '1-based chapter number from get_timeline' } },
      required: ['chapter'],
      additionalProperties: false,
    },
    run: async (args) => bridgeFetch(`/api/project/toc?chapter=${encodeURIComponent(args.chapter)}&format=text`),
  },
  {
    name: 'get_project_json',
    description:
      'The full project read-model as JSON (assets, clips, tracks, markers, subtitles). The escape hatch ' +
      'for detail the TOC summarizes — prefer get_timeline/get_chapter first; this can be large.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => bridgeFetch('/api/project/current'),
  },
  {
    name: 'edit_timeline',
    description:
      'Apply bounded edits to the open timeline through the user\'s undo stack (one Ctrl+Z for the batch). ' +
      'Pass actions[]; each is applied and reported back as applied or rejected(reason) so you SEE the ' +
      'result. Action kinds: ' +
      'move_clip{clipId,startTime,trackIndex} · trim_clip{clipId,trimStart,trimEnd (ABSOLUTE source-media ' +
      'seconds)} · delete_clip{clipId} (linked A/V go together; assets are never deleted) · ' +
      'add_marker{marker:{time,title,duration?,color?,note?}} · update_marker{markerId,patch:{...}} · ' +
      'delete_marker{markerId} · captions_from_transcript{clipId?} · ' +
      'generate_and_place{prompt,at:{trackIndex,startTime},mediaType?,model?,referenceImagePaths?}. ' +
      'Get clip/marker ids from get_timeline or get_chapter first.',
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          items: { type: 'object' },
          minItems: 1,
          description: 'Bounded editor actions (see the kinds in this tool\'s description).',
        },
      },
      required: ['actions'],
      additionalProperties: false,
    },
    run: async (args) => JSON.stringify(await submitAndAwait(args.actions), null, 2),
  },
  {
    name: 'regenerate_clip',
    description:
      'Re-render an EXISTING clip using image and/or video references — the assistant-editor version of ' +
      '"redo this shot, but matching THIS." The result lands as a NEW TAKE on the clip (the original take ' +
      'is retained; the user can flip between them), at the clip\'s own length, capped at 15s. ' +
      'Give at least one reference, from any mix of: (a) referenceImagePaths / videoReferencePaths — ' +
      'absolute local files the app can read (a saved frame, a character sheet, a short ≤15s clip); or ' +
      '(b) referenceFromClips — build a reference straight from ANOTHER clip on the timeline (no file needed): ' +
      'the app extracts a frame or a ≤15s window from that clip, optionally cropped to a region. ' +
      'This is how you say "redo clip 12 to match a close crop of clip 8\'s face." An optional note steers the ' +
      'change ("keep the framing, warmer light"). Get clip ids from get_timeline / get_chapter. Long-running: ' +
      'it reports in_flight and the take appears when the render finishes.',
    inputSchema: {
      type: 'object',
      properties: {
        clipId: { type: 'string', description: 'Stable clip id from get_timeline (the parenthesized id) — the clip to REGENERATE.' },
        referenceImagePaths: {
          type: 'array', items: { type: 'string' },
          description: 'Absolute paths to still references (frames, sheets, crops). Up to 9.',
        },
        videoReferencePaths: {
          type: 'array', items: { type: 'string' },
          description: 'Absolute paths to short video references, each already ≤15s. Up to 3.',
        },
        referenceFromClips: {
          type: 'array',
          description: 'Build references from OTHER timeline clips. Each entry: {clipId, atSeconds?, cropRect?, as?}.',
          items: {
            type: 'object',
            properties: {
              clipId: { type: 'string', description: 'The clip to take the reference FROM (its stable id).' },
              atSeconds: { type: 'number', description: 'Seconds into that clip to sample (default: its midpoint for a frame, its start for a video window).' },
              cropRect: {
                type: 'object',
                description: 'Optional normalized crop region (each 0..1 of the frame).',
                properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
                required: ['x', 'y', 'w', 'h'],
                additionalProperties: false,
              },
              as: { type: 'string', enum: ['image', 'video'], description: 'image = a still frame (default); video = a ≤15s motion window (Seedance omni-ref).' },
            },
            required: ['clipId'],
            additionalProperties: false,
          },
        },
        note: { type: 'string', description: 'Optional direction for the regeneration.' },
      },
      required: ['clipId'],
      additionalProperties: false,
    },
    run: async (args) => {
      const action = {
        kind: 'regenerate_with_reference',
        clipId: args.clipId,
        ...(Array.isArray(args.referenceImagePaths) ? { referenceImagePaths: args.referenceImagePaths } : {}),
        ...(Array.isArray(args.videoReferencePaths) ? { videoReferencePaths: args.videoReferencePaths } : {}),
        ...(Array.isArray(args.referenceFromClips) ? { referenceFromClips: args.referenceFromClips } : {}),
        ...(typeof args.note === 'string' ? { note: args.note } : {}),
      }
      return JSON.stringify(await submitAndAwait([action]), null, 2)
    },
  },
]

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ── JSON-RPC / MCP transport ─────────────────────────────────────────────────
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(msg) {
  const { id, method, params } = msg
  // Notifications (no id) need no reply.
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') { reply(id, {}); return }
  if (method === 'tools/list') {
    reply(id, {
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    })
    return
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name)
    if (!tool) { replyError(id, -32602, `unknown tool: ${params?.name}`); return }
    try {
      const text = await tool.run(params.arguments || {})
      reply(id, { content: [{ type: 'text', text }] })
    } catch (e) {
      // Tool errors are returned as isError content (the MCP way) so the AI can
      // read the reason and recover, not a transport-level failure.
      reply(id, { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true })
    }
    return
  }
  if (id !== undefined) replyError(id, -32601, `method not found: ${method}`)
}

function main() {
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg
    try { msg = JSON.parse(trimmed) } catch {
      // A malformed line has no id; per JSON-RPC we can't reply meaningfully.
      return
    }
    void handle(msg)
  })
  rl.on('close', () => process.exit(0))
}

// Exported for the smoke test; run as a server when invoked directly.
export { TOOLS, resolveBridge, handle }
if (import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  main()
}
