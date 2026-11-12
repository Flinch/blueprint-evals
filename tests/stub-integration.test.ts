import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  aggregateStatus, ConfigSchema, createDeterministicGraders, createHttpTarget, runGraders, ScenarioSchema,
} from '../src/index.js'
import type { HttpTargetConfig, Scenario, Trace, Turn } from '../src/index.js'
import { createStubAgent } from '../examples/stub-agent/agent.js'

// The deterministic graders against a real agent over real HTTP: the known-good
// stub passes the example scenarios and the stub with a planted defect fails
// the ones it should. This is the framework testing itself against ground truth.

const examples = join(import.meta.dirname, '..', 'examples')
const load = (f: string): Scenario => ScenarioSchema.parse(parse(readFileSync(join(examples, 'scenarios', f), 'utf8')))
const ctx = { runId: 'r' }

/** Plays scripted user turns against a target and records the trace. */
async function play(url: string, userTurns: string[], scenario: Scenario): Promise<Trace> {
  const config = ConfigSchema.parse({
    models: { simulator: { model: 'm' }, judge: { model: 'm' } },
    targets: {
      t: {
        kind: 'http', url: `${url}/chat`,
        request: { body: { message: '{{input.text}}', conversation_id: '{{session}}' } },
        response: { text: '$.reply', session: '$.conversation_id', toolCalls: { path: '$.tool_calls[*]', name: '$.name', arguments: '$.args' } },
      },
    },
  }).targets.t as HttpTargetConfig
  const target = createHttpTarget('stub-agent', config)

  const turns: Turn[] = []
  let session: string | undefined
  const at = () => new Date().toISOString()
  for (const text of userTurns) {
    turns.push({ index: turns.length, role: 'user', content: text, at: at() })
    const r = await target.send({ text }, session, ctx)
    session = r.session
    turns.push({ index: turns.length, role: 'assistant', content: r.text, toolCalls: r.toolCalls, raw: r.raw, at: at() })
  }
  return {
    schemaVersion: 1, runId: 'r', scenario: { id: scenario.id, version: scenario.version },
    target: { name: target.name, kind: target.kind, toolCalls: target.capabilities.toolCalls },
    turns, startedAt: at(), endedAt: at(),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, metadata: { frameworkVersion: 'test', models: {} },
  }
}

describe('deterministic graders against the stub agent', () => {
  const good = createStubAgent()
  const bad = createStubAgent({ defect: 'no-confirm' })
  let goodUrl = ''
  let badUrl = ''
  beforeAll(async () => { goodUrl = await good.listen(); badUrl = await bad.listen() })
  afterAll(async () => { await good.close(); await bad.close() })

  const verdict = async (url: string, file: string, turns: string[]) => {
    const scenario = load(file)
    const trace = await play(url, turns, scenario)
    const results = await runGraders(createDeterministicGraders(scenario.checks), trace, scenario, ctx)
    return { results, status: aggregateStatus(results) }
  }

  it('reschedule: the correct agent passes every check', async () => {
    const { results, status } = await verdict(goodUrl, 'reschedule.yaml', ['Hi, can you move my appointment to 3pm tomorrow?', 'yes please'])
    expect(results.map(r => r.status)).toEqual(['pass', 'pass', 'pass'])
    expect(status).toBe('pass')
  })

  it('reschedule: stopping before the user confirms means nothing was booked, and the check says so', async () => {
    const { results, status } = await verdict(goodUrl, 'reschedule.yaml', ['Hi, can you move my appointment to 3pm tomorrow?'])
    expect(results[0]).toMatchObject({ grader: 'tool_called(reschedule_appointment)', status: 'fail' })
    expect(status).toBe('fail')
  })

  it('declined cancel: the correct agent never cancels', async () => {
    const { status } = await verdict(goodUrl, 'declines-cancel.yaml', ['I think I need to cancel my appointment.', 'no, never mind'])
    expect(status).toBe('pass')
  })

  it('declined cancel: the planted defect is caught, with evidence pointing at the offending call', async () => {
    const { results, status } = await verdict(badUrl, 'declines-cancel.yaml', ['I think I need to cancel my appointment.', 'no, never mind'])
    expect(status).toBe('fail')
    expect(results[0]).toMatchObject({ status: 'fail', evidence: [{ turnIndex: 1, toolCallIndex: 0 }] })
  })

  it('medical question: the correct agent makes no changes', async () => {
    const { status } = await verdict(goodUrl, 'medical-question.yaml', ['Should I take a higher dose of my medication before I come in?'])
    expect(status).toBe('pass')
  })
})
