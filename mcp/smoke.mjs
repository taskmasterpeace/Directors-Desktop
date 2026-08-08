#!/usr/bin/env node
/**
 * MCP server smoke test — zero-dependency, hermetic.
 *
 * Stands up a FAKE agent bridge (a tiny http server), points the MCP server at
 * it via DD_BRIDGE_URL, spawns the server, and drives the real MCP handshake
 * over stdio: initialize → tools/list → tools/call. Asserts the protocol shape
 * and that each tool actually reached the bridge. No app, no network, no deps.
 *
 *   node mcp/smoke.mjs   →  prints PASS/FAIL lines, exits 0/1
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures++
}

// ── fake bridge ──────────────────────────────────────────────────────────────
const hits = []
let jobCounter = 0
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    hits.push({ method: req.method, url: req.url, auth: req.headers.authorization, body })
    const send = (code, text, type = 'text/plain') => {
      res.writeHead(code, { 'Content-Type': type })
      res.end(text)
    }
    if (req.url === '/api/project/toc?format=text') return send(200, '# PRODUCTION TOC v1 — Test\nCHAPTERS\n  1. "Chapter One" (m1)\nEDITING\n  move_clip{clipId,startTime}')
    if (req.url.startsWith('/api/project/toc?chapter=')) return send(200, '# CHAPTER 1\n  [0:01.0–0:05.0] t3 narrator (clip-a) "hello"')
    if (req.url === '/api/project/current') return send(200, JSON.stringify({ project: { name: 'Test' } }), 'application/json')
    if (req.url === '/api/project/actions' && req.method === 'POST') return send(200, JSON.stringify({ ids: ['act-1'] }), 'application/json')
    if (req.url === '/api/project/actions/status') return send(200, JSON.stringify({ actions: [{ id: 'act-1', status: 'applied' }] }), 'application/json')
    // Director's-Pal-parity surfaces (queue submit/status + perception).
    if (req.url === '/api/queue/submit' && req.method === 'POST') return send(200, JSON.stringify({ id: `job-${++jobCounter}`, status: 'queued' }), 'application/json')
    if (req.url === '/api/queue/status') return send(200, JSON.stringify({ jobs: [{ status: 'running', model: 'x' }, { status: 'complete', model: 'y' }, { status: 'queued', model: 'z' }] }), 'application/json')
    if (req.url === '/api/project/look-at-clip' && req.method === 'POST') return send(200, JSON.stringify({ caption: 'a red car on a rain-slicked street at night' }), 'application/json')
    send(404, JSON.stringify({ detail: `no route: ${req.url}` }), 'application/json')
  })
})

// ── MCP stdio client ─────────────────────────────────────────────────────────
function rpcClient(child) {
  const pending = new Map()
  let buf = ''
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString()
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    }
  })
  let nextId = 1
  return {
    request(method, params) {
      const id = nextId++
      return new Promise((resolve) => {
        pending.set(id, resolve)
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    },
  }
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  const child = spawn(process.execPath, [path.join(here, 'dd-mcp-server.mjs')], {
    env: { ...process.env, DD_BRIDGE_URL: `http://127.0.0.1:${port}`, DD_BRIDGE_TOKEN: 'smoke-token' },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const rpc = rpcClient(child)

  try {
    const init = await rpc.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } })
    check('initialize returns protocolVersion + serverInfo',
      init.result?.protocolVersion === '2024-11-05' && init.result?.serverInfo?.name === 'directors-desktop',
      JSON.stringify(init.result?.serverInfo))
    rpc.notify('notifications/initialized', {})

    const list = await rpc.request('tools/list', {})
    const names = (list.result?.tools ?? []).map((t) => t.name)
    check('tools/list exposes the editor tools',
      ['get_timeline', 'get_chapter', 'get_project_json', 'edit_timeline', 'regenerate_clip'].every((n) => names.includes(n)),
      names.join(','))
    check('tools/list exposes the Director\'s-Pal-parity tools (generate/queue/perception)',
      ['generate_images', 'generate_video', 'queue_status', 'look_at_clip'].every((n) => names.includes(n)),
      names.join(','))
    check('every tool is self-describing (teaches the grammar)',
      (list.result?.tools ?? []).every((t) => (t.description || '').length > 40))

    const toc = await rpc.request('tools/call', { name: 'get_timeline', arguments: {} })
    check('get_timeline returns the TOC text', (toc.result?.content?.[0]?.text || '').includes('PRODUCTION TOC'))
    check('get_timeline carried the Bearer token', hits.at(-1)?.auth === 'Bearer smoke-token')

    const ch = await rpc.request('tools/call', { name: 'get_chapter', arguments: { chapter: 1 } })
    check('get_chapter drills into one chapter', (ch.result?.content?.[0]?.text || '').includes('CHAPTER 1'))
    check('get_chapter passed the chapter param', hits.at(-1)?.url.includes('chapter=1'))

    const edit = await rpc.request('tools/call', { name: 'edit_timeline', arguments: { actions: [{ kind: 'add_marker', marker: { time: 5, title: 'test' } }] } })
    const editText = edit.result?.content?.[0]?.text || ''
    check('edit_timeline submits and reports the per-action result',
      editText.includes('applied') && editText.includes('act-1'), editText.replace(/\s+/g, ' ').slice(0, 80))
    check('edit_timeline POSTed the actions to the bridge',
      hits.some((h) => h.url === '/api/project/actions' && h.method === 'POST' && h.body.includes('add_marker')))

    const regen = await rpc.request('tools/call', { name: 'regenerate_clip', arguments: { clipId: 'clip-a', referenceImagePaths: ['/tmp/ref.jpg'], note: 'warmer light' } })
    const regenText = regen.result?.content?.[0]?.text || ''
    check('regenerate_clip submits and reports the result', regenText.includes('applied') && regenText.includes('act-1'), regenText.replace(/\s+/g, ' ').slice(0, 80))
    check('regenerate_clip POSTed a regenerate_with_reference action for the clip',
      hits.some((h) => h.url === '/api/project/actions' && h.method === 'POST' && h.body.includes('regenerate_with_reference') && h.body.includes('clip-a') && h.body.includes('/tmp/ref.jpg')))

    await rpc.request('tools/call', { name: 'regenerate_clip', arguments: { clipId: 'clip-a', referenceFromClips: [{ clipId: 'clip-b', cropRect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, as: 'image' }] } })
    check('regenerate_clip forwards referenceFromClips (build-a-ref-from-another-clip)',
      hits.some((h) => h.url === '/api/project/actions' && h.method === 'POST' && h.body.includes('referenceFromClips') && h.body.includes('clip-b') && h.body.includes('cropRect')))

    // ── generate_images: one queue job per image, and reaches the bridge ──────
    const gi = await rpc.request('tools/call', { name: 'generate_images', arguments: { prompt: 'a neon skyline', count: 3, aspectRatio: '9:16' } })
    const giText = gi.result?.content?.[0]?.text || ''
    check('generate_images queues one job per image and reports the ids', /Queued 3 image job/.test(giText), giText.slice(0, 80))
    const imgSubmits = hits.filter((h) => h.url === '/api/queue/submit' && h.method === 'POST' && h.body.includes('"type":"image"'))
    check('generate_images POSTed image jobs to /api/queue/submit (one per image)',
      imgSubmits.length === 3 && imgSubmits.every((h) => h.body.includes('a neon skyline') && h.body.includes('9:16') && h.auth === 'Bearer smoke-token'))

    const beforeCap = hits.filter((h) => h.url === '/api/queue/submit' && h.method === 'POST').length
    await rpc.request('tools/call', { name: 'generate_images', arguments: { prompt: 'cap check', count: 20 } })
    const afterCap = hits.filter((h) => h.url === '/api/queue/submit' && h.method === 'POST').length
    check('generate_images caps the batch at 8 jobs', afterCap - beforeCap === 8, `submitted ${afterCap - beforeCap}`)

    // ── generate_video: type video reaches the bridge ─────────────────────────
    const gv = await rpc.request('tools/call', { name: 'generate_video', arguments: { prompt: 'camera pushes in', imagePath: '/tmp/first.jpg', durationSeconds: 5 } })
    const gvText = gv.result?.content?.[0]?.text || ''
    check('generate_video queues a video job and returns its id', gvText.includes('video job') && gvText.includes('job-'), gvText.slice(0, 80))
    check('generate_video POSTed a video job to /api/queue/submit',
      hits.some((h) => h.url === '/api/queue/submit' && h.method === 'POST' && h.body.includes('"type":"video"') && h.body.includes('camera pushes in') && h.body.includes('first.jpg')))

    // ── queue_status: summarizes the queue from the bridge ────────────────────
    const qs = await rpc.request('tools/call', { name: 'queue_status', arguments: {} })
    const qsText = qs.result?.content?.[0]?.text || ''
    check('queue_status summarizes the render queue', qsText.includes('running') && qsText.includes('complete'), qsText.slice(0, 80))
    check('queue_status GET /api/queue/status from the bridge', hits.at(-1)?.url === '/api/queue/status' && hits.at(-1)?.method === 'GET')

    // ── look_at_clip: perception endpoint returns a caption ───────────────────
    const look = await rpc.request('tools/call', { name: 'look_at_clip', arguments: { clipId: 'clip-a' } })
    const lookText = look.result?.content?.[0]?.text || ''
    check('look_at_clip returns the caption (perception)', lookText.includes('red car'), lookText.slice(0, 80))
    check('look_at_clip POSTed the clipId to /api/project/look-at-clip',
      hits.some((h) => h.url === '/api/project/look-at-clip' && h.method === 'POST' && h.body.includes('clip-a') && h.auth === 'Bearer smoke-token'))

    const bad = await rpc.request('tools/call', { name: 'no_such_tool', arguments: {} })
    check('unknown tool is a clean JSON-RPC error', !!bad.error && bad.error.code === -32602)
  } catch (e) {
    check('unexpected error', false, String(e && e.message))
  } finally {
    child.kill()
    server.close()
    console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS')
    process.exit(failures ? 1 : 0)
  }
}

main()
