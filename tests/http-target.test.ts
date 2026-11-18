import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema, RubricSchema, ScenarioSchema, createHttpTarget, interpolateEnv, renderTemplate } from '../src/index.js'
import type { HttpTargetConfig } from '../src/index.js'
import { createStubAgent } from '../examples/stub-agent/agent.js'

const ctx = { runId: 'test' }

function configFor(url: string, overrides: Partial<HttpTargetConfig> = {}): HttpTargetConfig {
  return ConfigSchema.parse({
    models: { simulator: { model: 'm' }, judge: { model: 'm' } },
    targets: {
      t: {
        kind: 'http',
        url,
        request: { body: { message: '{{input.text}}', conversation_id: '{{session}}' } },
        response: {
          text: '$.reply',
          session: '$.conversation_id',
          toolCalls: { path: '$.tool_calls[*]', name: '$.name', arguments: '$.args' },
        },
        ...overrides,
      },
    },
  }).targets.t as HttpTargetConfig
}

describe('http target against the stub agent', () => {
  const good = createStubAgent()
  const bad = createStubAgent({ defect: 'no-confirm' })
  let goodUrl = ''
  let badUrl = ''

  beforeAll(async () => {
    goodUrl = await good.listen()
    badUrl = await bad.listen()
  })
  afterAll(async () => {
    await good.close()
    await bad.close()
  })

  it('carries the session across turns and reports a tool call only after confirmation', async () => {
    const target = createHttpTarget('stub', configFor(`${goodUrl}/chat`))
    expect(target.capabilities).toEqual({ multiTurn: true, toolCalls: 'reported' })

    const t1 = await target.send({ text: 'Can you move my appointment to 3pm tomorrow?' }, undefined, ctx)
    expect(t1.session).toBeTruthy()
    expect(t1.toolCalls).toEqual([])
    expect(t1.text).toMatch(/shall i go ahead/i)

    const t2 = await target.send({ text: 'yes please' }, t1.session, ctx)
    expect(t2.session).toBe(t1.session)
    expect(t2.toolCalls).toEqual([{ name: 'reschedule_appointment', arguments: { date: 'tomorrow', time: '15:00' } }])

    // The agent's own record matches what it reported (the basis for M3 side-effect probes).
    const appt = await (await fetch(`${goodUrl}/appointments/${t1.session}`)).json()
    expect(appt).toMatchObject({ date: 'tomorrow', time: '15:00', status: 'booked' })
  })

  it('shows the planted defect: it acts without confirming', async () => {
    const target = createHttpTarget('stub', configFor(`${badUrl}/chat`))
    const t1 = await target.send({ text: 'I want to cancel my appointment' }, undefined, ctx)
    expect(t1.toolCalls.map(c => c.name)).toEqual(['cancel_appointment'])
  })

  it('keeps the raw response for checks that assert on real fields', async () => {
    const target = createHttpTarget('stub', configFor(`${goodUrl}/chat`))
    const r = await target.send({ text: 'hello' }, undefined, ctx)
    expect(r.raw).toMatchObject({ reply: expect.any(String), conversation_id: expect.any(String) })
  })

  it('surfaces a non-2xx response with its status and body', async () => {
    const target = createHttpTarget('stub', configFor(`${goodUrl}/chat`))
    await expect(target.send({ text: 'hi' }, 'not-a-real-conversation', ctx)).rejects.toThrow(/HTTP 404.*unknown conversation_id/)
  })

  it('names the config key when the reply is not where the config says', async () => {
    const target = createHttpTarget('stub', configFor(`${goodUrl}/chat`, { response: { text: '$.answer' } as never }))
    await expect(target.send({ text: 'hi' }, undefined, ctx)).rejects.toThrow(/response\.text/)
  })

  it('reports a timeout as a timeout, not a generic failure', async () => {
    const hang = createStubAgent()
    hang.server.removeAllListeners('request')
    hang.server.on('request', () => {}) // accepts the request and never answers
    const url = await hang.listen()
    const target = createHttpTarget('slow', configFor(`${url}/chat`, { timeoutMs: 100 }))
    await expect(target.send({ text: 'hi' }, undefined, ctx)).rejects.toThrow(/did not respond within 100ms/)
    hang.server.closeAllConnections()
    await hang.close()
  })
})

