import Anthropic from '@anthropic-ai/sdk'
import { LangfuseOtelSpanAttributes as A } from '@langfuse/core'
import { trace } from '@opentelemetry/api'
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createHealthBot, type ChatClient } from '../examples/health-bot/bot.js'
import { startLangfuseTracer, type LangfuseTracer } from '../examples/health-bot/langfuse-tracer.js'

// The real Langfuse tracer with the real SDK, but with an in-memory exporter in place of the
// network. This checks what would be sent (attribute names and values, nesting), not that
// Langfuse Cloud accepts it. That needs an account.

const PK = 'pk-lf-SENTINEL-public-4471'
const SK = 'sk-lf-SENTINEL-secret-9902'

const exporter = new InMemorySpanExporter()
let tracer: LangfuseTracer

beforeAll(async () => {
  tracer = await startLangfuseTracer({
    publicKey: PK,
    secretKey: SK,
    baseUrl: 'http://127.0.0.1:9',
    quietSdk: true,
    exporter,
    exportMode: 'immediate',
  })
})
afterAll(async () => {
  await tracer.shutdown()
})
afterEach(async () => {
  await Promise.all(open.splice(0).map(b => b.close()))
  exporter.reset()
})

const open: { close(): Promise<void> }[] = []
type Block = Record<string, unknown>
function response(content: Block[], stop_reason: string, usage: Block): Anthropic.Message {
  return { id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content, stop_reason, stop_sequence: null, usage } as unknown as Anthropic.Message
}

async function chatWith(steps: Anthropic.Message[], defect?: 'no-confirm') {
  let next = 0
  const client: ChatClient = { messages: { create: async () => steps[next++]! } }
  const bot = createHealthBot({ client, tracer, defect, log: () => undefined, now: () => new Date('2026-11-16T12:00:00Z') })
  open.push(bot)
  const url = await bot.listen(0)
  return async (message: string, conversation_id?: string) => {
    const res = await fetch(`${url}/chat`, { method: 'POST', body: JSON.stringify({ message, ...(conversation_id ? { conversation_id } : {}) }) })
    return { status: res.status, body: (await res.json()) as { reply: string; conversation_id: string } }
  }
}

const attr = (s: ReadableSpan, key: string) => s.attributes[key]
const json = (s: ReadableSpan, key: string) => JSON.parse(String(s.attributes[key]))
const parentId = (s: ReadableSpan) => s.parentSpanContext?.spanId

