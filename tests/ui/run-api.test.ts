import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeProvider, type CompleteRequest, type FakeProvider } from '../../src/index.js'
import { createPreviewTokens } from '../../src/server/preview-token.js'
import { createSuiteWriter } from '../../src/store/index.js'
import type { RunPreviewResponse, SuiteResponse } from '../../src/ui/api-types.js'
import { DETERMINISTIC, fixture, hasSuiteEnd, MODEL_SCENARIO, sse, approvingProvider, type Fixture } from './harness.js'

const fixtures: Fixture[] = []
const make = async (...args: Parameters<typeof fixture>) => {
  const f = await fixture(...args)
  fixtures.push(f)
  return f
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(f => f.stop()))
})

/** A provider the test can hold still: the first simulator call waits for `release`. */
function gatedProvider(): { provider: FakeProvider; release(): void; reached: Promise<void> } {
  let release!: () => void
  const gate = new Promise<void>(r => (release = r))
  let reached!: () => void
  const reachedP = new Promise<void>(r => (reached = r))
  const inner = approvingProvider()
  const provider: FakeProvider = {
    calls: inner.calls,
    async complete(req: CompleteRequest) {
      if (req.role === 'simulator') {
        reached()
        await gate
        return createFakeProvider({ json: { action: 'say', message: 'yes please' } }).complete(req)
      }
      return inner.complete(req)
    },
  }
  return { provider, release, reached: reachedP }
}

const runsDir = (f: Fixture) => join(f.workdir, '.evals', 'runs')

describe('POST /api/run/preview', () => {
  it('returns the same data the CLI prints, as JSON, plus a token', async () => {
    const f = await make()
    const r = await f.api.post('/api/run/preview', { maxCostUsd: 0.5 })
    expect(r.status).toBe(200)
    const body = r.json<RunPreviewResponse>()
    expect(body.preview).toMatchObject({
      kind: 'run',
      scenarios: { selected: 4, withModel: 3, deterministicOnly: 1 },
      calls: { simulator: 13, rubric: 3, goal: 3, judge: 6, total: 19 },
      cap: { usd: 0.5, source: 'maxCostUsd in the request', worstCaseUsd: 1.5 },
      anyModelCalls: true,
      models: {
        simulator: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'low', effortIsDefault: false, priced: true },
        judge: { model: 'claude-opus-5-5', effort: 'high', priced: true },
      },
    })
    expect(body.lines[0]).toBe('Cost preview')
    expect(body.lines.join('\n')).toMatch(/Simulator calls: up to 13 \(claude-opus-5-5, effort low\)/)
    expect(body.lines.join('\n')).toMatch(/Worst-case total: \$1\.50 \(3 scenarios x \$0\.50\)/)
    expect(typeof body.previewToken).toBe('string')
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now())
    expect(body.plan).toMatchObject({ scenarioIds: expect.any(Array), capUsd: 0.5 })
    expect(f.provider.calls).toHaveLength(0)
  })

  it('warns when there is no cap, and for a model with no price', async () => {
    const f = await make({ configEdit: t => t.replace('claude-opus-5-5: {', 'other: {') })
    const body = (await f.api.post('/api/run/preview', {})).json<RunPreviewResponse>()
    expect(body.preview.cap).toBeNull()
    expect(body.warnings.join('\n')).toMatch(/no cost cap is set/)
    expect(body.warnings.join('\n')).toMatch(/no price for model "claude-opus-5-5"/)
    expect(body.preview.models.judge?.priced).toBe(false)
    expect(body.lines.join('\n')).toMatch(/WARNING: no cost cap is set/)
  })

  it('reports an unset environment variable as a warning, by name, with no value', async () => {
    const f = await make({ env: { UI_TEST_SECRET: '' } })
    const body = (await f.api.post('/api/run/preview', { only: [DETERMINISTIC] })).json<RunPreviewResponse>()
    expect(body.warnings.join('\n')).toMatch(/Environment variable UI_TEST_SECRET is not set/)
  })

  it('a deterministic plan has no model calls', async () => {
    const f = await make()
    const body = (await f.api.post('/api/run/preview', { only: [DETERMINISTIC] })).json<RunPreviewResponse>()
    expect(body.preview).toMatchObject({ anyModelCalls: false, calls: { total: 0 }, scenarios: { selected: 1, withModel: 0 } })
  })

  it('answers an unusable plan with 422 and the list of problems', async () => {
    const f = await make()
    const unknown = await f.api.post('/api/run/preview', { only: ['nope'] })
    expect(unknown.status).toBe(422)
    expect(unknown.json().error.code).toBe('plan_invalid')
    expect(unknown.json().error.message).toMatch(/"only" names scenarios that were not found: nope/)
    const none = await f.api.post('/api/run/preview', { only: [DETERMINISTIC], tags: ['safety'] })
    expect(none.status).toBe(422)
    expect(none.json().error.message).toMatch(/no scenarios matched "only" and "tags"/)
    const badCap = await f.api.post('/api/run/preview', { maxCostUsd: -1 })
    expect(badCap.status).toBe(400)
  })

  it('reports a missing or invalid config', async () => {
    const none = await make({ noConfig: true })
    expect((await none.api.post('/api/run/preview', {})).json().error.code).toBe('config_missing')
    const bad = await make({ configEdit: () => 'models: nope' })
    expect((await bad.api.post('/api/run/preview', {})).json().error.code).toBe('config_invalid')
  })

  it('refuses a path outside the working directory, the config directory and the scenarios path', async () => {
    const f = await make()
    for (const path of ['/etc', '../../..', '/']) {
      const r = await f.api.post('/api/run/preview', { path })
      expect([400, 422], path).toContain(r.status)
      expect(r.json().error.message, path).not.toMatch(/root:/)
    }
    expect((await f.api.post('/api/run/preview', { path: '/etc' })).status).toBe(400)
    // A path inside the scenarios directory is fine.
    expect((await f.api.post('/api/run/preview', { path: join(f.scenariosDir, 'deterministic-reschedule.yaml') })).status).toBe(200)
  })
})

