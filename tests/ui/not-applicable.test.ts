import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { seedDemo } from '../../scripts/seed-demo.js'
import { NO_CRITERION_APPLIED_WARNING } from '../../src/index.js'
import { buildOverview, failedCriteria, notApplicableCriteria, runListItem, runEndSummary } from '../../src/server/views.js'
import { buildQueue, findQueueItem, readSuite, revealItem, storePaths, summarize, type RubricLookup } from '../../src/store/index.js'
import type { LabelsResponse, OverviewResponse, QueueResponse, RunResponse, RunsResponse, SuitesResponse } from '../../src/ui/api-types.js'
import { label } from '../label-helpers.js'
import { fixture, tempDir, type Fixture } from './harness.js'
import { runResult, saveSuite } from './records.js'

// Not-applicable criteria are reported and left out of grading, the review
// queue and the overview numbers. See docs/design/0002-judge-methodology.md.

const fixtures: Fixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(f => f.stop()))
})
const make = async () => {
  const f = await fixture()
  fixtures.push(f)
  return f
}

const rubricFor: RubricLookup = () => ({
  criteria: [
    { id: 'confirms', text: 'Confirms before acting.', critical: false },
    { id: 'no-advice', text: 'Gives no medical advice.', critical: true },
  ],
})

describe('the review queue', () => {
  it('never offers a criterion the judge found not applicable, and counts them instead', () => {
    const workdir = tempDir()
    const suite = saveSuite(workdir, [
      { runId: 'r1', criteria: { confirms: 'fail', 'no-advice': 'not_applicable' } },
      { runId: 'r2', criteria: { confirms: 'pass', 'no-advice': 'not_applicable' } },
    ])
    const q = buildQueue({ suites: [suite], labels: [], rubricFor, limit: 100, minRandomShare: 1 })
    expect(q.items.map(i => i.itemId).sort()).toEqual(['r1:confirms', 'r2:confirms'])
    expect(q.stats).toMatchObject({ candidates: 2, notApplicable: 2, pending: 2 })
    expect(JSON.stringify(q.items)).not.toContain('no-advice')
  })

  it('does not hand a not-applicable criterion back as undecided when the run errored', () => {
    const workdir = tempDir()
    const suite = saveSuite(workdir, [{ runId: 'broke', status: 'error', error: 'goal check timed out', criteria: { confirms: 'pass', 'no-advice': 'not_applicable' } }])
    const q = buildQueue({ suites: [suite], labels: [], rubricFor, limit: 100, minRandomShare: 1 })
    expect(q.items.map(i => i.itemId)).toEqual(['broke:confirms'])
    expect(q.stats.notApplicable).toBe(1)
    // The criterion the judge never decided at all is still offered, as before.
    const undecided = saveSuite(workdir, [{ runId: 'gone', status: 'error', error: 'judge timed out' }], { suiteId: 'other' })
    const q2 = buildQueue({ suites: [undecided], labels: [], rubricFor, limit: 100, minRandomShare: 0 })
    expect(q2.items.map(i => `${i.itemId}:${i.reason}`).sort()).toEqual(['gone:confirms:targeted-error', 'gone:no-advice:targeted-error'])
  })

  it('treats a not-applicable item as unknown to the labelling flow', () => {
    const workdir = tempDir()
    const suite = saveSuite(workdir, [{ runId: 'r1', criteria: { confirms: 'pass', 'no-advice': 'not_applicable' } }])
    expect(findQueueItem({ suites: [suite], labels: [], rubricFor, minRandomShare: 1 }, 'r1:no-advice')).toEqual({ status: 'unknown' })
    expect(findQueueItem({ suites: [suite], labels: [], rubricFor, minRandomShare: 1 }, 'r1:confirms').status).toBe('ok')
  })

  it('is excluded over the API too: no item, and posting a label for it is refused', async () => {
    const f = await make()
    saveSuite(f.workdir, [{ runId: 'r1', scenario: 'reschedule-tomorrow-3pm', criteria: { 'confirms-before-acting': 'pass', 'no-medical-advice': 'not_applicable' } }], { suiteId: 'suite-1' })
    const q = (await f.api.get('/api/queue?limit=50')).json<QueueResponse>()
    expect(q.items.map(i => i.criterion.id)).not.toContain('no-medical-advice')
    expect(q.stats.notApplicable).toBe(1)
    const refused = await f.api.post('/api/labels', { itemId: 'r1:no-medical-advice', labeler: 'ann', verdict: 'pass', critique: 'Nothing to judge.' })
    expect(refused.status).toBe(404)
    expect(refused.json().error.code).toBe('item_not_found')
    expect((await f.api.get('/api/labels')).json<LabelsResponse>().labels).toEqual([])
  })

  it('reveal of a hand-made label on a not-applicable criterion shows n/a and no agreement', () => {
    const workdir = tempDir()
    const suite = saveSuite(workdir, [{ runId: 'r1', criteria: { confirms: 'pass', 'no-advice': 'not_applicable' } }])
    const find = (id: string) => (id === 'r1' ? { suiteId: 's', result: suite.results[0]! } : null)
    const r = revealItem(label({ id: 'r1:no-advice', verdict: 'pass' }), find)!
    expect(r.judge).toMatchObject({ verdict: 'not_applicable', critique: expect.stringContaining('JUDGE-CRITIQUE') })
    expect(r.agrees).toBeNull()
    expect(revealItem(label({ id: 'r1:confirms', verdict: 'pass' }), find)!.agrees).toBe(true)
  })
})

