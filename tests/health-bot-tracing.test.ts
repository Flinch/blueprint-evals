import Anthropic from '@anthropic-ai/sdk'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHealthBot, type ChatClient } from '../examples/health-bot/bot.js'
import { buildSystemPrompt, type Defect } from '../examples/health-bot/prompt.js'
import {
  createTracerFromEnv,
  guardTracer,
  noopTracer,
  type GenerationEnd,
  type GenerationStart,
  type ToolEnd,
  type ToolStart,
  type Tracer,
  type TurnEnd,
  type TurnStart,
} from '../examples/health-bot/tracing.js'

// The Langfuse implementation is replaced here, so these tests need no network and
// never load the SDK. (health-bot-langfuse.test.ts runs the real one against an
// in-memory exporter.)
// A plain function rather than vi.fn(): vitest 5 reports a rejecting mock as a failed test even when the code under test handles it.
const sdk = vi.hoisted(() => ({
  calls: [] as Record<string, unknown>[],
  impl: (async () => undefined) as (options: Record<string, unknown>) => Promise<unknown>,
}))
vi.mock('../examples/health-bot/langfuse-tracer.js', () => ({
  startLangfuseTracer: (options: Record<string, unknown>) => {
    sdk.calls.push(options)
    return sdk.impl(options)
  },
}))

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const NOW = new Date('2026-11-16T12:00:00Z')
const PK = 'pk-lf-SENTINEL-public-4471'
const SK = 'sk-lf-SENTINEL-secret-9902'

type Block = Record<string, unknown>
interface Reply {
  reply: string
  conversation_id: string
  tool_calls: { name: string; args: Record<string, unknown>; result?: unknown }[]
  error?: string
}

function response(content: Block[], stop_reason = 'end_turn', usage: Block = { input_tokens: 10, output_tokens: 10 }): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    usage,
  } as unknown as Anthropic.Message
}
const text = (t: string): Block => ({ type: 'text', text: t })
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}): Block => ({ type: 'tool_use', id, name, input })

type Step = Anthropic.Message | Error

function fakeClient(steps: Step[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = []
  let next = 0
  const client: ChatClient = {
    messages: {
      async create(params) {
        requests.push(structuredClone(params))
        const step = steps[next++]
        if (!step) throw new Error('fake client ran out of scripted responses')
        if (step instanceof Error) throw step
        return step
      },
    },
  }
  return { client, requests }
}

type Event =
  | { kind: 'turn.start'; info: TurnStart }
  | { kind: 'generation.start'; info: GenerationStart }
  | { kind: 'generation.end'; info: GenerationEnd }
  | { kind: 'tool.start'; info: ToolStart }
  | { kind: 'tool.end'; info: ToolEnd }
  | { kind: 'turn.end'; info: TurnEnd }
  | { kind: 'shutdown' }

/** A tracer that writes down what it was told, in order. */
function recordingTracer() {
  const events: Event[] = []
  const tracer: Tracer = {
    startTurn(info) {
      events.push({ kind: 'turn.start', info })
      return {
        generation(g) {
          events.push({ kind: 'generation.start', info: { ...g, messages: [...g.messages] } })
          return { end: e => void events.push({ kind: 'generation.end', info: e }) }
        },
        toolCall(t) {
          events.push({ kind: 'tool.start', info: t })
          return { end: e => void events.push({ kind: 'tool.end', info: e }) }
        },
        end: e => void events.push({ kind: 'turn.end', info: e }),
      }
    },
    async shutdown() {
      events.push({ kind: 'shutdown' })
    },
  }
  return { tracer, events, kinds: () => events.map(e => e.kind) }
}

/**
 * Tracers that fail in each way a real one could.
 *  - throw:  startTurn throws.
 *  - late:   startTurn works, then generation, toolCall and end throw.
 *  - reject: every method returns a rejected promise instead of throwing.
 */
function brokenTracer(mode: 'throw' | 'late' | 'reject'): Tracer {
  const boom = (): never => {
    throw new Error('langfuse is down')
  }
  const rejected = () => Promise.reject(new Error('langfuse is down'))
  if (mode === 'throw') return { startTurn: boom, shutdown: boom as never }
  const fail = mode === 'late' ? boom : rejected
  const turn = { generation: fail, toolCall: fail, end: fail }
  return { startTurn: () => turn as never, shutdown: fail as never }
}

const open: { close(): Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map(b => b.close()))
})