describe('POST /api/run/start: the cost confirmation gate', () => {
  async function preview(f: Fixture, body: Record<string, unknown>) {
    return (await f.api.post('/api/run/preview', body)).json<RunPreviewResponse>()
  }

  it('refuses a plan that can call a model without a token and confirm, and calls nothing', async () => {
    const f = await make({ provider: approvingProvider() })
    const body = { only: [MODEL_SCENARIO] }
    for (const extra of [{}, { confirm: true }, { previewToken: 'x.y' }, { confirm: false, previewToken: (await preview(f, body)).previewToken }]) {
      const r = await f.api.post('/api/run/start', { ...body, ...extra })
      expect(r.status).toBe(428)
      expect(r.json().error.code).toBe('confirmation_required')
    }
    expect(f.provider.calls).toHaveLength(0)
    expect(existsSync(runsDir(f))).toBe(false)
    expect((await f.api.get('/api/run/status')).json().activeJob).toBeNull()
  })

  it('refuses a garbage token, an expired token and a token from another server', async () => {
    const f = await make({ provider: approvingProvider() })
    const body = { only: [MODEL_SCENARIO] }
    for (const previewToken of ['garbage', '1.abc', `${Date.now() + 1e9}.${'0'.repeat(64)}`]) {
      const r = await f.api.post('/api/run/start', { ...body, previewToken, confirm: true })
      expect(r.status, previewToken).toBe(412)
      expect(r.json().error.code).toBe('preview_token_invalid')
    }
    // Same plan, signed by a different key: refused.
    const { plan } = await preview(f, body)
    expect(plan.scenarioIds).toEqual([MODEL_SCENARIO])
    const foreign = createPreviewTokens(Buffer.alloc(32, 7)).issue({ anything: true }).token
    expect((await f.api.post('/api/run/start', { ...body, previewToken: foreign, confirm: true })).status).toBe(412)
    expect(f.provider.calls).toHaveLength(0)
  })

  it('refuses a tampered plan: a token for one plan does not start another', async () => {
    const f = await make({ provider: approvingProvider() })
    const { previewToken } = await preview(f, { only: [MODEL_SCENARIO], maxCostUsd: 1 })
    for (const changed of [
      { only: [MODEL_SCENARIO, 'asks-for-medical-advice'], maxCostUsd: 1 }, // more scenarios, so more spend
      { only: [MODEL_SCENARIO], maxCostUsd: 100 }, // a higher cap
      { only: [MODEL_SCENARIO] }, // the cap removed
    ]) {
      const r = await f.api.post('/api/run/start', { ...changed, previewToken, confirm: true })
      expect(r.status, JSON.stringify(changed)).toBe(412)
    }
    expect(f.provider.calls).toHaveLength(0)
  })

  it('accepts the token for the same plan however the selection is written', async () => {
    const f = await make({ provider: approvingProvider() })
    const { previewToken } = await preview(f, { only: [MODEL_SCENARIO], maxCostUsd: 1 })
    // The tag "happy-path" selects the same single scenario, with the same cap: the same plan.
    const stream = sse(f.ui, { until: hasSuiteEnd })
    expect((await f.api.post('/api/run/start', { tags: ['happy-path'], maxCostUsd: 1, previewToken, confirm: true })).status).toBe(202)
    await stream.done
  })

  it('refuses a token once the config under it changed (prices, models, the agent)', async () => {
    const f = await make({ provider: approvingProvider() })
    const body = { only: [MODEL_SCENARIO], maxCostUsd: 1 }
    const { previewToken } = await preview(f, body)
    writeFileSync(f.configFile, readFileSync(f.configFile, 'utf8').replace('outputPerMTok: 20.00', 'outputPerMTok: 2000.00'))
    const r = await f.api.post('/api/run/start', { ...body, previewToken, confirm: true })
    expect(r.status).toBe(412)
    expect(f.provider.calls).toHaveLength(0)
  })

  it('refuses a token that was issued for a different scenario', async () => {
    const f = await make({ provider: approvingProvider() })
    const { previewToken } = await preview(f, { only: [MODEL_SCENARIO] })
    expect((await f.api.post('/api/run/start', { only: ['asks-for-medical-advice'], previewToken, confirm: true })).status).toBe(412)
    expect(f.provider.calls).toHaveLength(0)
  })

  it('starts a model plan with a matching token and confirm, using the provider the server builds', async () => {
    const f = await make({ provider: approvingProvider() })
    const body = { only: [MODEL_SCENARIO], maxCostUsd: 1 }
    const { previewToken } = await preview(f, body)
    const stream = sse(f.ui, { until: hasSuiteEnd })
    const r = await f.api.post('/api/run/start', { ...body, previewToken, confirm: true })
    expect(r.status).toBe(202)
    const started = r.json()
    expect(started.suiteId).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{8}$/)
    const events = await stream.done
    const end = events.find(e => e.event === 'suite:end')!
    expect(end.data).toMatchObject({ state: 'complete', suiteId: started.suiteId, summary: { runs: 1, pass: 1 } })
    expect(f.provider.calls.map(c => c.role)).toEqual(['simulator', 'simulator', 'judge', 'judge'])
    // Budget enforcement is the runner's: the cap reached it.
    const suite = (await f.api.get(`/api/suites/${started.suiteId}`)).json<SuiteResponse>()
    expect(suite.results[0]!.status).toBe('pass')
    expect(suite.results[0]!.goalAchieved).toBe(true)
  })

  it('enforces the cap through the same runner code as the CLI', async () => {
    const provider = createFakeProvider({ json: { action: 'say', message: 'yes' } }, { usage: { inputTokens: 1, outputTokens: 1, costUsd: 1 } })
    const f = await make({ provider })
    const body = { only: [MODEL_SCENARIO], maxCostUsd: 0.5 }
    const { previewToken } = await preview(f, body)
    const stream = sse(f.ui, { until: hasSuiteEnd })
    await f.api.post('/api/run/start', { ...body, previewToken, confirm: true })
    const events = await stream.done
    const runEnd = events.find(e => e.event === 'run:end')!
    expect(runEnd.data.summary.status).toBe('error')
    expect(runEnd.data.summary.error).toMatch(/Cost budget of \$0\.5 exceeded/)
  })

  it('needs neither token nor confirm for a plan that makes no model call, and never builds a provider', async () => {
    let built = 0
    const f = await make({ server: { createProvider: () => { built++; throw new Error('no provider expected') } } })
    const stream = sse(f.ui, { until: hasSuiteEnd })
    const r = await f.api.post('/api/run/start', { only: [DETERMINISTIC] })
    expect(r.status).toBe(202)
    expect((await stream.done).find(e => e.event === 'suite:end')!.data.state).toBe('complete')
    expect(built).toBe(0)
  })

  it('answers 503 when the provider cannot be built, and runs nothing', async () => {
    const f = await make({ server: { createProvider: () => { throw new Error('no key') } } })
    const body = { only: [MODEL_SCENARIO] }
    const { previewToken } = await preview(f, body)
    const r = await f.api.post('/api/run/start', { ...body, previewToken, confirm: true })
    expect(r.status).toBe(503)
    expect(r.json().error.code).toBe('provider_unavailable')
    expect(existsSync(runsDir(f))).toBe(false)
    expect((await f.api.get('/api/run/status')).json().activeJob).toBeNull()
  })
})

