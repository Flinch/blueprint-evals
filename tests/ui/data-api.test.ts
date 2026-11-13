import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OverviewResponse, RubricsResponse, RunsResponse, ScenariosResponse, SuitesResponse } from '../../src/ui/api-types.js'
import { buildOverview } from '../../src/server/views.js'
import { fixture, type Fixture } from './harness.js'
import { saveSuite } from './records.js'

const fixtures: Fixture[] = []
const make = async (...args: Parameters<typeof fixture>) => {
  const f = await fixture(...args)
  fixtures.push(f)
  return f
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(f => f.stop()))
})

describe('GET /api/health', () => {
  it('reports where things are and whether the UI is built', async () => {
    const f = await make()
    const r = (await f.api.get('/api/health')).json()
    expect(r).toMatchObject({
      ok: true,
      workdir: f.workdir,
      dataDir: join(f.workdir, '.evals'),
      configFile: f.configFile,
      scenarioPath: f.scenariosDir,
      labelsFile: join(f.workdir, '.evals', 'labels.jsonl'),
      uiBuilt: false,
      activeJob: null,
    })
    expect(typeof r.version).toBe('string')
  })
})

describe('overview, suites and runs', () => {
  async function seeded() {
    const f = await make()
    saveSuite(f.workdir, [
      { runId: 'r1', scenario: 'a', tags: ['billing'], criteria: { tone: 'pass', 'critical-one': 'pass' }, goalAchieved: true, costUsd: 0.5 },
      { runId: 'r2', scenario: 'b', tags: ['billing', 'safety'], criteria: { tone: 'fail', 'critical-one': 'pass' }, goalAchieved: false, costUsd: 0.25 },
    ], { suiteId: 's-old', startedAt: '2026-11-10T09:00:00Z' })
    saveSuite(f.workdir, [
      { runId: 'r3', scenario: 'a', tags: ['billing'], criteria: { tone: 'fail', 'critical-one': 'fail' }, goalAchieved: false, costUsd: null },
      { runId: 'r4', scenario: 'c', tags: ['safety'], status: 'error', error: 'target down', costUsd: 0 },
      { runId: 'r5', scenario: 'a', criteria: { tone: 'pass' }, goalAchieved: true, costUsd: 0.1 },
    ], { suiteId: 's-new', startedAt: '2026-11-12T09:00:00Z' })
    return f
  }

  it('aggregates counts, goal rate, cost (null-safe), trend, tags and failing criteria', async () => {
    const f = await seeded()
    const o = (await f.api.get('/api/overview')).json<OverviewResponse>()
    expect(o.suites).toEqual({ considered: 2, total: 2 })
    expect(o.runs).toBe(5)
    expect(o.counts).toEqual({ pass: 2, fail: 2, error: 1 })
    expect(o.goal).toEqual({ achieved: 2, total: 4, rate: 0.5 })
    // One run has an unknown cost: the total is unknown, never a partial sum shown as a total.
    expect(o.cost).toMatchObject({ totalUsd: null, runsWithUnknownCost: 1 })
    expect(o.cost.knownUsd).toBeCloseTo(0.85)
    // Trend: oldest first.
    expect(o.trend.map(t => t.suiteId)).toEqual(['s-old', 's-new'])
    expect(o.trend[0]).toMatchObject({ runs: 2, pass: 1, fail: 1, error: 0, passRate: 0.5, goalRate: 0.5, costUsd: 0.75 })
    expect(o.trend[1]).toMatchObject({ runs: 3, pass: 1, fail: 1, error: 1, costUsd: null })
    expect(o.trend[1]!.goalRate).toBeCloseTo(0.5)
    // Failures by tag.
    expect(o.failuresByTag).toEqual([
      { tag: 'billing', runs: 3, pass: 1, fail: 2, error: 0 },
      { tag: 'safety', runs: 2, pass: 0, fail: 1, error: 1 },
    ])
    // Most common failing criteria.
    expect(o.topFailingCriteria[0]).toMatchObject({ criterion: 'tone', failures: 2, judged: 4, failureRate: 0.5, scenarios: ['a', 'b'], critical: false })
    expect(o.topFailingCriteria[1]).toMatchObject({ criterion: 'critical-one', failures: 1, critical: true })
    expect(o.warnings).toEqual([])
  })

  it('has a known total when every cost is known, and handles an empty store', async () => {
    const f = await make()
    expect((await f.api.get('/api/overview')).json()).toMatchObject({ runs: 0, counts: { pass: 0, fail: 0, error: 0 }, goal: { rate: null }, cost: { totalUsd: 0 }, trend: [] })
    saveSuite(f.workdir, [{ runId: 'r1', costUsd: 0.5 }, { runId: 'r2', costUsd: 0.25 }])
    expect((await f.api.get('/api/overview')).json().cost).toMatchObject({ totalUsd: 0.75, runsWithUnknownCost: 0 })
  })

  it('limits the overview to the newest suites and says how many exist', async () => {
    const f = await seeded()
    const o = (await f.api.get('/api/overview?limit=1')).json<OverviewResponse>()
    expect(o.suites).toEqual({ considered: 1, total: 2 })
    expect(o.trend.map(t => t.suiteId)).toEqual(['s-new'])
    expect((await f.api.get('/api/overview?limit=0')).status).toBe(400)
    expect((await f.api.get('/api/overview?limit=abc')).status).toBe(400)
  })

  it('lists suites newest first, and returns one in full', async () => {
    const f = await seeded()
    const list = (await f.api.get('/api/suites')).json<SuitesResponse>()
    expect(list.suites.map(s => s.suiteId)).toEqual(['s-new', 's-old'])
    expect(list.suites[0]).toMatchObject({ state: 'complete', summary: { runs: 3, error: 1 } })
    expect(JSON.stringify(list)).not.toContain('"trace"')
    const one = (await f.api.get('/api/suites/s-old')).json()
    expect(one.results).toHaveLength(2)
    expect(one.results[0].trace.turns).toHaveLength(2)
    expect((await f.api.get('/api/suites/missing')).status).toBe(404)
  })

  it('lists runs with filters, newest first, and returns a single run with its trace', async () => {
    const f = await seeded()
    const all = (await f.api.get('/api/runs')).json<RunsResponse>()
    expect(all.total).toBe(5)
    expect(all.runs[0]).toMatchObject({ runId: expect.any(String), suiteId: expect.any(String), scenarioId: expect.any(String), models: { judge: 'judge-model' } })
    expect(JSON.stringify(all)).not.toContain('"turns":[')
    const failed = (await f.api.get('/api/runs?status=fail')).json<RunsResponse>()
    expect(failed.runs.map(r => r.runId).sort()).toEqual(['r2', 'r3'])
    expect(failed.runs.find(r => r.runId === 'r3')!.failedCriteria).toEqual(['tone', 'critical-one'])
    expect((await f.api.get('/api/runs?scenario=a')).json<RunsResponse>().total).toBe(3)
    expect((await f.api.get('/api/runs?tag=safety&suite=s-new')).json<RunsResponse>().runs.map(r => r.runId)).toEqual(['r4'])
    expect((await f.api.get('/api/runs?limit=2&offset=1')).json<RunsResponse>()).toMatchObject({ total: 5, runs: expect.any(Array) })
    expect((await f.api.get('/api/runs?status=nope')).status).toBe(400)

    const one = (await f.api.get('/api/runs/r3')).json()
    expect(one.suiteId).toBe('s-new')
    expect(one.result.trace.runId).toBe('r3')
    expect(one.result.graders[0].criteria[0]).toMatchObject({ id: 'tone', verdict: 'fail', critique: expect.stringContaining('JUDGE-CRITIQUE') })
    expect((await f.api.get('/api/runs/nope')).status).toBe(404)
  })

  it('skips corrupt suite files with a warning and still answers', async () => {
    const f = await seeded()
    const dir = join(f.workdir, '.evals', 'runs')
    writeFileSync(join(dir, 'broken.json'), '{"schemaVersion":1,')
    writeFileSync(join(dir, 'empty.json'), '')
    writeFileSync(join(dir, 'array.json'), '[]')
    const list = (await f.api.get('/api/suites')).json<SuitesResponse>()
    expect(list.suites.map(s => s.suiteId)).toEqual(['s-new', 's-old'])
    expect(list.warnings).toHaveLength(3)
    expect(list.warnings.join('\n')).toMatch(/broken\.json/)
    const overview = (await f.api.get('/api/overview')).json<OverviewResponse>()
    expect(overview.runs).toBe(5)
    expect(overview.warnings).toHaveLength(3)
    expect((await f.api.get('/api/runs')).json<RunsResponse>().warnings).toHaveLength(3)
    const bad = await f.api.get('/api/suites/broken')
    expect(bad.status).toBe(422)
    expect(bad.json().error.code).toBe('corrupt_record')
  })

  it('overview math works without a server, for a suite with no runs', () => {
    const o = buildOverview([], 0, [])
    expect(o.goal.rate).toBeNull()
    expect(o.topFailingCriteria).toEqual([])
  })
})

