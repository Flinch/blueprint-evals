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
  it('defaults weight, threshold and critical', () => {
    const r = RubricSchema.parse({ id: 'r', version: 1, criteria: [{ id: 'a', text: 'one' }] })
    expect(r.criteria[0]).toMatchObject({ weight: 1, threshold: 0.7, critical: false })
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
