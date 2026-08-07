/**
 * Director's Pal — the renderer-side agent loop.
 *
 * The backend (`/api/assistant/chat`) is a thin OpenRouter proxy that returns
 * ONE turn (content + optional tool_calls). This loop owns the rest: it feeds
 * the model the tool schemas, executes any tool_calls locally (that's how the
 * assistant "touches everything" — generate, queue, edit the timeline, perceive
 * a clip), appends the results, and loops until the model answers in prose.
 *
 * Everything is dependency-injected (`callLLM`, the tools, the ctx) so the whole
 * loop is unit-testable without a live LLM, network, or Electron.
 */

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

/** OpenAI/OpenRouter-style function tool schema. */
export interface ToolSpec {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** One backend turn: given the running thread + tool schemas, return the reply. */
export type LLMTurn = (
  messages: ChatMessage[],
  tools: ToolSpec[],
) => Promise<{ message: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string | null }>

/** A tool the assistant can call. `run` returns text the model reads next turn. */
export interface Tool {
  spec: ToolSpec
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<{ ok: boolean; result: string }>
}

/** Injected capabilities the tools use — real in the app, faked in tests. */
export interface ToolContext {
  /** GET/POST the local backend; returns parsed JSON (throws on non-2xx). */
  fetchJson: (path: string, init?: RequestInit) => Promise<unknown>
  /** GET the local backend; returns the raw text body (for text/plain endpoints). */
  fetchText: (path: string, init?: RequestInit) => Promise<string>
  /** Perception: resolve a clip id → a saved frame image path (or null). */
  resolveClipFrame?: (clipId: string) => Promise<string | null>
  /** Open the Help Center to a section (UI side-effect). */
  openHelp?: (sectionId?: string) => void
  /** Compact help knowledge (also injected into the system prompt). */
  knowledge: string
}

export interface AgentStep {
  tool: string
  args: Record<string, unknown>
  result: string
  ok: boolean
}

export interface AgentResult {
  reply: string
  steps: AgentStep[]
  /** The full thread (for continuing the conversation). */
  messages: ChatMessage[]
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const v: unknown = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Run the assistant to a prose answer, executing any tool calls along the way.
 * `history` is prior turns (user/assistant/tool); the system prompt is prepended.
 */
export async function runAgent(opts: {
  system: string
  history: ChatMessage[]
  tools: Tool[]
  ctx: ToolContext
  callLLM: LLMTurn
  maxIters?: number
}): Promise<AgentResult> {
  const specs = opts.tools.map((t) => t.spec)
  const byName = new Map(opts.tools.map((t) => [t.spec.function.name, t]))
  const messages: ChatMessage[] = [{ role: 'system', content: opts.system }, ...opts.history]
  const steps: AgentStep[] = []
  const maxIters = Math.max(1, opts.maxIters ?? 6)

  for (let i = 0; i < maxIters; i++) {
    const { message } = await opts.callLLM(messages, specs)
    const toolCalls = message.tool_calls ?? []
    messages.push({
      role: 'assistant',
      content: message.content ?? null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    })

    if (toolCalls.length === 0) {
      return { reply: message.content ?? '', steps, messages }
    }

    for (const call of toolCalls) {
      const tool = byName.get(call.function.name)
      const args = parseArgs(call.function.arguments)
      let out: { ok: boolean; result: string }
      if (!tool) {
        out = { ok: false, result: `Unknown tool: ${call.function.name}` }
      } else {
        try {
          out = await tool.run(args, opts.ctx)
        } catch (e) {
          out = { ok: false, result: `Error: ${e instanceof Error ? e.message : 'tool failed'}` }
        }
      }
      steps.push({ tool: call.function.name, args, result: out.result, ok: out.ok })
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: out.result })
    }
  }

  // Hit the step cap — force a plain-language wrap-up (no tools this time).
  const final = await opts.callLLM(
    [...messages, { role: 'user', content: 'Stop here and tell me, in plain language, what you did and the result.' }],
    [],
  )
  const reply = final.message.content ?? '(I took several steps but couldn’t wrap up — check the timeline/queue.)'
  messages.push({ role: 'assistant', content: reply })
  return { reply, steps, messages }
}