async function start(steps: Step[], options: { defect?: Defect; tracer?: Tracer; log?: (line: string) => void } = {}) {
  const fake = fakeClient(steps)
  const bot = createHealthBot({ client: fake.client, now: () => NOW, log: () => undefined, ...options })
  open.push(bot)
  const url = await bot.listen(0)
  const chat = async (message: string, conversation_id?: string) => {
    const res = await fetch(`${url}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, ...(conversation_id ? { conversation_id } : {}) }),
    })
    return { status: res.status, raw: await res.text() }
  }
  return { ...fake, url, chat }
}
const parse = (raw: string) => JSON.parse(raw) as Reply

describe('what the bot reports to a tracer', () => {
  it('records the turn, each model call with usage, and the tool span, in order', async () => {
    const rec = recordingTracer()
    const t = await start(
      [
        response([text('Checking.'), toolUse('tu_1', 'reschedule_appointment', { date: 'Friday', time: '14:00' })], 'tool_use', {
          input_tokens: 120,
          output_tokens: 30,
          cache_read_input_tokens: 5,
        }),
        response([text('Moved to Friday at 14:00.')], 'end_turn', { input_tokens: 150, output_tokens: 12 }),
      ],
      { tracer: rec.tracer },
    )
    const { status, raw } = await t.chat('Move my appointment to Friday 2pm. Yes, go ahead.')
    const body = parse(raw)
    expect(status).toBe(200)

    expect(rec.kinds()).toEqual([
      'turn.start',
      'generation.start',
      'generation.end',
      'tool.start',
      'tool.end',
      'generation.start',
      'generation.end',
      'turn.end',
    ])
    const [turnStart, gen1Start, gen1End, toolStart, toolEnd, gen2Start, gen2End, turnEnd] = rec.events as [
      Extract<Event, { kind: 'turn.start' }>,
      Extract<Event, { kind: 'generation.start' }>,
      Extract<Event, { kind: 'generation.end' }>,
      Extract<Event, { kind: 'tool.start' }>,
      Extract<Event, { kind: 'tool.end' }>,
      Extract<Event, { kind: 'generation.start' }>,
      Extract<Event, { kind: 'generation.end' }>,
      Extract<Event, { kind: 'turn.end' }>,
    ]

    // The session is the conversation.
    expect(turnStart.info.sessionId).toBe(body.conversation_id)
    expect(turnStart.info.input).toBe('Move my appointment to Friday 2pm. Yes, go ahead.')
    expect(turnStart.info.tags).toEqual(['defect:none'])
    expect(turnStart.info.metadata).toEqual({ model: 'claude-haiku-5-5' })

    // One generation per model call, with the system prompt, the messages as sent, and usage.
    const system = buildSystemPrompt(undefined, NOW)
    expect(gen1Start.info.model).toBe('claude-haiku-5-5')
    expect(gen1Start.info.system).toBe(system)
    expect(gen1Start.info.messages).toEqual([{ role: 'user', content: 'Move my appointment to Friday 2pm. Yes, go ahead.' }])
    expect(gen1Start.info.modelParameters).toEqual({ max_tokens: 2048, effort: 'low' })
    expect(gen1End.info.usage).toEqual({ input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 5 })
    expect(gen1End.info.stopReason).toBe('tool_use')
    // The second call sees the first call's assistant turn and the tool result. The first call's
    // snapshot must not have grown, even though the bot keeps appending to one history array.
    expect(gen1Start.info.messages).toHaveLength(1)
    expect(gen2Start.info.messages).toHaveLength(3)
    expect(gen2End.info.usage).toEqual({ input_tokens: 150, output_tokens: 12 })
    expect(gen2End.info.stopReason).toBe('end_turn')

    // One tool span with name, arguments and the status the tool returned.
    expect(toolStart.info).toEqual({ name: 'reschedule_appointment', args: { date: 'Friday', time: '14:00' } })
    expect(toolEnd.info).toEqual({ status: 'rescheduled', isError: false })

    expect(turnEnd.info).toEqual({ status: 200, output: 'Checking.\n\nMoved to Friday at 14:00.', toolCallCount: 1 })
    expect(body.tool_calls).toEqual([{ name: 'reschedule_appointment', args: { date: 'Friday', time: '14:00' }, result: { status: 'rescheduled' } }])
  })

  it('tags the trace with the active defect', async () => {
    const rec = recordingTracer()
    const t = await start([response([text('Sure.')])], { tracer: rec.tracer, defect: 'no-confirm' })
    await t.chat('hello')
    const turn = rec.events.find(e => e.kind === 'turn.start') as Extract<Event, { kind: 'turn.start' }>
    expect(turn.info.tags).toEqual(['defect:no-confirm'])
  })

  it('puts two turns of one conversation in one session, and a new conversation in another', async () => {
    const rec = recordingTracer()
    const t = await start([response([text('one')]), response([text('two')]), response([text('three')])], { tracer: rec.tracer })
    const first = parse((await t.chat('first message')).raw)
    const second = parse((await t.chat('second message', first.conversation_id)).raw)
    const other = parse((await t.chat('someone else')).raw)
    const sessions = rec.events.filter(e => e.kind === 'turn.start').map(e => (e as Extract<Event, { kind: 'turn.start' }>).info.sessionId)
    expect(sessions).toEqual([first.conversation_id, first.conversation_id, other.conversation_id])
    expect(second.conversation_id).toBe(first.conversation_id)
    expect(other.conversation_id).not.toBe(first.conversation_id)
  })

  it('records a failed tool call as an error status, and a failed model call without leaking its message', async () => {
    const rec = recordingTracer()
    const t = await start(
      [
        response([toolUse('c1', 'cancel_appointment')], 'tool_use'),
        response([toolUse('c2', 'cancel_appointment')], 'tool_use'),
        Anthropic.APIError.generate(500, { error: { message: 'secret detail' } }, 'secret detail', new Headers()),
      ],
      { tracer: rec.tracer },
    )
    const { status, raw } = await t.chat('cancel it')
    expect(status).toBe(502)
    const tools = rec.events.filter(e => e.kind === 'tool.end') as Extract<Event, { kind: 'tool.end' }>[]
    expect(tools.map(e => e.info)).toEqual([
      { status: 'cancelled', isError: false },
      { status: 'no_active_appointment', isError: true },
    ])
    const ends = rec.events.filter(e => e.kind === 'generation.end') as Extract<Event, { kind: 'generation.end' }>[]
    expect(ends.at(-1)!.info).toEqual({ error: 'upstream error (500)' })
    const turnEnd = rec.events.at(-1) as Extract<Event, { kind: 'turn.end' }>
    expect(turnEnd.kind).toBe('turn.end')
    expect(turnEnd.info.status).toBe(502)
    expect(JSON.stringify(rec.events.map(e => ('info' in e && (e.kind === 'generation.end' || e.kind === 'turn.end') ? e.info : null)))).not.toContain('secret detail')
    expect(raw).not.toContain('secret detail')
  })

  it('does not trace requests that never become a turn', async () => {
    const rec = recordingTracer()
    const t = await start([], { tracer: rec.tracer })
    expect((await t.chat('')).status).toBe(400)
    expect((await fetch(`${t.url}/health`)).status).toBe(200)
    expect(rec.events).toEqual([])
  })
})

describe('tracing cannot change the bot', () => {
  const script = (): Step[] => [
    response([text('Let me check.'), toolUse('a', 'book_appointment', { patient_first_name: 'Sam', date: 'Saturday', time: '09:30' })], 'tool_use'),
    response([text('Booked.')]),
    response([toolUse('b', 'cancel_appointment'), toolUse('c', 'cancel_appointment')], 'tool_use'),
    response([text('Done.')]),
    response([text('Anything else?')]),
    Anthropic.APIError.generate(529, { error: { message: 'overloaded' } }, 'overloaded', new Headers()),
  ]

  /** Runs the same conversation and returns everything an outside observer can see. */
  async function observe(tracer: Tracer | undefined) {
    const lines: string[] = []
    const t = await start(script(), { tracer, log: l => lines.push(l) })
    const turns = []
    let id: string | undefined
    for (const message of ['book Saturday', 'now cancel', 'thanks', 'one more thing']) {
      const r = await t.chat(message, id)
      id ??= parse(r.raw).conversation_id
      turns.push({ status: r.status, raw: r.raw.replaceAll(id, '<id>') })
    }
    const appt = await (await fetch(`${t.url}/appointments/${id}`)).text()
    return { turns, appt, requests: t.requests, lines }
  }

  it('gives byte-identical responses and model requests with a recording tracer, and without one', async () => {
    const plain = await observe(undefined)
    const traced = await observe(recordingTracer().tracer)
    expect(traced.turns).toEqual(plain.turns)
    expect(traced.appt).toBe(plain.appt)
    expect(JSON.stringify(traced.requests)).toBe(JSON.stringify(plain.requests))
    expect(traced.lines).toEqual(plain.lines)
    // Sanity: the scenario did exercise success, tools and a failure.
    expect(plain.turns.map(t => t.status)).toEqual([200, 200, 200, 502])
  })

  for (const mode of ['throw', 'late', 'reject'] as const) {
    it(`gives the same responses when the tracer fails (${mode})`, async () => {
      const plain = await observe(undefined)
      const broken = await observe(brokenTracer(mode))
      expect(broken.turns).toEqual(plain.turns)
      expect(broken.appt).toBe(plain.appt)
      expect(JSON.stringify(broken.requests)).toBe(JSON.stringify(plain.requests))
      // At most one short line for the whole run, with no conversation text in it.
      const tracingLines = broken.lines.filter(l => l.includes('tracing'))
      expect(tracingLines.length).toBeLessThanOrEqual(1)
      expect(broken.lines.filter(l => !l.includes('tracing'))).toEqual(plain.lines)
      for (const line of tracingLines) {
        expect(line.length).toBeLessThan(120)
        expect(line).not.toMatch(/book Saturday|cancel|Sam/)
      }
    })
  }

  it('a tracer whose log sink throws still changes nothing', async () => {
    const t = await start([response([text('hi')])], {
      tracer: brokenTracer('throw'),
      log: () => {
        throw new Error('log sink failed')
      },
    })
    const r = await t.chat('hello')
    expect(r.status).toBe(200)
    expect(parse(r.raw).reply).toBe('hi')
  })

  it('guardTracer hands back no-op handles when startTurn, generation and toolCall fail', async () => {
    const lines: string[] = []
    const guarded = guardTracer(brokenTracer('throw'), l => lines.push(l))
    const turn = guarded.startTurn({ sessionId: 's', input: 'x', tags: [], metadata: {} })
    expect(() => {
      turn.generation({ model: 'm', system: '', messages: [], modelParameters: { max_tokens: 1, effort: 'low' } }).end({})
      turn.toolCall({ name: 't', args: {} }).end({ status: 'ok', isError: false })
      turn.end({ status: 200 })
    }).not.toThrow()
    await expect(guarded.shutdown()).resolves.toBeUndefined()
    expect(lines).toHaveLength(1)
  })
})

describe('turning tracing on and off from the environment', () => {
  beforeEach(() => {
    sdk.calls.length = 0
    sdk.impl = async () => undefined
  })

  it('is the no-op tracer, and the SDK is never started, without keys', async () => {
    for (const env of [{}, { LANGFUSE_PUBLIC_KEY: PK }, { LANGFUSE_SECRET_KEY: SK }, { LANGFUSE_PUBLIC_KEY: '', LANGFUSE_SECRET_KEY: '  ' }]) {
      const lines: string[] = []
      const setup = await createTracerFromEnv(env, l => lines.push(l))
      expect(setup.tracer).toBe(noopTracer)
      expect(setup.enabled).toBe(false)
      expect(setup.failed).toBeUndefined()
      expect(lines).toEqual([])
    }
    expect(sdk.calls).toEqual([])
  })

  it('a bot created without a tracer behaves as before and never touches the SDK', async () => {
    const t = await start([response([text('hi')])])
    expect((await t.chat('hello')).status).toBe(200)
    expect(sdk.calls).toEqual([])
  })

  it('starts the SDK once with both keys, defaulting to the EU cloud', async () => {
    sdk.impl = async () => recordingTracer().tracer
    const setup = await createTracerFromEnv({ LANGFUSE_PUBLIC_KEY: PK, LANGFUSE_SECRET_KEY: SK }, () => undefined)
    expect(setup.enabled).toBe(true)
    expect(setup.host).toBe('cloud.langfuse.com')
    expect(sdk.calls).toHaveLength(1)
    expect(sdk.calls[0]).toMatchObject({ publicKey: PK, secretKey: SK, baseUrl: 'https://cloud.langfuse.com', quietSdk: true })
  })

  it('honours LANGFUSE_BASE_URL for the US region, and leaves the SDK logger alone when asked', async () => {
    sdk.impl = async () => recordingTracer().tracer
    const setup = await createTracerFromEnv(
      { LANGFUSE_PUBLIC_KEY: PK, LANGFUSE_SECRET_KEY: SK, LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com/', LANGFUSE_LOG_LEVEL: 'DEBUG' },
      () => undefined,
    )
    expect(setup.host).toBe('us.cloud.langfuse.com')
    expect(sdk.calls[0]).toMatchObject({ baseUrl: 'https://us.cloud.langfuse.com', quietSdk: false })
  })

  it('falls back to no tracing, with one line that holds no key, when the SDK fails to start', async () => {
    sdk.impl = async () => {
      throw new TypeError(`bad credentials ${PK} ${SK}`)
    }
    const lines: string[] = []
    const setup = await createTracerFromEnv({ LANGFUSE_PUBLIC_KEY: PK, LANGFUSE_SECRET_KEY: SK }, l => lines.push(l))
    expect(setup).toMatchObject({ enabled: false, failed: true })
    expect(setup.tracer).toBe(noopTracer)
    expect(lines).toHaveLength(1)
    expect(lines.join('\n')).not.toContain(PK)
    expect(lines.join('\n')).not.toContain(SK)
    expect(lines[0]).toContain('TypeError')
  })

  it('rejects a base URL that is not http(s) without starting the SDK or printing it', async () => {
    const lines: string[] = []
    const setup = await createTracerFromEnv({ LANGFUSE_PUBLIC_KEY: PK, LANGFUSE_SECRET_KEY: SK, LANGFUSE_BASE_URL: 'file:///etc/passwd' }, l => lines.push(l))
    expect(setup.enabled).toBe(false)
    expect(sdk.calls).toEqual([])
    expect(lines.join('\n')).not.toContain('passwd')
  })

  it('never logs a key, even when the tracer fails while the bot is serving', async () => {
    const lines: string[] = []
    sdk.impl = async () =>
      ({
        startTurn: () => {
          throw new Error(`rejected ${PK}:${SK}`)
        },
        shutdown: async () => undefined,
      }) satisfies Tracer
    const setup = await createTracerFromEnv({ LANGFUSE_PUBLIC_KEY: PK, LANGFUSE_SECRET_KEY: SK }, l => lines.push(l))
    const t = await start([response([text('hi')])], { tracer: setup.tracer, log: l => lines.push(l) })
    expect((await t.chat('hello')).status).toBe(200)
    expect(lines.filter(l => l.includes('tracing'))).toHaveLength(1)
    expect(lines.join('\n')).not.toContain(PK)
    expect(lines.join('\n')).not.toContain(SK)
  })
})

describe('serve.ts with tracing', () => {
  // Port 0 only. A temp working folder, so a real .env in the repo cannot change the result.
  const tsx = join(root, 'node_modules/.bin/tsx')
  const serve = join(root, 'examples/health-bot/serve.ts')
  const dirs: string[] = []
  afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })))

  function run(extraEnv: Record<string, string>) {
    const cwd = mkdtempSync(join(tmpdir(), 'health-bot-serve-'))
    dirs.push(cwd)
    const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PORT: '0', ...extraEnv }
    const child = spawn(tsx, [serve], { cwd, env })
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
    const started = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start: ${out}${err}`)), 25_000)
      const check = setInterval(() => {
        if (/Langfuse tracing: /.test(out)) {
          clearTimeout(timer)
          clearInterval(check)
          resolve()
        }
      }, 50)
    })
    return { child, exited, started, output: () => ({ out, err }) }
  }

  it('says tracing is off, and how to turn it on, without keys', async () => {
    const r = run({})
    try {
      await r.started
      expect(r.output().out).toContain('Langfuse tracing: off (set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY in .env to turn it on)')
    } finally {
      r.child.kill()
      await r.exited
    }
  }, 40_000)

  it('says tracing is on with the host only, never a key, and flushes and exits on SIGTERM', async () => {
    // A closed local port: the real SDK starts, but there is nothing to connect to and nothing to send.
    const r = run({ LANGFUSE_PUBLIC_KEY: PK, LANGFUSE_SECRET_KEY: SK, LANGFUSE_BASE_URL: 'http://127.0.0.1:9' })
    try {
      await r.started
      expect(r.output().out).toContain('Langfuse tracing: on (127.0.0.1:9)')
      r.child.kill('SIGTERM')
      expect(await r.exited).toBe(143)
    } finally {
      r.child.kill('SIGKILL')
    }
    const { out, err } = r.output()
    expect(out + err).not.toContain(PK)
    expect(out + err).not.toContain(SK)
  }, 40_000)
})
