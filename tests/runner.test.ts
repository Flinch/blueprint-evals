import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createDeterministicGrader, createFakeProvider, createPersonaSimulator, createScriptedSimulator,
  gradersForScenario, loadScenario, runScenario, runSuite, ScenarioSchema,
} from '../src/index.js'
import type { Grader, Reporter, RunEvent, Scenario, UserSimulator } from '../src/index.js'
import { call } from './helpers.js'
import { fakeTarget } from './fake-target.js'

const examples = join(import.meta.dirname, '..', 'examples', 'scenarios')

const scn = (over: Record<string, unknown> = {}): Scenario =>
  ScenarioSchema.parse({ id: 's', version: 1, target: 't', persona: 'p', seed_message: 'Hi, move my appointment', max_turns: 6, ...over })

const noCancel = createDeterministicGrader({ type: 'must_not_call', tool: 'cancel_appointment' })
const echo = fakeTarget(() => ({ text: 'Shall I go ahead and move it?' }))

describe('conversation', () => {
  it('opens with the seed message, then lets the simulator continue until it ends', async () => {
    const target = fakeTarget((_, n) => ({ text: n === 0 ? 'Shall I go ahead?' : 'Done, it is moved.' }))
    const r = await runScenario(scn(), { target, simulator: createScriptedSimulator(['yes']), graders: [noCancel] })

    expect(r.trace.turns.map(t => `${t.role}: ${t.content}`)).toEqual([
      'user: Hi, move my appointment', 'assistant: Shall I go ahead?', 'user: yes', 'assistant: Done, it is moved.',
    ])
    expect(r.trace.turns.map(t => t.index)).toEqual([0, 1, 2, 3])
    expect(target.inputs.map(i => i.text)).toEqual(['Hi, move my appointment', 'yes'])
    expect(r.status).toBe('pass')
    expect(r.error).toBeUndefined()
    expect(r.trace.turns[1]!.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('starts and ends the target once each', async () => {
    const target = fakeTarget(() => ({ text: 'ok then' }))
    await runScenario(scn(), { target, simulator: createScriptedSimulator([]), graders: [noCancel] })
    expect([target.started, target.ended]).toEqual([1, 1])
  })

  it('stops at the scenario max_turns, and at a lower budget.maxTurns', async () => {
    const forever: UserSimulator = { next: async () => ({ message: 'and again', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }) }
    const a = await runScenario(scn({ max_turns: 2 }), { target: fakeTarget(() => ({ text: 'reply' })), simulator: forever, graders: [noCancel] })
    expect(a.trace.turns).toHaveLength(4)
    const b = await runScenario(scn({ max_turns: 5 }), { target: fakeTarget(() => ({ text: 'reply' })), simulator: forever, graders: [noCancel], budget: { maxTurns: 1 } })
    expect(b.trace.turns).toHaveLength(2)
  })

  it('runs a seed-only scenario for one exchange with no simulator', async () => {
    const s = scn({ persona: undefined })
    const r = await runScenario(s, { target: fakeTarget(() => ({ text: 'a reply' })), graders: [noCancel] })
    expect(r.trace.turns).toHaveLength(2)
    expect(r.status).toBe('pass')
  })

  it('records the tool calls the agent made on the turn they happened', async () => {
    const target = fakeTarget(() => ({ text: 'Done', toolCalls: [call('reschedule_appointment', { time: '15:00' })] }))
    const r = await runScenario(scn(), { target, simulator: createScriptedSimulator([]), graders: [noCancel] })
    expect(r.trace.turns[1]!.toolCalls).toEqual([call('reschedule_appointment', { time: '15:00' })])
  })

  it('records the target, versions and tags in the trace so a result can be reproduced', async () => {
    const r = await runScenario(scn(), {
      target: fakeTarget(() => ({ text: 'ok then' }), { toolCalls: 'verified' }), simulator: createScriptedSimulator([]), graders: [noCancel],
      metadata: { promptVersion: 'v7', targetVersion: 'build-42', tags: ['nightly'] },
    })
    expect(r.trace.target).toMatchObject({ name: 'fake-target', kind: 'fake', toolCalls: 'verified', version: 'build-42' })
    expect(r.trace.metadata).toMatchObject({ promptVersion: 'v7', tags: ['nightly'], frameworkVersion: expect.any(String) })
    expect(r.trace.runId).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('single-shot', () => {
  it('sends the payload, records input and output, and checks the raw output', async () => {
    const target = fakeTarget(() => ({ text: 'high', raw: { tier: 'high', items: [1, 2] } }))
    const s = scn({
      mode: 'single_shot', persona: undefined, seed_message: undefined,
      input: { bug: 'checkout fails', severity: 2 },
      checks: [{ type: 'output_field_equals', field: 'tier', expected: 'high' }],
    })
    const r = await runScenario(s, { target, graders: s.checks.map(createDeterministicGrader) })

    expect(target.inputs[0]).toEqual({ text: undefined, payload: { bug: 'checkout fails', severity: 2 } })
    expect(r.trace.turns.map(t => t.role)).toEqual(['user', 'assistant'])
    expect(r.trace.turns[0]!.content).toContain('"checkout fails"')
    expect(r.status).toBe('pass')
  })

  it('passes a string input as text as well as payload', async () => {
    const target = fakeTarget(() => ({ text: 'ok then' }))
    await runScenario(scn({ mode: 'single_shot', persona: undefined, seed_message: undefined, input: 'classify this' }), { target, graders: [noCancel] })
    expect(target.inputs[0]).toEqual({ text: 'classify this', payload: 'classify this' })
  })
})

describe('a run that cannot produce a verdict is an error, with the partial trace kept', () => {
  it('when no graders are configured, since a test with no assertions must not pass', async () => {
    const r = await runScenario(scn(), { target: echo, simulator: createScriptedSimulator([]), graders: [] })
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/No graders/)
    expect(r.trace.turns).toHaveLength(0)
  })

  it('when the scenario has a persona but no simulator was given, before the target is touched', async () => {
    const target = fakeTarget(() => ({ text: 'x' }))
    const r = await runScenario(scn(), { target, graders: [noCancel] })
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/persona but no simulator/)
    expect(target.started).toBe(0)
  })

  it('when the target fails mid-conversation, keeping what was said so far', async () => {
    const target = fakeTarget((_, n) => { if (n === 1) throw new Error('target "bot" returned HTTP 503'); return { text: 'first reply ok' } })
    const r = await runScenario(scn(), { target, simulator: createScriptedSimulator(['and now?']), graders: [noCancel] })
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/HTTP 503/)
    expect(r.graders).toEqual([])
    expect(r.trace.turns.map(t => t.role)).toEqual(['user', 'assistant', 'user'])
    expect(target.ended).toBe(1)
  })

  it('when the target will not start, without trying to end it', async () => {
    const target = fakeTarget(() => ({ text: 'x' }), { failOnStart: true })
    const r = await runScenario(scn(), { target, simulator: createScriptedSimulator([]), graders: [noCancel] })
    expect(r.error).toMatch(/could not start/)
    expect(target.ended).toBe(0)
  })

  it('when the simulator fails', async () => {
    const sim = createPersonaSimulator({ provider: createFakeProvider({ error: 'simulator model timed out' }) })
    const r = await runScenario(scn(), { target: echo, simulator: sim, graders: [noCancel] })
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/simulator model timed out/)
  })

  it('when a grader reports an error, naming the grader', async () => {
    const broken: Grader = { name: 'judge', kind: 'llm', grade: async () => ({ grader: 'judge', status: 'error', reason: 'judge timed out' }) }
    const r = await runScenario(scn(), { target: echo, simulator: createScriptedSimulator([]), graders: [noCancel, broken] })
    expect(r.status).toBe('error')
    expect(r.error).toBe('judge: judge timed out')
  })

  it('when it is cancelled before it starts', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await runScenario(scn(), { target: echo, simulator: createScriptedSimulator([]), graders: [noCancel], signal: ac.signal })
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/cancelled/)
  })

  it('but a failing cleanup only warns, and the verdict stands', async () => {
    const target = fakeTarget(() => ({ text: 'ok then' }), { failOnEnd: true })
    const r = await runScenario(scn(), { target, simulator: createScriptedSimulator([]), graders: [noCancel] })
    expect(r.status).toBe('pass')
    expect(r.warnings.join(' ')).toMatch(/cleanup failed: cleanup blew up/)
  })
})

describe('cost', () => {
  const cost = (costUsd: number | null) => ({ inputTokens: 10, outputTokens: 5, costUsd })
  const chatty = (c: number | null) =>
    createPersonaSimulator({ provider: createFakeProvider({ json: { action: 'say', message: 'and then?' } }, { usage: cost(c) }) })

  it('sums simulator and grader spend into the trace and the result', async () => {
    const spender: Grader = { name: 'g', kind: 'llm', grade: async () => ({ grader: 'g', status: 'pass', reason: '', usage: cost(0.25) }) }
    const r = await runScenario(scn({ max_turns: 3 }), { target: echo, simulator: chatty(0.1), graders: [spender] })
    // two simulator calls (turns 2 and 3) plus the grader
    expect(r.costUsd).toBeCloseTo(0.45)
    expect(r.trace.usage).toEqual({ inputTokens: 30, outputTokens: 15, costUsd: r.costUsd })
  })

  it('is unknown, not zero, when any model has no price', async () => {
    const r = await runScenario(scn({ max_turns: 2 }), { target: echo, simulator: chatty(null), graders: [noCancel] })
    expect(r.costUsd).toBeNull()
  })

  it('stops the conversation as an error once the budget is passed', async () => {
    const r = await runScenario(scn({ max_turns: 6 }), { target: echo, simulator: chatty(0.5), graders: [noCancel], budget: { maxCostUsd: 0.6 } })
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/Cost budget of \$0\.6 exceeded/)
    expect(r.trace.turns.length).toBeLessThan(6 * 2)
  })

  it('refuses to pretend a budget is enforced when spend is unknown', async () => {
    const r = await runScenario(scn({ max_turns: 4 }), { target: echo, simulator: chatty(null), graders: [noCancel], budget: { maxCostUsd: 1 } })
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/spend is unknown/)
  })

  it('does not start a grader once the budget is spent', async () => {
    const mk = (name: string): Grader => ({ name, kind: 'llm', grade: async () => ({ grader: name, status: 'pass', reason: '', usage: cost(0.5) }) })
    const r = await runScenario(scn(), { target: echo, simulator: createScriptedSimulator([]), graders: [mk('first'), mk('second')], budget: { maxCostUsd: 0.3 } })
    expect(r.graders.map(g => g.status)).toEqual(['pass', 'error'])
    expect(r.error).toMatch(/second: Cost budget/)
  })

  it('keeps the verdict, with a warning, when the last grader tips it over', async () => {
    const only: Grader = { name: 'only', kind: 'llm', grade: async () => ({ grader: 'only', status: 'pass', reason: '', usage: cost(0.5) }) }
    const r = await runScenario(scn(), { target: echo, simulator: createScriptedSimulator([]), graders: [only], budget: { maxCostUsd: 0.3 } })
    expect(r.status).toBe('pass')
    expect(r.warnings.join(' ')).toMatch(/verdict is kept/)
  })
})

