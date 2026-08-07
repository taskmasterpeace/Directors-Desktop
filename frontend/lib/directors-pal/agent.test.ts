import { describe, it, expect } from 'vitest'
import { runAgent, type LLMTurn, type Tool, type ToolContext, type ToolCall } from './agent'

// A scripted LLM: returns queued responses in order (last one repeats).
function scriptedLLM(responses: Array<{ content?: string | null; tool_calls?: ToolCall[] }>): { call: LLMTurn; seenToolCounts: number[] } {
  let i = 0
  const seenToolCounts: number[] = []
  const call: LLMTurn = async (_messages, tools) => {
    seenToolCounts.push(tools.length)
    const r = responses[Math.min(i, responses.length - 1)]
    i++
    return { message: r }
  }
  return { call, seenToolCounts }
}

const noopCtx: ToolContext = {
  fetchJson: async () => ({}),
  fetchText: async () => '',
  knowledge: 'KB',
}

function toolCall(name: string, args: Record<string, unknown> = {}, id = 't1'): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

describe('runAgent — the tool-calling loop', () => {
  it('executes a tool call, feeds the result back, and returns the final prose', async () => {
    const calls: string[] = []
    const echo: Tool = {
      spec: { type: 'function', function: { name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} } } },
      run: async (args) => { calls.push(JSON.stringify(args)); return { ok: true, result: 'echoed:' + (args.text ?? '') } },
    }
    const { call } = scriptedLLM([
      { tool_calls: [toolCall('echo', { text: 'hi' })] },
      { content: 'All done — I echoed it.' },
    ])
    const res = await runAgent({ system: 'sys', history: [{ role: 'user', content: 'echo hi' }], tools: [echo], ctx: noopCtx, callLLM: call })
    expect(calls).toEqual(['{"text":"hi"}'])
    expect(res.reply).toBe('All done — I echoed it.')
    expect(res.steps).toHaveLength(1)
    expect(res.steps[0]).toMatchObject({ tool: 'echo', ok: true, result: 'echoed:hi' })
    // The thread carried a tool message back to the model.
    expect(res.messages.some((m) => m.role === 'tool' && m.content === 'echoed:hi')).toBe(true)
  })

  it('returns immediately when the model answers with no tool call', async () => {
    const { call } = scriptedLLM([{ content: 'You add captions from the transcript panel.' }])
    const res = await runAgent({ system: 's', history: [{ role: 'user', content: 'how do I caption?' }], tools: [], ctx: noopCtx, callLLM: call })
    expect(res.reply).toContain('captions')
    expect(res.steps).toHaveLength(0)
  })

  it('reports an unknown tool without crashing and keeps going', async () => {
    const { call } = scriptedLLM([
      { tool_calls: [toolCall('does_not_exist')] },
      { content: 'Sorry, I could not do that.' },
    ])
    const res = await runAgent({ system: 's', history: [], tools: [], ctx: noopCtx, callLLM: call })
    expect(res.steps[0].ok).toBe(false)
    expect(res.steps[0].result).toContain('Unknown tool')
    expect(res.reply).toContain('could not')
  })

  it('captures a throwing tool as a failed step (not a crash)', async () => {
    const boom: Tool = {
      spec: { type: 'function', function: { name: 'boom', description: 'x', parameters: { type: 'object', properties: {} } } },
      run: async () => { throw new Error('kaboom') },
    }
    const { call } = scriptedLLM([{ tool_calls: [toolCall('boom')] }, { content: 'handled' }])
    const res = await runAgent({ system: 's', history: [], tools: [boom], ctx: noopCtx, callLLM: call })
    expect(res.steps[0].ok).toBe(false)
    expect(res.steps[0].result).toContain('kaboom')
  })

  it('stops at maxIters and forces a tool-free wrap-up', async () => {
    const loop: Tool = {
      spec: { type: 'function', function: { name: 'loop', description: 'x', parameters: { type: 'object', properties: {} } } },
      run: async () => ({ ok: true, result: 'again' }),
    }
    // Always asks for a tool → would loop forever without the cap.
    const { call, seenToolCounts } = scriptedLLM([
      { tool_calls: [toolCall('loop')] }, // iter 1
      { tool_calls: [toolCall('loop')] }, // iter 2 (repeats)
      { content: 'Wrap-up after cap.' },   // the forced final call
    ])
    const res = await runAgent({ system: 's', history: [], tools: [loop], ctx: noopCtx, callLLM: call, maxIters: 2 })
    expect(res.steps.length).toBe(2)
    // The final wrap-up call was made WITHOUT tools.
    expect(seenToolCounts[seenToolCounts.length - 1]).toBe(0)
    expect(res.reply).toBe('Wrap-up after cap.')
  })
})