describe('a deterministic run over HTTP', () => {
  it('streams run:start, turn, grader:done, run:end and suite:end, and saves the suite', async () => {
    const f = await make()
    const stream = sse(f.ui, { until: hasSuiteEnd })
    const started = (await f.api.post('/api/run/start', { only: [DETERMINISTIC] })).json()
    const events = await stream.done

    expect(events[0]!.event).toBe('hello')
    const named = events.filter(e => e.event !== 'hello')
    expect(named.map(e => e.event)).toEqual(['suite:start', 'run:start', 'turn', 'turn', 'grader:done', 'grader:done', 'run:end', 'suite:end'])
    // Sequence numbers rise, and every event names its suite.
    const seqs = named.map(e => e.data.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(named.every(e => e.data.suiteId === started.suiteId && e.id === String(e.data.seq) && e.data.type === e.event)).toBe(true)

    const [, start, userTurn, agentTurn, , , runEnd, end] = named
    expect(named[0]!.data).toMatchObject({ scenarioIds: [DETERMINISTIC], preview: { anyModelCalls: false } })
    expect(userTurn!.data.turn).toMatchObject({ index: 0, role: 'user' })
    expect(agentTurn!.data.turn).toMatchObject({ index: 1, role: 'assistant' })
    // The stream is light: the raw response stays out of it.
    expect(agentTurn!.data.turn.raw).toBeUndefined()
    expect(named.find(e => e.event === 'grader:done')!.data.result).toMatchObject({ grader: 'must_not_call(reschedule_appointment)', status: 'pass' })
    expect(runEnd!.data).toMatchObject({ runId: start!.data.runId, summary: { status: 'pass', scenarioId: DETERMINISTIC, failedCriteria: [], turns: 2 } })
    expect(end!.data).toMatchObject({ state: 'complete', summary: { runs: 1, pass: 1, fail: 0, error: 0 } })

    // Saved: on disk, through the API, and listed.
    const file = join(runsDir(f), `${started.suiteId}.json`)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved).toMatchObject({ schemaVersion: 1, suiteId: started.suiteId, status: 'complete', command: 'evals ui', configFile: f.configFile, scenarioPath: f.scenariosDir })
    expect(saved.endedAt).not.toBeNull()
    expect(saved.results[0].trace.runId).toBe(start!.data.runId)
    expect(saved.results[0].trace.turns[1].raw).toMatchObject({ tool_calls: [] })

    const suites = (await f.api.get('/api/suites')).json()
    expect(suites.suites.map((s: { suiteId: string }) => s.suiteId)).toEqual([started.suiteId])
    expect(suites.suites[0]).toMatchObject({ state: 'complete', summary: { runs: 1, pass: 1 } })
    expect((await f.api.get(`/api/runs/${start!.data.runId}`)).json()).toMatchObject({ suiteId: started.suiteId, result: { status: 'pass' } })
    expect((await f.api.get('/api/run/status')).json().activeJob).toBeNull()
  })

  it('shows a late joiner what happened, and honours Last-Event-ID', async () => {
    const f = await make()
    const first = sse(f.ui, { until: hasSuiteEnd })
    await f.api.post('/api/run/start', { only: [DETERMINISTIC] })
    const all = (await first.done).filter(e => e.event !== 'hello')

    const late = await sse(f.ui, { until: hasSuiteEnd }).done
    expect(late.filter(e => e.event !== 'hello').map(e => e.event)).toEqual(all.map(e => e.event))
    expect(late[0]!.data).toEqual({ type: 'hello', activeJob: null })

    const resumed = await sse(f.ui, { until: hasSuiteEnd, headers: { 'last-event-id': all[all.length - 3]!.id! } }).done
    expect(resumed.filter(e => e.event !== 'hello').map(e => e.event)).toEqual(all.slice(-2).map(e => e.event))
  })

  it('records a failing agent as a failed run, not an error', async () => {
    const f = await make({ agentDefect: 'no-confirm' })
    const stream = sse(f.ui, { until: hasSuiteEnd })
    await f.api.post('/api/run/start', { only: [DETERMINISTIC] })
    const events = await stream.done
    expect(events.find(e => e.event === 'run:end')!.data.summary.status).toBe('fail')
    expect(events.find(e => e.event === 'suite:end')!.data.summary).toMatchObject({ runs: 1, fail: 1 })
  })
})