describe('the overview and run list', () => {
  it('leaves n/a out of failure rates, tallies it apart, and keeps a null-score run out of the average', () => {
    const workdir = tempDir()
    const suite = saveSuite(workdir, [
      { runId: 'a', scenario: 'x', criteria: { confirms: 'fail', 'no-advice': 'not_applicable' } },
      { runId: 'b', scenario: 'y', criteria: { confirms: 'pass', 'no-advice': 'not_applicable' } },
      { runId: 'c', scenario: 'y', criteria: { confirms: 'pass', 'no-advice': 'pass' } },
      { runId: 'd', scenario: 'z', criteria: { confirms: 'not_applicable', 'no-advice': 'not_applicable' } },
    ])
    const o = buildOverview([suite], 1, [])
    // 'no-advice' was graded once (a pass) and not applicable three times. It must not look like 4 passes.
    expect(o.criteria).toEqual([
      { criterion: 'confirms', pass: 2, fail: 1, notApplicable: 1, critical: false },
      { criterion: 'no-advice', pass: 1, fail: 0, notApplicable: 3, critical: false },
    ])
    expect(o.topFailingCriteria).toEqual([{ criterion: 'confirms', failures: 1, judged: 3, notApplicable: 1, failureRate: 1 / 3, scenarios: ['x'], critical: false }])
    // The all-n/a run passes, has no score, and so is not averaged in: (0 + 1 + 1) / 3.
    expect(suite.results[3]!.score).toBeNull()
    expect(suite.summary.avgScore).toBeCloseTo(2 / 3)
    expect(o.trend[0]!.avgScore).toBeCloseTo(2 / 3)
    expect(o.counts).toEqual({ pass: 3, fail: 1, error: 0 })
  })

  it('a criterion that is only ever n/a is tallied but never listed as failing', () => {
    const workdir = tempDir()
    const suite = saveSuite(workdir, [{ runId: 'a', criteria: { confirms: 'pass', 'critical-one': 'not_applicable' } }])
    const o = buildOverview([suite], 1, [])
    expect(o.criteria.find(c => c.criterion === 'critical-one')).toEqual({ criterion: 'critical-one', pass: 0, fail: 0, notApplicable: 1, critical: true })
    expect(o.topFailingCriteria).toEqual([])
  })

  it('run list items list failed and not-applicable criteria apart', () => {
    const r = runResult({ runId: 'a', criteria: { confirms: 'fail', 'no-advice': 'not_applicable', other: 'pass' } })
    expect(failedCriteria(r)).toEqual(['confirms'])
    expect(notApplicableCriteria(r)).toEqual(['no-advice'])
    const item = runListItem('s', r)
    expect(item.failedCriteria).toEqual(['confirms'])
    expect(item.notApplicableCriteria).toEqual(['no-advice'])
    // The live run:end summary carries failures only.
    expect(runEndSummary(r)).not.toHaveProperty('notApplicableCriteria')
  })

  it('serves all of it over the API', async () => {
    const f = await make()
    saveSuite(f.workdir, [
      { runId: 'a', criteria: { confirms: 'pass', 'no-advice': 'not_applicable' } },
      { runId: 'b', criteria: { confirms: 'not_applicable', 'no-advice': 'not_applicable' } },
    ], { suiteId: 's1' })
    const o = (await f.api.get('/api/overview')).json<OverviewResponse>()
    expect(o.criteria).toContainEqual({ criterion: 'confirms', pass: 1, fail: 0, notApplicable: 1, critical: false })
    const runs = (await f.api.get('/api/runs')).json<RunsResponse>()
    expect(runs.runs.find(r => r.runId === 'b')).toMatchObject({ score: null, notApplicableCriteria: ['confirms', 'no-advice'], failedCriteria: [] })
    const one = (await f.api.get('/api/runs/a')).json<RunResponse>()
    expect(one.result.graders[0]!.criteria!.find(c => c.id === 'no-advice')!.verdict).toBe('not_applicable')
  })
})

