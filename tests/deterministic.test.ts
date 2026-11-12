import { describe, expect, it } from 'vitest'
import { createDeterministicGrader, createMinContentGrader, deepEqual, ScenarioSchema } from '../src/index.js'
import type { Check } from '../src/index.js'
import { agent, call, makeTrace, user } from './helpers.js'

const scenario = ScenarioSchema.parse({ id: 's', version: 1, target: 't', persona: 'p' })
const ctx = { runId: 'r1' }
const run = (check: Check, trace = makeTrace([])) => createDeterministicGrader(check).grade(trace, scenario, ctx)

const traceWithCalls = makeTrace([
  user('move it'),
  agent('done', [call('reschedule_appointment', { date: 'tomorrow', time: '15:00', opts: { a: 1, b: 2 } })]),
])

describe('tool_called', () => {
  it('passes and points at the call', async () => {
    const r = await run({ type: 'tool_called', tool: 'reschedule_appointment' }, traceWithCalls)
    expect(r.status).toBe('pass')
    expect(r.evidence).toEqual([{ turnIndex: 1, toolCallIndex: 0 }])
  })
  it('fails when never called', async () => {
    const r = await run({ type: 'tool_called', tool: 'cancel_appointment' }, traceWithCalls)
    expect(r.status).toBe('fail')
    expect(r.reason).toMatch(/never called/)
  })
  it('hints at a mapping problem when the target reported no calls at all', async () => {
    const r = await run({ type: 'tool_called', tool: 'x' }, makeTrace([user('hi'), agent('hello there friend')]))
    expect(r.reason).toMatch(/toolCalls mapping/)
  })
})

describe('tool_arg_match', () => {
  it('matches a subset of arguments, strictly', async () => {
    expect((await run({ type: 'tool_arg_match', tool: 'reschedule_appointment', args: { time: '15:00' } }, traceWithCalls)).status).toBe('pass')
    expect((await run({ type: 'tool_arg_match', tool: 'reschedule_appointment', args: { time: '3pm' } }, traceWithCalls)).status).toBe('fail')
  })
  it('compares nested objects structurally, ignoring key order', async () => {
    const r = await run({ type: 'tool_arg_match', tool: 'reschedule_appointment', args: { opts: { b: 2, a: 1 } } }, traceWithCalls)
    expect(r.status).toBe('pass')
  })
  it('shows the calls it did see when none match', async () => {
    const r = await run({ type: 'tool_arg_match', tool: 'reschedule_appointment', args: { time: '09:00' } }, traceWithCalls)
    expect(r.reason).toMatch(/"15:00"/)
  })
})

describe('must_not_call', () => {
  it('fails with evidence for every offending call', async () => {
    const t = makeTrace([agent('a', [call('cancel_appointment')]), agent('b', [call('cancel_appointment')])])
    const r = await run({ type: 'must_not_call', tool: 'cancel_appointment' }, t)
    expect(r.status).toBe('fail')
    expect(r.evidence).toHaveLength(2)
  })
  it('passes with a vacuity warning when no tool call was ever reported on an unverified target', async () => {
    const r = await run({ type: 'must_not_call', tool: 'cancel_appointment' }, makeTrace([agent('nothing happened here ok')], { toolCalls: 'reported' }))
    expect(r.status).toBe('pass')
    expect(r.warnings?.[0]).toMatch(/vacuous/)
  })
  it('passes cleanly on a verified target', async () => {
    const r = await run({ type: 'must_not_call', tool: 'cancel_appointment' }, makeTrace([agent('nothing happened here ok')], { toolCalls: 'verified' }))
    expect(r.warnings).toBeUndefined()
  })
})

describe('output checks (single-shot)', () => {
  const t = (raw: unknown) => makeTrace([agent('x', [], raw)])
  it('output_field_equals reads a flat key or a JSON path', async () => {
    expect((await run({ type: 'output_field_equals', field: 'tier', expected: 'high' }, t({ tier: 'high' }))).status).toBe('pass')
    expect((await run({ type: 'output_field_equals', field: '$.a.b', expected: 2 }, t({ a: { b: 2 } }))).status).toBe('pass')
    expect((await run({ type: 'output_field_equals', field: 'tier', expected: 'low' }, t({ tier: 'high' }))).status).toBe('fail')
  })
  it('output_equals ignores key order', async () => {
    expect((await run({ type: 'output_equals', expected: { a: 1, b: 2 } }, t({ b: 2, a: 1 }))).status).toBe('pass')
  })
  it('output_array_length enforces bounds and type', async () => {
    expect((await run({ type: 'output_array_length', min: 2, max: 3 }, t([1, 2]))).status).toBe('pass')
    expect((await run({ type: 'output_array_length', min: 3 }, t([1, 2]))).status).toBe('fail')
    expect((await run({ type: 'output_array_length', max: 1 }, t([1, 2]))).status).toBe('fail')
    expect((await run({ type: 'output_array_length', min: 1 }, t({ not: 'array' }))).reason).toMatch(/array/)
  })
  it('reports a missing raw output as an error, not a failure of the agent', async () => {
    const r = await run({ type: 'output_equals', expected: {} }, makeTrace([agent('no raw recorded here')]))
    expect(r.status).toBe('error')
  })
})

describe('min-content', () => {
  const g = createMinContentGrader()
  it('fails near-empty assistant output', async () => {
    expect((await g.grade(makeTrace([user('hi'), agent('ok')]), scenario, ctx)).status).toBe('fail')
  })
  it('counts only the assistant, so a long user message cannot hide an empty reply', async () => {
    const t = makeTrace([user('a very long message from the simulated user that goes on and on'), agent('')])
    expect((await g.grade(t, scenario, ctx)).status).toBe('fail')
  })
  it('passes real output and fails an empty trace', async () => {
    expect((await g.grade(makeTrace([agent('Your appointment is moved.')]), scenario, ctx)).status).toBe('pass')
    expect((await g.grade(makeTrace([]), scenario, ctx)).status).toBe('fail')
  })
})

describe('deepEqual', () => {
  it('is strict about types and shape', () => {
    expect(deepEqual(1, '1')).toBe(false)
    expect(deepEqual([1, 2], [2, 1])).toBe(false)
    expect(deepEqual({ a: undefined }, {})).toBe(false)
    expect(deepEqual(null, {})).toBe(false)
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true)
  })
})