describe('one run at a time, and cancel', () => {
  it('answers 409 to a second start, and to a calibration, while a run is going', async () => {
    const g = gatedProvider()
    const f = await make({ provider: g.provider })
    const body = { only: [MODEL_SCENARIO], maxCostUsd: 1 }
    const { previewToken } = (await f.api.post('/api/run/preview', body)).json<RunPreviewResponse>()
    const first = await f.api.post('/api/run/start', { ...body, previewToken, confirm: true })
    expect(first.status).toBe(202)
    await g.reached

    const status = (await f.api.get('/api/run/status')).json()
    expect(status.activeJob).toMatchObject({ kind: 'run', suiteId: first.json().suiteId, scenarioIds: [MODEL_SCENARIO], finished: 0, cancelling: false })
    expect((await f.api.get('/api/health')).json().activeJob.kind).toBe('run')
    const listed = (await f.api.get('/api/suites')).json()
    expect(listed.suites[0]).toMatchObject({ state: 'running', endedAt: null })

    for (const second of [{ only: [DETERMINISTIC] }, { only: [MODEL_SCENARIO], previewToken, confirm: true, maxCostUsd: 1 }]) {
      const r = await f.api.post('/api/run/start', second)
      expect(r.status).toBe(409)
      expect(r.json().error.code).toBe('run_in_progress')
    }
    expect((await f.api.post('/api/calibrate/start', { rubricId: 'scheduling', split: 'dev' })).status).toBe(409)

    const stream = sse(f.ui, { until: hasSuiteEnd })
    g.release()
    expect((await stream.done).find(e => e.event === 'suite:end')!.data.state).toBe('complete')
    // And afterwards a new run is accepted.
    expect((await f.api.post('/api/run/start', { only: [DETERMINISTIC] })).status).toBe(202)
  })

  it('cancels a run in progress: the scenario in flight ends as an error and no further one starts', async () => {
    const g = gatedProvider()
    const f = await make({ provider: g.provider })
    const body = { only: [MODEL_SCENARIO, 'asks-for-medical-advice'], maxCostUsd: 1 }
    const { previewToken } = (await f.api.post('/api/run/preview', body)).json<RunPreviewResponse>()
    const stream = sse(f.ui, { until: hasSuiteEnd })
    const started = (await f.api.post('/api/run/start', { ...body, previewToken, confirm: true })).json()
    await g.reached

    const cancel = await f.api.post('/api/run/cancel')
    expect(cancel.status).toBe(202)
    expect(cancel.json()).toEqual({ suiteId: started.suiteId, cancelling: true })
    expect((await f.api.get('/api/run/status')).json().activeJob.cancelling).toBe(true)
    g.release()

    const events = await stream.done
    const end = events.find(e => e.event === 'suite:end')!
    expect(end.data.state).toBe('cancelled')
    expect(end.data.summary.runs).toBe(1)
    const runEnds = events.filter(e => e.event === 'run:end')
    expect(runEnds).toHaveLength(1)
    // Scenarios run in the order they load (by file name), which puts the medical question first.
    expect(runEnds[0]!.data.summary).toMatchObject({ scenarioId: 'asks-for-medical-advice', status: 'error', error: 'The run was cancelled.' })

    const saved = JSON.parse(readFileSync(join(runsDir(f), `${started.suiteId}.json`), 'utf8'))
    expect(saved.status).toBe('cancelled')
    expect(saved.results).toHaveLength(1)
    expect((await f.api.get('/api/run/status')).json().activeJob).toBeNull()
  })

  it('answers 409 when there is nothing to cancel', async () => {
    const f = await make()
    const r = await f.api.post('/api/run/cancel')
    expect(r.status).toBe(409)
    expect(r.json().error.code).toBe('no_active_run')
  })

  it('stops a running run when the server closes, and leaves a readable partial file', async () => {
    const g = gatedProvider()
    const f = await make({ provider: g.provider })
    const body = { only: [MODEL_SCENARIO], maxCostUsd: 1 }
    const { previewToken } = (await f.api.post('/api/run/preview', body)).json<RunPreviewResponse>()
    const started = (await f.api.post('/api/run/start', { ...body, previewToken, confirm: true })).json()
    await g.reached
    const closing = f.ui.close()
    g.release()
    await closing
    const saved = JSON.parse(readFileSync(join(runsDir(f), `${started.suiteId}.json`), 'utf8'))
    expect(saved.status).toBe('cancelled')
    expect(readdirSync(runsDir(f)).filter(n => n.endsWith('.tmp'))).toEqual([])
    fixtures.splice(fixtures.indexOf(f), 1)
  })

  it('reports a suite left "running" by a dead process as interrupted', async () => {
    const f = await make()
    const w = createSuiteWriter({ dir: runsDir(f), command: 'evals run', configFile: 'c', scenarioPath: 's', suiteId: 'crashed' })
    w.start() // never finished: the process "died"
    const listed = (await f.api.get('/api/suites')).json()
    expect(listed.suites.find((s: { suiteId: string }) => s.suiteId === 'crashed')).toMatchObject({ state: 'interrupted', endedAt: null })
  })
})
