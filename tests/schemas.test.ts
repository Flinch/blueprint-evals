import { describe, expect, it } from 'vitest'
import { ConfigSchema, RubricSchema, ScenarioSchema, resolveSecret } from '../src/index.js'

describe('ScenarioSchema', () => {
  it('applies defaults and normalizes version to a string', () => {
    const s = ScenarioSchema.parse({ id: 'book-1', version: 3, target: 'riley', persona: 'A rushed patient' })
    expect(s.version).toBe('3')
    expect(s.mode).toBe('conversational')
    expect(s.max_turns).toBe(10)
    expect(s.trials).toBe(1)
  })
  it('rejects a conversational scenario with no persona or seed message', () => {
    expect(ScenarioSchema.safeParse({ id: 'x', version: 1, target: 't' }).success).toBe(false)
  })
  it('rejects trials above 1 until M2', () => {
    expect(ScenarioSchema.safeParse({ id: 'x', version: 1, target: 't', persona: 'p', trials: 5 }).success).toBe(false)
  })
  it('requires an input for single_shot', () => {
    expect(ScenarioSchema.safeParse({ id: 'x', version: 1, target: 't', mode: 'single_shot' }).success).toBe(false)
  })
})

describe('RubricSchema', () => {
  it('rejects duplicate criterion ids', () => {
    const r = RubricSchema.safeParse({
      id: 'r', version: 1,
      criteria: [{ id: 'a', text: 'one' }, { id: 'a', text: 'two' }],
    })
    expect(r.success).toBe(false)
  })
  it('rejects a leftover threshold loudly, since its meaning changed', () => {
    const r = RubricSchema.safeParse({ id: 'r', version: 1, criteria: [{ id: 'a', text: 'one', threshold: 0.7 }] })
    expect(r.success).toBe(false)
    expect(JSON.stringify((r as { error: unknown }).error)).toMatch(/threshold/)
  })
  it('rejects an anchor that points at a criterion the rubric does not have', () => {
    const r = RubricSchema.safeParse({
      id: 'r', version: 1, criteria: [{ id: 'a', text: 'one' }],
      anchors: [{ criterion: 'ghost', output: 'x', verdict: 'fail', critique: 'because' }],
    })
    expect(r.success).toBe(false)
  })
  it('requires a critique on every anchor, and takes an optional input', () => {
    const base = { id: 'r', version: 1, criteria: [{ id: 'a', text: 'one' }] }
    expect(RubricSchema.safeParse({ ...base, anchors: [{ output: 'x', verdict: 'pass', critique: '' }] }).success).toBe(false)
    expect(RubricSchema.safeParse({ ...base, anchors: [{ input: 'q', output: 'x', verdict: 'pass', critique: 'fine' }] }).success).toBe(true)
  })
  it('defaults weight and critical', () => {
    const r = RubricSchema.parse({ id: 'r', version: 1, criteria: [{ id: 'a', text: 'one' }] })
    expect(r.criteria[0]).toMatchObject({ weight: 1, critical: false })
  })
})

describe('secrets', () => {
  const base = { models: { simulator: { model: 'm' }, judge: { model: 'm' } } }
  it('rejects a literal secret in config', () => {
    const r = ConfigSchema.safeParse({ ...base, targets: { t: { kind: 'vapi-chat', apiKey: 'sk-live-123', assistantId: 'a' } } })
    expect(r.success).toBe(false)
  })
  it('accepts an environment reference and resolves it', () => {
    const r = ConfigSchema.safeParse({ ...base, targets: { t: { kind: 'vapi-chat', apiKey: '${env:VAPI_API_KEY}', assistantId: 'a' } } })
    expect(r.success).toBe(true)
    expect(resolveSecret('${env:VAPI_API_KEY}', { VAPI_API_KEY: 'abc' })).toBe('abc')
  })
  it('fails loudly when the variable is unset', () => {
    expect(() => resolveSecret('${env:NOPE}', {})).toThrow('NOPE')
  })
})

describe('environment references outside headers', () => {
  const base = { models: { simulator: { model: 'm' }, judge: { model: 'm' } } }
  const http = (over: Record<string, unknown>) => ({
    ...base,
    targets: { t: { kind: 'http', url: 'http://127.0.0.1:4010/chat', request: { body: { message: '{{input.text}}' } }, response: { text: '$.reply' }, ...over } },
  })

  it('accepts a reference in a header, the one place it is expanded', () => {
    expect(ConfigSchema.safeParse(http({ headers: { Authorization: 'Bearer ${env:TOKEN}' } })).success).toBe(true)
  })

  it('rejects one in the url, because it would be sent as literal text', () => {
    const r = ConfigSchema.safeParse(http({ url: 'http://127.0.0.1:4010/${env:PATH_PART}' }))
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).toMatch(/only expanded in headers/)
  })

  it('rejects one anywhere in the request body, naming where', () => {
    const r = ConfigSchema.safeParse(http({ request: { body: { auth: { key: ['x', '${env:API_KEY}'] } } } }))
    expect(r.success).toBe(false)
    const issue = r.error?.issues.find(i => /only expanded in headers/.test(i.message))
    expect(issue?.path).toEqual(['targets', 't', 'request', 'body', 'auth', 'key', '1'])
  })
})