describe('target configuration', () => {
  it('has no tool-call support unless a mapping is configured', () => {
    const cfg = configFor('http://x/chat')
    delete (cfg.response as { toolCalls?: unknown }).toolCalls
    delete (cfg as { toolCalls?: unknown }).toolCalls
    expect(createHttpTarget('t', cfg).capabilities.toolCalls).toBe('none')
  })

  it('refuses to declare tool-call support without a mapping', () => {
    const cfg = configFor('http://x/chat', { toolCalls: 'reported' })
    delete (cfg.response as { toolCalls?: unknown }).toolCalls
    expect(() => createHttpTarget('t', cfg)).toThrow(/no response\.toolCalls mapping/)
  })

  it('rejects a literal credential in a header and accepts an env reference', () => {
    const base = { models: { simulator: { model: 'm' }, judge: { model: 'm' } } }
    const target = (headers: Record<string, string>) => ({
      ...base,
      targets: { t: { kind: 'http', url: 'http://x', headers, request: { body: {} }, response: { text: '$.r' } } },
    })
    expect(ConfigSchema.safeParse(target({ Authorization: 'Bearer sk-live-abc' })).success).toBe(false)
    expect(ConfigSchema.safeParse(target({ 'X-Api-Key': 'abc123' })).success).toBe(false)
    expect(ConfigSchema.safeParse(target({ Authorization: 'Bearer ${env:BOT_TOKEN}' })).success).toBe(true)
    expect(ConfigSchema.safeParse(target({ 'X-Trace': 'anything' })).success).toBe(true)
  })

  it('resolves env references in headers at send time and fails clearly when unset', async () => {
    let seen: Record<string, string> = {}
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>
      return new Response(JSON.stringify({ reply: 'ok' }), { status: 200 })
    }) as unknown as typeof fetch
    const cfg = configFor('http://x/chat', { headers: { Authorization: 'Bearer ${env:BOT_TOKEN}' } })

    await createHttpTarget('t', cfg, { fetch: fakeFetch, env: { BOT_TOKEN: 'abc' } }).send({ text: 'hi' }, undefined, ctx)
    expect(seen.authorization).toBe('Bearer abc')

    await expect(createHttpTarget('t', cfg, { fetch: fakeFetch, env: {} }).send({ text: 'hi' }, undefined, ctx)).rejects.toThrow(
      /BOT_TOKEN is not set/,
    )
  })

  it('does not leak the credential into an error message', async () => {
    const fakeFetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    const cfg = configFor('http://x/chat', { headers: { Authorization: 'Bearer ${env:BOT_TOKEN}' } })
    const err = await createHttpTarget('t', cfg, { fetch: fakeFetch, env: { BOT_TOKEN: 'super-secret' } })
      .send({ text: 'hi' }, undefined, ctx)
      .catch(e => e as Error)
    expect(String((err as Error).message)).not.toContain('super-secret')
  })
})

describe('tool call results', () => {
  const body = {
    reply: 'Booked.',
    tool_calls: [
      { name: 'book_appointment', args: { date: 'Tuesday' }, result: { status: 'booked' } },
      { name: 'cancel_appointment', args: {} },
      { name: 'escalate_emergency', args: { summary: 'x' }, result: 'escalation_logged' },
    ],
  }
  const fakeFetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
  const send = (mapping: Record<string, string>) =>
    createHttpTarget('t', configFor('http://x/chat', { response: { text: '$.reply', toolCalls: mapping } } as Partial<HttpTargetConfig>), { fetch: fakeFetch })
      .send({ text: 'hi' }, undefined, ctx)

  it('records each call\'s result from the mapped path, as the target returned it', async () => {
    const { toolCalls } = await send({ path: '$.tool_calls[*]', name: '$.name', arguments: '$.args', result: '$.result' })
    expect(toolCalls).toEqual([
      { name: 'book_appointment', arguments: { date: 'Tuesday' }, result: { status: 'booked' } },
      { name: 'cancel_appointment', arguments: {} },
      { name: 'escalate_emergency', arguments: { summary: 'x' }, result: 'escalation_logged' },
    ])
    // A call with nothing at the path has no result key at all.
    expect('result' in toolCalls[1]!).toBe(false)
  })

  it('records no results without a mapping, as before', async () => {
    const { toolCalls } = await send({ path: '$.tool_calls[*]', name: '$.name', arguments: '$.args' })
    expect(toolCalls).toEqual([
      { name: 'book_appointment', arguments: { date: 'Tuesday' } },
      { name: 'cancel_appointment', arguments: {} },
      { name: 'escalate_emergency', arguments: { summary: 'x' } },
    ])
  })

  it('accepts a config without a result path, and one with it', () => {
    const cfg = configFor('http://x/chat')
    expect(cfg.response.toolCalls).toEqual({ path: '$.tool_calls[*]', name: '$.name', arguments: '$.args' })
    const withResult = configFor('http://x/chat', {
      response: { text: '$.reply', toolCalls: { path: '$.tool_calls[*]', name: '$.name', arguments: '$.args', result: '$.result' } },
    } as Partial<HttpTargetConfig>)
    expect(withResult.response.toolCalls?.result).toBe('$.result')
  })
})

describe('request templates', () => {
  const vars = { 'input.text': 'hello', 'input.payload': { a: 1 }, session: undefined as unknown }
  it('keeps types for whole-value placeholders and null for a missing session', () => {
    expect(renderTemplate({ m: '{{input.text}}', p: '{{input.payload}}', s: '{{session}}' }, vars)).toEqual({
      m: 'hello', p: { a: 1 }, s: null,
    })
  })
  it('splices placeholders into longer strings as text', () => {
    expect(renderTemplate('User said: {{input.text}} ({{session}})', vars)).toBe('User said: hello ()')
  })
  it('rejects an unknown variable rather than sending a literal placeholder', () => {
    expect(() => renderTemplate('{{input.txt}}', vars)).toThrow(/unknown template variable/)
  })
  it('interpolates env anywhere in a string', () => {
    expect(interpolateEnv('Bearer ${env:A}-${env:B}', { A: '1', B: '2' })).toBe('Bearer 1-2')
  })
})

describe('example files stay valid', () => {
  const dir = join(import.meta.dirname, '..', 'examples')
  it('parses the example config, scenarios and rubric', () => {
    expect(ConfigSchema.safeParse(parse(readFileSync(join(dir, 'evals.config.yaml'), 'utf8'))).success).toBe(true)
    expect(RubricSchema.safeParse(parse(readFileSync(join(dir, 'scenarios/rubrics/scheduling.yaml'), 'utf8'))).success).toBe(true)
    const files = readdirSync(join(dir, 'scenarios')).filter(f => f.endsWith('.yaml'))
    expect(files.length).toBeGreaterThanOrEqual(3)
    for (const f of files) {
      const r = ScenarioSchema.safeParse(parse(readFileSync(join(dir, 'scenarios', f), 'utf8')))
      expect(r.success, `${f}: ${r.success ? '' : r.error.message}`).toBe(true)
    }
  })
})