describe('verdict', () => {
  it('fails on a deterministic failure and, by default, never calls the judge', async () => {
    const judgeProvider = createFakeProvider({ json: { verdicts: [] } })
    const { scenario, rubric } = loadScenario(join(examples, 'reschedule.yaml'))
    const r = await runScenario(scenario, {
      target: fakeTarget(() => ({ text: 'I am not sure what you mean by that request.' })),
      simulator: createScriptedSimulator([]),
      graders: gradersForScenario(scenario, { rubric, provider: judgeProvider }),
    })
    expect(r.status).toBe('fail')
    expect(judgeProvider.calls).toHaveLength(0)
    expect(r.graders.filter(g => g.status === 'skipped').map(g => g.grader)).toEqual(
      expect.arrayContaining(['rubric-judge(scheduling@2)', 'goal-check']),
    )
  })

  it('runs the whole pipeline on the real example scenario: checks, judge and goal', async () => {
    const { scenario, rubric } = loadScenario(join(examples, 'reschedule.yaml'))
    const target = fakeTarget((_, n) =>
      n === 0
        ? { text: 'I can move your appointment to tomorrow at 15:00. Shall I go ahead?' }
        : { text: 'Done. Your appointment is now tomorrow at 15:00.', toolCalls: [call('reschedule_appointment', { date: 'tomorrow', time: '15:00' })] },
    )
    const sim = createPersonaSimulator({
      provider: createFakeProvider((_, n) => ({ json: n === 0 ? { action: 'say', message: 'Yes please.' } : { action: 'end', message: '' } }), {
        model: 'sim-model', usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
      }),
    })
    const judge = createFakeProvider(
      req => req.messages[0]!.content.includes('Criteria to judge')
        ? { json: { verdicts: [{ criterion_id: 'confirms-before-acting', critique: 'asked first', verdict: 'pass' }, { criterion_id: 'no-medical-advice', critique: 'none given', verdict: 'pass' }] } }
        : { json: { achieved: true, critique: 'moved to 15:00' } },
      { model: 'judge-model', usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.02 } },
    )
    const r = await runScenario(scenario, { target, simulator: sim, graders: gradersForScenario(scenario, { rubric, provider: judge }) })

    expect(r.status).toBe('pass')
    expect(r.graders.map(g => [g.grader, g.status])).toEqual([
      ['min-content', 'pass'],
      ['tool_called(reschedule_appointment)', 'pass'],
      ['tool_arg_match(reschedule_appointment)', 'pass'],
      ['must_not_call(cancel_appointment)', 'pass'],
      ['rubric-judge(scheduling@2)', 'pass'],
      ['goal-check', 'pass'],
    ])
    expect(r.score).toBe(1)
    expect(r.goalAchieved).toBe(true)
    expect(r.costUsd).toBeCloseTo(0.01 * 2 + 0.02 * 2)
    expect(r.trace.metadata.models).toMatchObject({ simulator: { model: 'sim-model' }, judge: { model: 'judge-model' } })
    expect(r.trace.turns.map(t => t.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  it('carries grader warnings into the result, once each', async () => {
    const r = await runScenario(scn(), { target: fakeTarget(() => ({ text: 'ok then' }), { toolCalls: 'reported' }), simulator: createScriptedSimulator([]), graders: [noCancel] })
    expect(r.warnings.filter(w => /unverified/.test(w))).toHaveLength(1)
    expect(r.warnings.some(w => /vacuous/.test(w))).toBe(true)
  })

  it('skips tool-call checks on a target that cannot report tool calls, and says so rather than passing', async () => {
    const r = await runScenario(scn(), { target: fakeTarget(() => ({ text: 'ok then' }), { toolCalls: 'none' }), simulator: createScriptedSimulator([]), graders: [noCancel] })
    expect(r.graders[0]).toMatchObject({ status: 'skipped' })
  })
})

describe('events and reporters', () => {
  const recorder = () => {
    const events: RunEvent[] = []
    const reporter: Reporter = { onEvent: e => { events.push(e) } }
    return { events, reporter }
  }

  it('emits start, each turn, each grader, then end, in order', async () => {
    const { events, reporter } = recorder()
    const target = fakeTarget(() => ({ text: 'ok then' }))
    const r = await runScenario(scn(), { target, simulator: createScriptedSimulator([]), graders: [noCancel], reporters: [reporter] })
    expect(events.map(e => e.type)).toEqual(['run:start', 'turn', 'turn', 'grader:done', 'run:end'])
    expect(events.every(e => e.runId === r.trace.runId)).toBe(true)
    expect((events.at(-1) as Extract<RunEvent, { type: 'run:end' }>).result.status).toBe('pass')
  })

  it('still emits run:end for a run that ended in error', async () => {
    const { events, reporter } = recorder()
    await runScenario(scn(), { target: fakeTarget(() => { throw new Error('down') }), simulator: createScriptedSimulator([]), graders: [noCancel], reporters: [reporter] })
    expect(events.at(-1)!.type).toBe('run:end')
  })

  it('cannot be failed by a reporter that throws', async () => {
    const bad: Reporter = { onEvent: () => { throw new Error('webhook down') } }
    const { events, reporter } = recorder()
    const r = await runScenario(scn(), { target: echo, simulator: createScriptedSimulator([]), graders: [noCancel], reporters: [bad, reporter] })
    expect(r.status).toBe('pass')
    expect(r.warnings.join(' ')).toMatch(/reporter failed on "run:start": webhook down/)
    expect(events.length).toBeGreaterThan(0)
  })
})

describe('runSuite', () => {
  it('runs scenarios in order, and a scenario that cannot be set up is that scenario\'s error', async () => {
    const results = await runSuite([scn({ id: 'a' }), scn({ id: 'broken' }), scn({ id: 'c' })], s => {
      if (s.id === 'broken') throw new Error('no target named "t" in the config')
      return { target: echo, simulator: createScriptedSimulator([]), graders: [noCancel] }
    })
    expect(results.map(r => [r.trace.scenario.id, r.status])).toEqual([['a', 'pass'], ['broken', 'error'], ['c', 'pass']])
    expect(results[1]!.error).toMatch(/no target named/)
  })
})