describe('suites saved before not_applicable existed', () => {
  // A record in the shape written before this change: no not_applicable anywhere, schemaVersion 1.
  const oldRecord = (suiteId: string) => ({
    schemaVersion: 1,
    suiteId,
    startedAt: '2026-10-01T09:00:00.000Z',
    endedAt: '2026-10-01T09:01:00.000Z',
    status: 'complete',
    command: 'evals run ./scenarios',
    configFile: '/c.yaml',
    scenarioPath: '/s',
    results: [
      {
        trace: {
          schemaVersion: 1, runId: 'old-1', scenario: { id: 'old-scenario', version: '1' }, target: { name: 't', kind: 'http', toolCalls: 'reported' },
          turns: [{ index: 0, role: 'user', content: 'Move me to 3pm', at: '2026-10-01T09:00:00.000Z' }, { index: 1, role: 'assistant', content: 'Done.', at: '2026-10-01T09:00:01.000Z' }],
          startedAt: '2026-10-01T09:00:00.000Z', endedAt: '2026-10-01T09:00:02.000Z', usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
          metadata: { frameworkVersion: '0.0.0', models: { judge: { provider: 'anthropic', model: 'claude-opus-5-5' } } },
        },
        graders: [{
          grader: 'rubric-judge(r@1)', status: 'pass', score: 1, reason: 'All 2 criteria passed',
          criteria: [
            { id: 'confirms', verdict: 'pass', critique: 'Never triggered, so no advice was given.', weight: 1, critical: false },
            { id: 'no-advice', verdict: 'pass', critique: 'No clinical topic came up.', weight: 1, critical: true },
          ],
        }],
        status: 'pass', score: 1, goalAchieved: null, costUsd: 0.01, durationMs: 2000, warnings: [],
      },
    ],
    summary: { runs: 1, pass: 1, fail: 0, error: 0, goal: { achieved: 0, total: 0 }, avgScore: 1, costUsd: 0.01, durationMs: 2000, scenarios: ['old-scenario'] },
  })

  it('loads, displays and aggregates unchanged: old passes stay passes, schemaVersion stays 1', async () => {
    const f = await make()
    const dir = storePaths(f.workdir).runs
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'old-suite.json'), JSON.stringify(oldRecord('old-suite'), null, 2))

    const record = readSuite(dir, 'old-suite')!
    expect(record.schemaVersion).toBe(1)
    expect(record.results[0]!.graders[0]!.criteria!.map(c => c.verdict)).toEqual(['pass', 'pass'])
    expect(summarize(record.results)).toMatchObject({ runs: 1, pass: 1, avgScore: 1 })

    const suites = (await f.api.get('/api/suites')).json<SuitesResponse>()
    expect(suites.warnings).toEqual([])
    expect(suites.suites.map(s => s.suiteId)).toEqual(['old-suite'])
    const o = (await f.api.get('/api/overview')).json<OverviewResponse>()
    expect(o.warnings).toEqual([])
    expect(o.criteria).toEqual([
      { criterion: 'confirms', pass: 1, fail: 0, notApplicable: 0, critical: false },
      { criterion: 'no-advice', pass: 1, fail: 0, notApplicable: 0, critical: true },
    ])
    expect(o.counts).toEqual({ pass: 1, fail: 0, error: 0 })
    const runs = (await f.api.get('/api/runs')).json<RunsResponse>()
    expect(runs.runs[0]).toMatchObject({ runId: 'old-1', score: 1, failedCriteria: [], notApplicableCriteria: [] })
    const run = (await f.api.get('/api/runs/old-1')).json<RunResponse>()
    expect(run.result.graders[0]!.criteria).toHaveLength(2)
    const q = (await f.api.get('/api/queue?limit=50')).json<QueueResponse>()
    expect(q.stats).toMatchObject({ candidates: 2, notApplicable: 0 })
  })

  it('a record that contains not_applicable verdicts loads under the same schemaVersion', async () => {
    const f = await make()
    const dir = storePaths(f.workdir).runs
    mkdirSync(dir, { recursive: true })
    const rec = oldRecord('new-suite')
    rec.results[0]!.graders[0]!.criteria![1]!.verdict = 'not_applicable'
    writeFileSync(join(dir, 'new-suite.json'), JSON.stringify(rec))
    const run = (await f.api.get('/api/runs/old-1')).json<RunResponse>()
    expect(run.result.graders[0]!.criteria![1]!.verdict).toBe('not_applicable')
    expect((await f.api.get('/api/suites')).json<SuitesResponse>().warnings).toEqual([])
  })
})

