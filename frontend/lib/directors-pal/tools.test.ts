import { describe, it, expect } from 'vitest'
import { DIRECTORS_PAL_TOOLS, buildSystemPrompt } from './tools'
import type { ToolContext } from './agent'

function toolByName(name: string) {
  const t = DIRECTORS_PAL_TOOLS.find((x) => x.spec.function.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}

/** A ToolContext that records backend calls and returns canned responses. */
function fakeCtx(overrides: Partial<ToolContext> = {}): { ctx: ToolContext; posts: Array<{ path: string; body: unknown }> } {
  const posts: Array<{ path: string; body: unknown }> = []
  const ctx: ToolContext = {
    knowledge: 'KB',
    fetchText: async (p) => (p.includes('/toc') ? '# TOC\n1. Chapter (m1)' : ''),
    fetchJson: async (p, init) => {
      if (init?.method === 'POST') {
        const body = init.body ? JSON.parse(String(init.body)) : {}
        posts.push({ path: p, body })
        if (p.includes('/queue/submit')) return { id: `job-${posts.length}` }
        if (p.includes('/project/actions')) return { ids: ['act-1'] }
        if (p.includes('/caption-image')) return { prompt: 'a red car at night' }
        return {}
      }
      if (p.includes('/queue/status')) return { jobs: [{ status: 'running' }, { status: 'complete' }] }
      return {}
    },
    ...overrides,
  }
  return { ctx, posts }
}

describe('Director’s Pal tools', () => {
  it('every tool has a well-formed function schema', () => {
    for (const t of DIRECTORS_PAL_TOOLS) {
      expect(t.spec.type).toBe('function')
      expect(t.spec.function.name).toMatch(/^[a-z_]+$/)
      expect(t.spec.function.description.length).toBeGreaterThan(20)
      expect(t.spec.function.parameters).toHaveProperty('type', 'object')
    }
    const names = DIRECTORS_PAL_TOOLS.map((t) => t.spec.function.name)
    expect(new Set(names).size).toBe(names.length) // unique
    for (const must of ['read_timeline', 'generate_images', 'generate_video', 'edit_timeline', 'look_at_clip', 'queue_status', 'open_help']) {
      expect(names).toContain(must)
    }
  })

  it('read_timeline pulls the TOC text', async () => {
    const { ctx } = fakeCtx()
    const out = await toolByName('read_timeline').run({}, ctx)
    expect(out.ok).toBe(true)
    expect(out.result).toContain('TOC')
  })

  it('generate_images queues one job per requested image (capped at 8)', async () => {
    const { ctx, posts } = fakeCtx()
    const out = await toolByName('generate_images').run({ prompt: 'a city', count: 3, aspectRatio: '9:16' }, ctx)
    expect(out.ok).toBe(true)
    const submits = posts.filter((p) => p.path.includes('/queue/submit'))
    expect(submits).toHaveLength(3)
    expect(submits[0].body).toMatchObject({ type: 'image', params: { prompt: 'a city', aspectRatio: '9:16' } })
    // over-cap request is clamped
    const { ctx: ctx2, posts: posts2 } = fakeCtx()
    await toolByName('generate_images').run({ prompt: 'x', count: 99 }, ctx2)
    expect(posts2.filter((p) => p.path.includes('/queue/submit'))).toHaveLength(8)
  })

  it('generate_images rejects an empty prompt', async () => {
    const { ctx, posts } = fakeCtx()
    const out = await toolByName('generate_images').run({ prompt: '   ' }, ctx)
    expect(out.ok).toBe(false)
    expect(posts).toHaveLength(0)
  })

  it('generate_video queues a video job with the prompt', async () => {
    const { ctx, posts } = fakeCtx()
    const out = await toolByName('generate_video').run({ prompt: 'a dolly shot', durationSeconds: 6 }, ctx)
    expect(out.ok).toBe(true)
    expect(posts[0].body).toMatchObject({ type: 'video', params: { prompt: 'a dolly shot', duration: '6' } })
  })

  it('edit_timeline forwards bounded actions to the agent bridge', async () => {
    const { ctx, posts } = fakeCtx()
    const out = await toolByName('edit_timeline').run({ actions: [{ kind: 'add_marker', marker: { time: 5, title: 'hi' } }] }, ctx)
    expect(out.ok).toBe(true)
    expect(posts[0].path).toContain('/project/actions')
    expect(out.result).toContain('undo step')
  })

  it('look_at_clip grabs a frame then captions it (perception)', async () => {
    const { ctx, posts } = fakeCtx({ resolveClipFrame: async () => 'C:/frames/f.jpg' })
    const out = await toolByName('look_at_clip').run({ clipId: 'clip-a' }, ctx)
    expect(out.ok).toBe(true)
    expect(out.result).toContain('red car')
    expect(posts.some((p) => p.path.includes('/caption-image') && (p.body as { imagePath?: string }).imagePath === 'C:/frames/f.jpg')).toBe(true)
  })

  it('look_at_clip fails gracefully when no frame extractor is available', async () => {
    const { ctx } = fakeCtx() // no resolveClipFrame
    const out = await toolByName('look_at_clip').run({ clipId: 'clip-a' }, ctx)
    expect(out.ok).toBe(false)
    expect(out.result).toContain('Vision')
  })

  it('open_help calls the UI hook', async () => {
    let opened: string | undefined | 'none' = 'none'
    const { ctx } = fakeCtx({ openHelp: (id) => { opened = id } })
    const out = await toolByName('open_help').run({ sectionId: 'timeline-regen' }, ctx)
    expect(out.ok).toBe(true)
    expect(opened).toBe('timeline-regen')
  })

  it('the system prompt embeds the knowledge and the persona', () => {
    const sys = buildSystemPrompt({ knowledge: 'HELP-KB-TEXT', context: 'View: Home' })
    expect(sys).toContain('Director’s Pal')
    expect(sys).toContain('HELP-KB-TEXT')
    expect(sys).toContain('View: Home')
  })
})
