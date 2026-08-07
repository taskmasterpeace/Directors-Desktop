/**
 * Director's Pal tools — the assistant's hands.
 *
 * Each tool maps to a real Directors Desktop endpoint/capability so the chat can
 * actually DO things: read the timeline, generate images (single or a batch put
 * in the queue), generate video, edit the timeline through the agent bridge,
 * PERCEIVE a clip (grab a frame + caption it), and open the Help. Tools are
 * pure w.r.t. their injected ToolContext, so they're unit-testable with a fake.
 */
import type { Tool, ToolContext } from './agent'

const MAX_IMAGES = 8

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}
function int(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined
}

/** Small helper: POST JSON to the backend and return the parsed result. */
function post(ctx: ToolContext, path: string, body: unknown): Promise<unknown> {
  return ctx.fetchJson(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export const DIRECTORS_PAL_TOOLS: Tool[] = [
  {
    spec: {
      type: 'function',
      function: {
        name: 'read_timeline',
        description:
          'Read the production currently open in the editor as a compact table-of-contents (chapters, cast, clips with stable ids). Call this before answering questions about the timeline or editing it.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    run: async (_args, ctx) => {
      try {
        const text = await ctx.fetchText('/api/project/toc?format=text')
        return { ok: true, result: text || '(no project open in the editor)' }
      } catch (e) {
        return { ok: false, result: `Couldn’t read the timeline: ${e instanceof Error ? e.message : 'error'}. Open a project in the editor first.` }
      }
    },
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'generate_images',
        description:
          'Generate one or more images from a text prompt by putting jobs in the render queue. Use count>1 to make a batch. Results land in the Gallery/Gen Space; this returns the queued job ids.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'What to generate.' },
            count: { type: 'integer', description: `How many images (1–${MAX_IMAGES}).`, minimum: 1, maximum: MAX_IMAGES },
            aspectRatio: { type: 'string', description: 'e.g. "16:9", "9:16", "1:1".' },
            model: { type: 'string', description: 'Optional model id; omit to use the user’s default.' },
          },
          required: ['prompt'],
          additionalProperties: false,
        },
      },
    },
    run: async (args, ctx) => {
      const prompt = str(args.prompt)
      if (!prompt) return { ok: false, result: 'A prompt is required.' }
      const count = Math.min(MAX_IMAGES, Math.max(1, int(args.count) ?? 1))
      const aspectRatio = str(args.aspectRatio) ?? '16:9'
      const model = str(args.model)
      const ids: string[] = []
      for (let i = 0; i < count; i++) {
        const body = {
          type: 'image',
          ...(model ? { model } : {}),
          params: { prompt, aspectRatio },
          tags: ['directors-pal'],
          ...(count > 1 ? { batch_index: i } : {}),
        }
        const res = (await post(ctx, '/api/queue/submit', body)) as { id?: string }
        if (res?.id) ids.push(res.id)
      }
      return { ok: ids.length > 0, result: ids.length ? `Queued ${ids.length} image job(s): ${ids.join(', ')}. They’ll appear in the Gallery as they finish.` : 'No jobs were accepted.' }
    },
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'generate_video',
        description:
          'Generate a video from a text prompt (and optionally a first-frame image path) by queueing a render job. Returns the job id.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'What should happen in the shot.' },
            imagePath: { type: 'string', description: 'Optional absolute image path to animate from (image-to-video).' },
            durationSeconds: { type: 'integer', description: 'Clip length in seconds.' },
            model: { type: 'string', description: 'Optional video model id.' },
          },
          required: ['prompt'],
          additionalProperties: false,
        },
      },
    },
    run: async (args, ctx) => {
      const prompt = str(args.prompt)
      if (!prompt) return { ok: false, result: 'A prompt is required.' }
      const imagePath = str(args.imagePath)
      const duration = int(args.durationSeconds)
      const model = str(args.model)
      const body = {
        type: 'video',
        ...(model ? { model } : {}),
        params: {
          prompt,
          ...(imagePath ? { imagePath } : {}),
          ...(duration ? { duration: String(duration) } : {}),
        },
        tags: ['directors-pal'],
      }
      const res = (await post(ctx, '/api/queue/submit', body)) as { id?: string }
      return res?.id
        ? { ok: true, result: `Queued video job ${res.id}. Watch the queue for progress.` }
        : { ok: false, result: 'The video job was not accepted.' }
    },
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'queue_status',
        description: 'Check the render queue — how many jobs are queued/running/complete and their recent results.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    run: async (_args, ctx) => {
      const data = (await ctx.fetchJson('/api/queue/status')) as { jobs?: Array<{ status?: string; model?: string; error?: string | null }> }
      const jobs = data.jobs ?? []
      const by = (s: string) => jobs.filter((j) => j.status === s).length
      const summary = `Queue: ${by('running')} running, ${by('queued')} queued, ${by('complete')} complete, ${by('error')} failed (of ${jobs.length}).`
      return { ok: true, result: summary }
    },
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'edit_timeline',
        description:
          'Apply bounded edits to the open timeline through the user’s undo stack (one Ctrl+Z for the batch). Get clip/marker ids from read_timeline first. Action kinds: move_clip{clipId,startTime,trackIndex} · trim_clip{clipId,trimStart,trimEnd} · delete_clip{clipId} · add_marker{marker:{time,title,color?,note?}} · update_marker{markerId,patch} · delete_marker{markerId} · captions_from_transcript{clipId?} · generate_and_place{prompt,at:{trackIndex,startTime}} · regenerate_with_reference{clipId,referenceImagePaths?,referenceFromClips?,note?}.',
        parameters: {
          type: 'object',
          properties: {
            actions: { type: 'array', items: { type: 'object' }, description: 'Bounded editor actions.' },
          },
          required: ['actions'],
          additionalProperties: false,
        },
      },
    },
    run: async (args, ctx) => {
      const actions = Array.isArray(args.actions) ? args.actions : []
      if (actions.length === 0) return { ok: false, result: 'No actions supplied.' }
      const res = (await post(ctx, '/api/project/actions', { actions })) as { ids?: string[] }
      const ids = res?.ids ?? []
      return ids.length
        ? { ok: true, result: `Submitted ${ids.length} edit(s) to the timeline (applied as one undo step). Ids: ${ids.join(', ')}.` }
        : { ok: false, result: 'No edits were accepted — is a project open in the editor?' }
    },
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'look_at_clip',
        description:
          'SEE what a clip actually shows: grabs a frame from the clip and captions it. Use this whenever you need to understand a video the user dropped on the timeline before answering or acting.',
        parameters: {
          type: 'object',
          properties: { clipId: { type: 'string', description: 'Clip id from read_timeline.' } },
          required: ['clipId'],
          additionalProperties: false,
        },
      },
    },
    run: async (args, ctx) => {
      const clipId = str(args.clipId)
      if (!clipId) return { ok: false, result: 'A clipId is required.' }
      if (!ctx.resolveClipFrame) return { ok: false, result: 'Vision isn’t available here (no frame extractor).' }
      const framePath = await ctx.resolveClipFrame(clipId)
      if (!framePath) return { ok: false, result: `Couldn’t grab a frame from clip ${clipId} (media missing?).` }
      const cap = (await post(ctx, '/api/caption-image', { imagePath: framePath })) as { prompt?: string }
      const caption = str(cap?.prompt)
      return caption
        ? { ok: true, result: `Clip ${clipId} shows: ${caption}` }
        : { ok: false, result: 'Grabbed a frame but captioning returned nothing (is an OpenRouter key set?).' }
    },
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'open_help',
        description: 'Open the in-app Help Center, optionally to a specific section id (e.g. "timeline-regen"), when the user would benefit from reading the docs.',
        parameters: {
          type: 'object',
          properties: { sectionId: { type: 'string', description: 'Optional help section id.' } },
          additionalProperties: false,
        },
      },
    },
    run: async (args, ctx) => {
      const sectionId = str(args.sectionId)
      ctx.openHelp?.(sectionId)
      return { ok: true, result: sectionId ? `Opened Help at "${sectionId}".` : 'Opened the Help Center.' }
    },
  },
]

/** Build the system prompt: persona + behavior rules + live context + the help KB. */
export function buildSystemPrompt(opts: { knowledge: string; context?: string }): string {
  return [
    'You are Director’s Pal, the built-in assistant for Directors Desktop — a desktop app for generating images/videos and editing them on a real timeline.',
    'You help two ways: (1) ANSWER questions about how to use the app, grounded ONLY in the KNOWLEDGE below; (2) DO tasks with your tools (generate images/video, batch via the queue, edit the timeline, and SEE clips with look_at_clip).',
    'Rules: Be concise and friendly. Prefer doing over explaining when the user asks for an action. Before editing the timeline, call read_timeline to get real clip ids. To understand a video clip, call look_at_clip. Never invent ids, prices, or features — if it is not in the KNOWLEDGE or a tool result, say you are not sure and offer to open Help. Confirm before anything destructive (deleting clips). Report what you did in plain language.',
    opts.context ? `\nCURRENT CONTEXT:\n${opts.context}` : '',
    `\nKNOWLEDGE (the app’s help, your source of truth for "how do I…"):\n${opts.knowledge}`,
  ]
    .filter(Boolean)
    .join('\n')
}
