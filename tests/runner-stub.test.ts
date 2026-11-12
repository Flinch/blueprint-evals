import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createFakeProvider, createHttpTarget, createScriptedSimulator, gradersForScenario, loadConfig, loadScenario, runScenario,
} from '../src/index.js'
import type { HttpTargetConfig } from '../src/index.js'
import { createStubAgent } from '../examples/stub-agent/agent.js'

// The whole framework against a real agent over real HTTP: target, simulator,
// graders and runner together. The correct stub passes, and the stub with a
// planted defect is caught. No network beyond localhost and no model calls.

const examples = join(import.meta.dirname, '..', 'examples')
const httpConfig = loadConfig(join(examples, 'evals.config.yaml')).targets['stub-agent'] as HttpTargetConfig

describe('runner against the stub agent over HTTP', () => {
  const good = createStubAgent()
  const bad = createStubAgent({ defect: 'no-confirm' })
  let goodUrl = ''
  let badUrl = ''
  beforeAll(async () => { goodUrl = await good.listen(); badUrl = await bad.listen() })
  afterAll(async () => { await good.close(); await bad.close() })

  const targetAt = (url: string) => createHttpTarget('stub-agent', { ...httpConfig, url: `${url}/chat` })
  // A judge that approves everything. The point here is the deterministic layer and the plumbing.
  const approving = () =>
    createFakeProvider(req =>
      req.messages[0]!.content.includes('Criteria to judge')
        ? { json: { verdicts: [{ criterion_id: 'confirms-before-acting', critique: 'ok', verdict: 'pass' }, { criterion_id: 'no-medical-advice', critique: 'ok', verdict: 'pass' }] } }
        : { json: { achieved: true, critique: 'ok' } },
    )

  async function play(file: string, url: string, userTurns: string[], provider = approving()) {
    const { scenario, rubric } = loadScenario(join(examples, 'scenarios', file))
    const result = await runScenario(scenario, {
      target: targetAt(url),
      simulator: createScriptedSimulator(userTurns),
      graders: gradersForScenario(scenario, { rubric, provider }),
    })
    return { result, provider }
  }

  it('passes the reschedule scenario on the correct agent, end to end', async () => {
    const { result } = await play('reschedule.yaml', goodUrl, ['yes please'])
    expect(result.status).toBe('pass')
    expect(result.trace.turns).toHaveLength(4)
    expect(result.trace.turns[3]!.toolCalls).toEqual([{ name: 'reschedule_appointment', arguments: { date: 'tomorrow', time: '15:00' } }])
    expect(result.warnings.join(' ')).toMatch(/unverified/)
  })

  it('fails the reschedule scenario if the conversation ends before the user confirms', async () => {
    const { result } = await play('reschedule.yaml', goodUrl, [])
    expect(result.status).toBe('fail')
    expect(result.graders.find(g => g.grader === 'tool_called(reschedule_appointment)')?.status).toBe('fail')
  })

  it('passes the declined-cancel scenario on the correct agent', async () => {
    const { result } = await play('declines-cancel.yaml', goodUrl, ['no, never mind'])
    expect(result.status).toBe('pass')
  })

  it('catches the planted defect, and does not spend a model call finding it out', async () => {
    const { result, provider } = await play('declines-cancel.yaml', badUrl, ['no, never mind'])
    expect(result.status).toBe('fail')
    const failed = result.graders.find(g => g.status === 'fail')!
    expect(failed.grader).toBe('must_not_call(cancel_appointment)')
    expect(failed.evidence).toEqual([{ turnIndex: 1, toolCallIndex: 0 }])
    expect(provider.calls).toHaveLength(0)
    expect(result.trace.turns[1]!.toolCalls?.[0]?.name).toBe('cancel_appointment')
  })

  it('reports an unreachable agent as an error with the partial trace, not a failure of the agent', async () => {
    const { scenario, rubric } = loadScenario(join(examples, 'scenarios', 'reschedule.yaml'))
    const r = await runScenario(scenario, {
      target: createHttpTarget('stub-agent', { ...httpConfig, url: 'http://127.0.0.1:1/chat', timeoutMs: 2_000 }),
      simulator: createScriptedSimulator([]),
      graders: gradersForScenario(scenario, { rubric, provider: approving() }),
    })
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/stub-agent/)
    expect(r.graders).toEqual([])
  })
})
