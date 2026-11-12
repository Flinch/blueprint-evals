import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildRequest, createAnthropicProvider, createRubricJudge, RubricSchema, ScenarioSchema } from '../src/index.js'
import type { CompleteRequest } from '../src/index.js'
import { agent, makeTrace, user } from './helpers.js'

const models = {
  simulator: { model: 'claude-opus-5-5', effort: 'low' as const },
  judge: { model: 'claude-opus-5-5', effort: 'high' as const },
}
const pricing = { 'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 }, 'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 } }

type Handler = (params: any, options: any) => Promise<unknown>
function fakeClient(handler: Handler) {
  const calls: { params: any; options: any }[] = []
  const client = {
    beta: { messages: { stream: (params: any, options: any) => { calls.push({ params, options }); return { finalMessage: () => handler(params, options) } } } },
  } as unknown as Pick<Anthropic, 'beta'>
  return { client, calls }
}

const usage = (over: Record<string, unknown> = {}) => ({
  input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, iterations: null, ...over,
})
const message = (content: unknown[], over: Record<string, unknown> = {}) => ({
  model: 'claude-opus-5-5', stop_reason: 'end_turn', content, usage: usage(), ...over,
})
const text = (t: string) => ({ type: 'text', text: t })

const base: CompleteRequest = { role: 'judge', messages: [{ role: 'user', content: 'grade this' }], timeoutMs: 5_000 }
const Schema = z.object({ score: z.number().min(0).max(1) })

describe('buildRequest', () => {
  it('sets effort explicitly and turns server-side fallbacks on by default', () => {
    const r = buildRequest(base, models.judge)
    expect(r.output_config.effort).toBe('high')
    expect(r.betas).toEqual(['server-side-fallback-2026-07-01'])
    expect(r.fallbacks).toBe('default')
  })

  it('omits fallbacks when turned off, so a declined request fails fast', () => {
    const r = buildRequest(base, { ...models.judge, fallbacks: false })
    expect(r).not.toHaveProperty('betas')
    expect(r).not.toHaveProperty('fallbacks')
  })

  it('never sends sampling parameters or a thinking setting, which current models reject', () => {
    const r = buildRequest(base, models.judge)
    for (const key of ['temperature', 'top_p', 'top_k', 'thinking']) expect(r).not.toHaveProperty(key)
  })

  it('lets the request override the configured effort', () => {
    expect(buildRequest({ ...base, effort: 'xhigh' }, models.judge).output_config.effort).toBe('xhigh')
  })

  it('requests structured output when a schema is given, and only then', () => {
    expect(buildRequest({ ...base, schema: Schema }, models.judge).output_config.format).toMatchObject({ type: 'json_schema' })
    expect(buildRequest(base, models.judge).output_config).not.toHaveProperty('format')
  })

  it('gives judges more room than the simulator, with an override', () => {
    expect(buildRequest({ ...base, role: 'simulator' }, models.simulator).max_tokens).toBe(4_096)
    expect(buildRequest(base, models.judge).max_tokens).toBe(16_000)
    expect(buildRequest({ ...base, maxTokens: 999 }, models.judge).max_tokens).toBe(999)
  })

  it('uses the settings for the role it was asked for', () => {
    const sim = { model: 'sim-model' }
    const { client, calls } = fakeClient(async () => message([text('hi')]))
    const p = createAnthropicProvider({ models: { simulator: sim, judge: models.judge }, client })
    return p.complete({ ...base, role: 'simulator' }).then(() => expect(calls[0]!.params.model).toBe('sim-model'))
  })
})

describe('complete', () => {
  const provider = (handler: Handler) => createAnthropicProvider({ models, pricing, client: fakeClient(handler).client })

  it('returns validated structured output', async () => {
    const r = await provider(async () => message([text('{"score":0.8}')])).complete({ ...base, schema: Schema })
    expect(r.parsed).toEqual({ score: 0.8 })
    expect(r.stopReason).toBe('end_turn')
  })

  it('re-validates ranges the API does not enforce', async () => {
    const r = await provider(async () => message([text('{"score":1.5}')])).complete({ ...base, schema: Schema })
    expect(r.parsed).toBeUndefined()
    expect(r.text).toBe('{"score":1.5}')
  })

  it('leaves parsed undefined for text that is not JSON', async () => {
    const r = await provider(async () => message([text('looks fine to me')])).complete({ ...base, schema: Schema })
    expect(r.parsed).toBeUndefined()
  })

  it('returns only the model text, not thinking or fallback blocks', async () => {
    const content = [{ type: 'thinking', thinking: 'secret reasoning' }, text('{"score":'), { type: 'fallback' }, text('0.5}')]
    const r = await provider(async () => message(content)).complete({ ...base, schema: Schema })
    expect(r.text).toBe('{"score":0.5}')
    expect(r.parsed).toEqual({ score: 0.5 })
  })

  it('reports a refusal as a stop reason with no text, never as output', async () => {
    const r = await provider(async () => message([text('I cannot help with that')], { stop_reason: 'refusal' })).complete({ ...base, schema: Schema })
    expect(r.stopReason).toBe('refusal')
    expect(r.text).toBe('')
    expect(r.parsed).toBeUndefined()
  })

  it('reports a token-limit stop so a grader can name it', async () => {
    const r = await provider(async () => message([text('{"sco')], { stop_reason: 'max_tokens' })).complete({ ...base, schema: Schema })
    expect(r.stopReason).toBe('max_tokens')
  })

  it('records the requested model and effort', async () => {
    const r = await provider(async () => message([text('x')])).complete({ ...base, effort: 'max' })
    expect(r.model).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5', effort: 'max' })
  })
})

