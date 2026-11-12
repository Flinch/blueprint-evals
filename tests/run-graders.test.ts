import { describe, expect, it } from 'vitest'
import {
  createDeterministicGrader, createFakeProvider, createMinContentGrader, createRubricJudge,
  RubricSchema, runGraders, ScenarioSchema,
} from '../src/index.js'
import type { Grader } from '../src/index.js'
import { agent, call, makeTrace, user } from './helpers.js'

const scenario = ScenarioSchema.parse({ id: 's', version: 1, target: 't', persona: 'p' })
const ctx = { runId: 'r1' }
const rubric = RubricSchema.parse({ id: 'r', version: 1, criteria: [{ id: 'a', text: 'A' }] })
const goodJudge = () => createFakeProvider({ json: { verdicts: [{ criterion_id: 'a', critique: 'ok', verdict: 'pass' }] } })
const talk = [user('hi'), agent('Your appointment is moved.', [call('reschedule_appointment')])]

describe('runGraders', () => {
  it('runs deterministic graders before LLM graders whatever order they were given', async () => {
    const order: string[] = []
    const mk = (name: string, kind: Grader['kind']): Grader => ({
      name, kind, async grade() { order.push(name); return { grader: name, status: 'pass', reason: '' } },
    })
    await runGraders([mk('judge', 'llm'), mk('check', 'deterministic'), mk('probe', 'probe')], makeTrace(talk), scenario, ctx)
    expect(order).toEqual(['check', 'judge', 'probe'])
  })

  it('skips tool-call graders, with a reason, on a target that cannot report them', async () => {
    const results = await runGraders(
      [createDeterministicGrader({ type: 'must_not_call', tool: 'cancel_appointment' })],
      makeTrace(talk, { toolCalls: 'none' }), scenario, ctx,
    )
    expect(results[0]).toMatchObject({ status: 'skipped' })
    expect(results[0]!.reason).toMatch(/cannot report tool calls/)
  })

  it('warns, but still runs, on an unverified target', async () => {
    const [r] = await runGraders(
      [createDeterministicGrader({ type: 'tool_called', tool: 'reschedule_appointment' })],
      makeTrace(talk, { toolCalls: 'reported' }), scenario, ctx,
    )
    expect(r!.status).toBe('pass')
    expect(r!.warnings?.join(' ')).toMatch(/unverified/)
  })

  it('does not warn on a verified target', async () => {
    const [r] = await runGraders(
      [createDeterministicGrader({ type: 'tool_called', tool: 'reschedule_appointment' })],
      makeTrace(talk, { toolCalls: 'verified' }), scenario, ctx,
    )
    expect(r!.warnings).toBeUndefined()
  })

  it('does not call the judge after a deterministic failure (short-circuit), and says so', async () => {
    const provider = goodJudge()
    const results = await runGraders(
      [createDeterministicGrader({ type: 'must_not_call', tool: 'reschedule_appointment' }), createRubricJudge({ rubric, provider })],
      makeTrace(talk), scenario, ctx,
    )
    expect(results.map(r => r.status)).toEqual(['fail', 'skipped'])
    expect(provider.calls).toHaveLength(0)
    expect(results[1]!.reason).toMatch(/shortCircuit/)
  })

  it('runs the judge anyway when shortCircuit is off', async () => {
    const provider = goodJudge()
    const results = await runGraders(
      [createDeterministicGrader({ type: 'must_not_call', tool: 'reschedule_appointment' }), createRubricJudge({ rubric, provider })],
      makeTrace(talk), scenario, ctx, { shortCircuit: false },
    )
    expect(results.map(r => r.status)).toEqual(['fail', 'pass'])
    expect(provider.calls).toHaveLength(1)
  })

  it('stops a degenerate transcript from ever reaching the judge', async () => {
    const provider = goodJudge()
    const results = await runGraders([createMinContentGrader(), createRubricJudge({ rubric, provider })], makeTrace([user('hi'), agent('ok')]), scenario, ctx)
    expect(results[0]!.status).toBe('fail')
    expect(provider.calls).toHaveLength(0)
  })

  it('turns a throwing grader into an error without losing the others', async () => {
    const boom: Grader = { name: 'boom', kind: 'llm', async grade() { throw new Error('kaput') } }
    const results = await runGraders([boom, createRubricJudge({ rubric, provider: goodJudge() })], makeTrace(talk), scenario, ctx)
    expect(results[0]).toMatchObject({ status: 'error', reason: 'Grader threw: kaput' })
    expect(results[1]!.status).toBe('pass')
  })

  it('reports each result as it lands', async () => {
    const seen: string[] = []
    await runGraders(
      [createDeterministicGrader({ type: 'tool_called', tool: 'reschedule_appointment' }), createMinContentGrader()],
      makeTrace(talk), scenario, ctx, { onResult: r => { seen.push(r.grader) } },
    )
    expect(seen).toEqual(['tool_called(reschedule_appointment)', 'min-content'])
  })
})