describe('scenarios and rubrics', () => {
  it('lists the parsed scenarios and the validation report, with env variable names and never values', async () => {
    const f = await make()
    const r = (await f.api.get('/api/scenarios')).json<ScenariosResponse>()
    expect(r.scenarios.map(s => s.scenario.id)).toEqual(['asks-to-cancel-then-declines', 'reschedule-asks-before-acting', 'asks-for-medical-advice', 'reschedule-tomorrow-3pm'])
    const det = r.scenarios.find(s => s.scenario.id === 'reschedule-asks-before-acting')!
    expect(det).toMatchObject({ needsModel: false, rubricId: null, needs: { simulatorCalls: 0, rubricCalls: 0, goalCalls: 0 } })
    expect(r.scenarios.find(s => s.scenario.id === 'reschedule-tomorrow-3pm')).toMatchObject({ needsModel: true, rubricId: 'scheduling', needs: { simulatorCalls: 6, rubricCalls: 1, goalCalls: 1 } })
    expect(r.validation.errors).toEqual([])
    expect(r.validation.envRefs).toEqual([{ name: 'UI_TEST_SECRET', targets: ['stub-agent'], isSet: true }])
    expect(r.configFile).toBe(f.configFile)
  })

  it('reports problems the way `evals validate` does, and keeps listing what is good', async () => {
    const f = await make({
      ownScenarios: true,
      files: {
        'good.yaml': 'id: good\nversion: 1\ntarget: stub-agent\nseed_message: hi\nchecks:\n  - type: must_not_call\n    tool: x\n',
        'bad.yaml': 'id: Bad Id\nversion: 1\ntarget: stub-agent\nseed_message: hi\n',
        'ghost.yaml': 'id: ghost\nversion: 1\ntarget: nowhere\nseed_message: hi\n',
        'dup.yaml': 'id: good\nversion: 1\ntarget: stub-agent\nseed_message: hi\n',
        'rubrics/r.yaml': 'id: r\nversion: 1\ncriteria:\n  - id: c\n    text: Be nice.\n',
        'rubrics/broken.yaml': 'id: broken\nversion: 1\ncriteria: []\n',
      },
    })
    const r = (await f.api.get('/api/scenarios')).json<ScenariosResponse>()
    expect(r.scenarios.map(s => s.scenario.id)).toEqual(['good', 'ghost'])
    const errors = r.validation.errors.join('\n')
    expect(errors).toMatch(/bad\.yaml/)
    expect(errors).toMatch(/Duplicate scenario id "good"/)
    expect(errors).toMatch(/uses the target "nowhere", which is not in the config/)
    expect(errors).toMatch(/broken\.yaml/)
    const rubrics = (await f.api.get('/api/rubrics')).json<RubricsResponse>()
    expect(rubrics.rubrics.map(x => x.rubric.id)).toEqual(['r'])
    expect(rubrics.problems.join('\n')).toMatch(/broken\.yaml/)
  })

  it('lists rubrics with their criteria, anchors and the scenarios that use them', async () => {
    const f = await make()
    const r = (await f.api.get('/api/rubrics')).json<RubricsResponse>()
    expect(r.rubrics).toHaveLength(1)
    expect(r.rubrics[0]!.rubric).toMatchObject({ id: 'scheduling', criteria: [{ id: 'confirms-before-acting', critical: false }, { id: 'no-medical-advice', critical: true }] })
    expect(r.rubrics[0]!.rubric.anchors).toHaveLength(2)
    expect(r.rubrics[0]!.usedBy.sort()).toEqual(['asks-for-medical-advice', 'asks-to-cancel-then-declines', 'reschedule-tomorrow-3pm'])
  })

  it('still answers when there is no config or no scenarios path', async () => {
    const f = await make({ noConfig: true, server: { scenarioPath: null } })
    const r = (await f.api.get('/api/scenarios')).json<ScenariosResponse>()
    expect(r.scenarios).toEqual([])
    expect(r.validation.errors.join('\n')).toMatch(/no scenarios path/i)
    expect(r.validation.errors.join('\n')).toMatch(/No config file/)
    expect((await f.api.get('/api/rubrics')).json().rubrics).toEqual([])
  })
})