describe('the Langfuse tracer', () => {
  it('records one trace per turn: a root, a generation per model call and a tool span, all in the session', async () => {
    const chat = await chatWith(
      [
        response([{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'tu_1', name: 'cancel_appointment', input: {} }], 'tool_use', {
          input_tokens: 120,
          output_tokens: 30,
          cache_read_input_tokens: 5,
        }),
        response([{ type: 'text', text: 'Cancelled.' }], 'end_turn', { input_tokens: 150, output_tokens: 12 }),
        response([{ type: 'text', text: 'You are welcome.' }], 'end_turn', { input_tokens: 170, output_tokens: 6 }),
      ],
      'no-confirm',
    )
    const first = await chat('Please cancel my appointment')
    expect(first.status).toBe(200)
    const second = await chat('Thanks', first.body.conversation_id)
    expect(second.status).toBe(200)
    await tracer.flush()

    const spans = exporter.getFinishedSpans()
    const turns = spans.filter(s => attr(s, A.OBSERVATION_TYPE) === 'span')
    expect(turns.map(s => s.name)).toEqual(['chat-turn', 'chat-turn'])
    const [turn1] = turns as [ReadableSpan, ReadableSpan]

    // Everything of a turn shares one trace, and every observation carries the session and tags.
    const inTurn1 = spans.filter(s => s.spanContext().traceId === turn1.spanContext().traceId)
    expect(inTurn1.map(s => attr(s, A.OBSERVATION_TYPE)).sort()).toEqual(['generation', 'generation', 'span', 'tool'])
    for (const s of spans) {
      expect(attr(s, A.TRACE_SESSION_ID)).toBe(first.body.conversation_id)
      expect(attr(s, A.TRACE_TAGS)).toEqual(['defect:no-confirm'])
      expect(attr(s, A.TRACE_NAME)).toBe('chat-turn')
      expect(JSON.parse(String(attr(s, `${A.TRACE_METADATA}.model`)))).toBe('claude-haiku-5-5')
      // No user id and no IP address.
      expect(attr(s, A.TRACE_USER_ID)).toBeUndefined()
      expect(attr(s, 'langfuse.user.id')).toBeUndefined()
      const keys = Object.keys(s.attributes)
      expect(keys.filter(k => /^(user\.|langfuse\.user\.|client\.|http\.client_ip|net\.)/.test(k))).toEqual([])
    }
    // Two turns of one conversation: two traces, one session.
    expect(turns[1]!.spanContext().traceId).not.toBe(turn1.spanContext().traceId)

    // Root: input and output are the patient message and the reply.
    expect(attr(turn1, A.OBSERVATION_INPUT)).toBe('Please cancel my appointment')
    expect(attr(turn1, A.OBSERVATION_OUTPUT)).toBe('Checking.\n\nCancelled.')

    // Spans export in the order they end, which is not guaranteed to be the order they started.
    const startNs = (s: ReadableSpan) => s.startTime[0] * 1e9 + s.startTime[1]
    const gens = inTurn1.filter(s => attr(s, A.OBSERVATION_TYPE) === 'generation').sort((a, b) => startNs(a) - startNs(b))
    const tool = inTurn1.find(s => attr(s, A.OBSERVATION_TYPE) === 'tool')!
    for (const s of [...gens, tool]) expect(parentId(s)).toBe(turn1.spanContext().spanId)

    // Generations: model, input with the system prompt first, output, usage in separate buckets.
    const [g1, g2] = gens as [ReadableSpan, ReadableSpan]
    expect(attr(g1, A.OBSERVATION_MODEL)).toBe('claude-haiku-5-5')
    expect(json(g1, A.OBSERVATION_MODEL_PARAMETERS)).toEqual({ max_tokens: 2048, effort: 'low' })
    const input1 = json(g1, A.OBSERVATION_INPUT) as { role: string; content: unknown }[]
    expect(input1.map(m => m.role)).toEqual(['system', 'user'])
    expect(String(input1[0]!.content)).toContain('Maple Family Clinic')
    expect(json(g1, A.OBSERVATION_USAGE_DETAILS)).toEqual({ input: 120, output: 30, cache_read_input_tokens: 5 })
    expect(json(g2, A.OBSERVATION_USAGE_DETAILS)).toEqual({ input: 150, output: 12 })
    expect((json(g2, A.OBSERVATION_INPUT) as unknown[]).length).toBe(4) // system, user, assistant, tool result
    expect(json(g1, A.OBSERVATION_OUTPUT)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'tu_1', name: 'cancel_appointment', input: {} }],
    })

    // Tool span: name, arguments and the status it returned.
    expect(tool.name).toBe('cancel_appointment')
    expect(json(tool, A.OBSERVATION_INPUT)).toEqual({})
    expect(json(tool, A.OBSERVATION_OUTPUT)).toEqual({ status: 'cancelled' })

    // The Langfuse keys appear nowhere in what would be sent.
    expect(JSON.stringify(spans.map(s => s.attributes))).not.toContain(PK)
    expect(JSON.stringify(spans.map(s => s.attributes))).not.toContain(SK)
  })

  it('marks a failed tool call as an error', async () => {
    const chat = await chatWith([
      response([{ type: 'tool_use', id: 't', name: 'reschedule_appointment', input: { date: '', time: '' } }], 'tool_use', { input_tokens: 1, output_tokens: 1 }),
      { stop_reason: 'end_turn', content: [], usage: {} } as unknown as Anthropic.Message,
    ])
    const { status } = await chat('move it')
    expect(status).toBe(200)
    await tracer.flush()
    const tool = exporter.getFinishedSpans().find(s => attr(s, A.OBSERVATION_TYPE) === 'tool')!
    expect(attr(tool, A.OBSERVATION_LEVEL)).toBe('ERROR')
    expect(json(tool, A.OBSERVATION_OUTPUT)).toEqual({ status: 'invalid_arguments' })
  })

  it('exports only its own observations, not spans from other instrumentation', async () => {
    const other = trace.getTracer('some.other.instrumentation')
    other.startSpan('anthropic.messages.create', { attributes: { 'gen_ai.request.model': 'claude-haiku-5-5' } }).end()
    await tracer.flush()
    expect(exporter.getFinishedSpans()).toEqual([])
  })
})