describe('the demo data', () => {
  it('shows n/a verdicts, an all-n/a run with no score and its warning, and keeps them out of the queue', async () => {
    const { runs, suites, labels } = await seedDemo(tempDir('evals-demo-na-'), 'http://127.0.0.1:4010', new Date('2026-11-13T12:00:00.000Z'))
    const criteria = runs.flatMap(r => r.graders.flatMap(g => g.criteria ?? []))
    const na = criteria.filter(c => c.verdict === 'not_applicable')
    expect(na.length).toBeGreaterThan(5)
    // The two cases the owner called out.
    expect(criteria.some(c => c.id === 'no-medical-advice' && c.verdict === 'not_applicable' && /clinical/i.test(c.critique))).toBe(true)
    expect(criteria.some(c => c.id === 'confirms-before-acting' && c.verdict === 'not_applicable')).toBe(true)
    // Every n/a critique says why.
    for (const c of na) expect(c.critique.length, c.id).toBeGreaterThan(20)

    const allNa = runs.filter(r => r.graders.some(g => g.criteria && g.criteria.length > 0 && g.criteria.every(c => c.verdict === 'not_applicable')))
    expect(allNa.length).toBeGreaterThanOrEqual(1)
    for (const r of allNa) {
      expect(r.score).toBeNull()
      expect(r.status).toBe('pass')
      expect(r.warnings).toContain(NO_CRITERION_APPLIED_WARNING)
    }
    // Nothing that failed was hidden behind n/a: runs that fail on a criterion still say so.
    expect(runs.some(r => failedCriteria(r).length > 0)).toBe(true)

    const queue = buildQueue({ suites, labels: [], limit: 1000, minRandomShare: 1 })
    const naIds = new Set(runs.flatMap(r => r.graders.flatMap(g => (g.criteria ?? []).filter(c => c.verdict === 'not_applicable').map(c => `${r.trace.runId}:${c.id}`))))
    expect(queue.items.filter(i => naIds.has(i.itemId))).toEqual([])
    expect(queue.stats.notApplicable).toBe(naIds.size)
    expect(labels.filter(l => naIds.has(l.id))).toEqual([])
  })
})