describe('usage and cost', () => {
  const run = (msg: unknown, pr: Record<string, { inputPerMTok: number; outputPerMTok: number }> = pricing) =>
    createAnthropicProvider({ models, pricing: pr, client: fakeClient(async () => msg).client }).complete(base)

  it('prices tokens from the configured table', async () => {
    const r = await run(message([text('x')]))
    expect(r.usage).toEqual({ inputTokens: 1000, outputTokens: 500, costUsd: (1000 * 4 + 500 * 20) / 1e6 })
  })

  it('reports unknown cost as null rather than zero', async () => {
    expect((await run(message([text('x')]), {})).usage.costUsd).toBeNull()
  })

  it('counts cache tokens as ordinary input, a conservative overestimate', async () => {
    const r = await run(message([text('x')], { usage: usage({ cache_read_input_tokens: 200, cache_creation_input_tokens: 100 }) }))
    expect(r.usage.inputTokens).toBe(1300)
  })

  it('prices each iteration at its own model when a fallback ran, and reports who served', async () => {
    const iterations = [
      { type: 'message', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 1000, output_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ]
    const r = await run(message([text('x')], { model: 'claude-opus-4-8', usage: usage({ iterations }) }))
    expect(r.model.servedBy).toBe('claude-opus-4-8')
    expect(r.usage.costUsd).toBeCloseTo((1000 * 4 + 100 * 20 + 1000 * 5 + 400 * 25) / 1e6)
    expect(r.usage.inputTokens).toBe(2000)
  })

  it('does not set servedBy when no fallback ran', async () => {
    expect((await run(message([text('x')]))).model).not.toHaveProperty('servedBy')
  })

  it('makes total cost unknown if any iteration is unpriced', async () => {
    const iterations = [
      { type: 'message', model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      { type: 'fallback_message', model: 'mystery-model', input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ]
    expect((await run(message([text('x')], { usage: usage({ iterations }) }))).usage.costUsd).toBeNull()
  })
})

describe('errors', () => {
  const failing = (err: unknown): Promise<Error> =>
    createAnthropicProvider({ models, client: fakeClient(async () => { throw err }).client })
      .complete(base)
      .then(() => { throw new Error('expected the call to fail') }, (e: Error) => e)

  it('names the deadline when the call times out', async () => {
    const slow = createAnthropicProvider({
      models,
      client: fakeClient((_p, o) => new Promise((_, reject) => o.signal.addEventListener('abort', () => reject(o.signal.reason)))).client,
    })
    await expect(slow.complete({ ...base, timeoutMs: 50 })).rejects.toThrow(/exceeded its 50ms deadline/)
  })

  it('honours an external abort signal', async () => {
    const ac = new AbortController()
    const p = createAnthropicProvider({
      models,
      client: fakeClient((_p, o) => new Promise((_, reject) => o.signal.addEventListener('abort', () => reject(o.signal.reason)))).client,
    })
    const pending = p.complete({ ...base, signal: ac.signal })
    ac.abort()
    await expect(pending).rejects.toThrow(/deadline|cancelled/)
  })

  it('explains an authentication failure without echoing anything sensitive', async () => {
    const err = Anthropic.APIError.generate(401, { error: { message: 'invalid x-api-key sk-ant-SECRET' } }, 'invalid x-api-key sk-ant-SECRET', new Headers())
    const e = await failing(err)
    expect(e.message).toMatch(/401/)
    expect(e.message).not.toContain('SECRET')
  })

  it('explains a rate limit and other API errors', async () => {
    const rl = await failing(Anthropic.APIError.generate(429, { error: { message: 'slow down' } }, 'slow down', new Headers()))
    expect(rl.message).toMatch(/rate limit/i)
    const bad = await failing(Anthropic.APIError.generate(400, { error: { message: 'fallbacks not supported' } }, 'fallbacks not supported', new Headers()))
    expect(bad.message).toMatch(/400.*fallbacks not supported/)
  })
})

describe('end to end with the rubric judge', () => {
  it('turns a model response into a verdict, and a refusal into an error', async () => {
    const rubric = RubricSchema.parse({ id: 'r', version: 1, criteria: [{ id: 'a', text: 'A' }] })
    const scenario = ScenarioSchema.parse({ id: 's', version: 1, target: 't', persona: 'p' })
    const trace = makeTrace([user('hi'), agent('Your appointment is moved.')])
    const verdict = JSON.stringify({ verdicts: [{ criterion_id: 'a', rationale: 'ok', score: 0.95 }] })

    const ok = createAnthropicProvider({ models, pricing, client: fakeClient(async () => message([text(verdict)])).client })
    const r1 = await createRubricJudge({ rubric, provider: ok }).grade(trace, scenario, { runId: 'r' })
    expect(r1.status).toBe('pass')
    expect(r1.usage?.costUsd).toBeGreaterThan(0)

    const refused = createAnthropicProvider({ models, pricing, client: fakeClient(async () => message([], { stop_reason: 'refusal' })).client })
    const r2 = await createRubricJudge({ rubric, provider: refused }).grade(trace, scenario, { runId: 'r' })
    expect(r2.status).toBe('error')
    expect(r2.reason).toMatch(/not a verdict on the agent/)
  })
})
