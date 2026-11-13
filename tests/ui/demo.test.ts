import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEMO_DIR, seedDemo } from '../../scripts/seed-demo.js'
import { startUiServer, type UiServer } from '../../src/server/index.js'
import type {
  CalibrationResponse, HealthResponse, LabelsResponse, OverviewResponse, QueueResponse, RunPreviewResponse, RunsResponse, ScenariosResponse,
} from '../../src/ui/api-types.js'
import { client, tempDir, type Client } from './harness.js'

// The demo workdir is what `npm run ui:demo` shows. These tests seed it into a temp
// directory and use the real server, so the demo cannot rot unnoticed.

let ui: UiServer | undefined
afterEach(async () => {
  await ui?.close()
  ui = undefined
})

async function demo(): Promise<{ dir: string; api: Client }> {
  const dir = tempDir('evals-demo-')
  await seedDemo(dir, 'http://127.0.0.1:4010', new Date('2026-11-13T12:00:00.000Z'))
  ui = await startUiServer({
    workdir: dir,
    configFile: join(dir, 'evals.config.yaml'),
    scenarioPath: join(dir, 'scenarios'),
    port: 0,
    demo: true,
    env: {},
    createProvider() {
      throw new Error('Demo mode never calls a model.')
    },
  })
  return { dir, api: client(ui) }
}

describe('demo data', () => {
  it('reports demo mode in the health response, and a normal server does not', async () => {
    const { api } = await demo()
    expect((await api.get('/api/health')).json<HealthResponse>().demo).toBe(true)

    const plain = await startUiServer({ workdir: tempDir('evals-plain-'), port: 0, env: {} })
    try {
      expect((await client(plain).get('/api/health')).json<HealthResponse>().demo).toBe(false)
    } finally {
      await plain.close()
    }
  })

  it('has about 25 runs over several suites with passes, failures and errors, one unknown cost and skipped checks', async () => {
    const { api } = await demo()
    const overview = (await api.get('/api/overview')).json<OverviewResponse>()
    expect(overview.runs).toBeGreaterThanOrEqual(24)
    expect(overview.runs).toBeLessThanOrEqual(30)
    expect(overview.suites.total).toBeGreaterThanOrEqual(5)
    expect(overview.counts.pass).toBeGreaterThan(5)
    expect(overview.counts.fail).toBeGreaterThan(3)
    expect(overview.counts.error).toBeGreaterThanOrEqual(2)
    expect(overview.cost.totalUsd).toBeNull()
    expect(overview.cost.runsWithUnknownCost).toBeGreaterThanOrEqual(1)
    expect(overview.goal.rate).not.toBeNull()
    expect(overview.trend.length).toBe(overview.suites.total)
    expect(overview.failuresByTag.length).toBeGreaterThan(2)
    expect(overview.topFailingCriteria.length).toBeGreaterThan(0)
    expect(overview.topFailingChecks.length).toBeGreaterThan(0)
    expect(overview.warnings).toEqual([])

    const runs = (await api.get('/api/runs?limit=100')).json<RunsResponse>()
    expect(runs.runs.some(r => r.costUsd === null)).toBe(true)
    expect(runs.runs.some(r => r.error)).toBe(true)
    const suiteIds = new Set(runs.runs.map(r => r.suiteId))
    expect(suiteIds.size).toBeGreaterThanOrEqual(5)

    // A skipped check, a tool call, a critique and a defect run are all in there.
    const results = await Promise.all(runs.runs.map(async r => (await api.get(`/api/runs/${encodeURIComponent(r.runId)}`)).json().result))
    expect(results.some(r => r.graders.some((g: { status: string }) => g.status === 'skipped'))).toBe(true)
    expect(results.some(r => r.trace.turns.some((t: { toolCalls?: unknown[] }) => (t.toolCalls?.length ?? 0) > 0))).toBe(true)
    expect(results.some(r => r.graders.some((g: { criteria?: { critique: string }[] }) => g.criteria?.some(c => c.critique.includes('[1]'))))).toBe(true)
    expect(results.some(r => r.status === 'fail' && r.graders.some((g: { grader: string; status: string }) => g.grader.startsWith('must_not_call') && g.status === 'fail'))).toBe(true)
  })

  it('has labels with a mix of random and targeted, a queue to work through, and a saved calibration', async () => {
    const { api } = await demo()
    const labels = (await api.get('/api/labels')).json<LabelsResponse>()
    expect(labels.labels.length).toBeGreaterThan(40)
    expect(labels.stats.random).toBeGreaterThan(0)
    expect(labels.stats.targeted).toBeGreaterThan(0)
    expect(labels.stats.randomShare).toBeGreaterThanOrEqual(labels.stats.minRandomShare)
    expect(labels.stats.byVerdict.pass).toBeGreaterThan(0)
    expect(labels.stats.byVerdict.fail).toBeGreaterThan(0)
    expect(labels.stats.labelers.length).toBeGreaterThan(1)

    const queue = (await api.get('/api/queue?limit=25')).json<QueueResponse>()
    expect(queue.items.length).toBeGreaterThanOrEqual(5)
    // Blind: the stored judge critiques are nowhere in the queue.
    expect(JSON.stringify(queue)).not.toContain('"critique"')
    expect(JSON.stringify(queue)).not.toContain('"verdict"')

    const cal = (await api.get('/api/calibration')).json<CalibrationResponse>()
    expect(cal.latest).not.toBeNull()
    const m = cal.latest!.report.metrics
    expect(m.tnr.n).toBeGreaterThan(0)
    expect(m.tpr.n).toBeGreaterThan(0)
    expect(m.insufficient).toBe(true) // honest: the demo sample is small, so the warnings show
    expect(cal.latest!.report.disagreements.length).toBeGreaterThan(0)
    expect(cal.latest!.report.errors.length).toBeGreaterThan(0)
    expect(cal.latest!.report.warnings.length).toBeGreaterThan(0)
  })

  it('labels made from the queue can be revealed, and the queue item matches its label', async () => {
    const { api } = await demo()
    const labels = (await api.get('/api/labels')).json<LabelsResponse>().labels
    const fromRun = labels.find(l => l.id.startsWith('demo-r'))!
    const reveal = (await api.get(`/api/labels/${encodeURIComponent(fromRun.id)}/reveal`)).json()
    expect(reveal.judge).not.toBeNull()
    expect(reveal.human.verdict).toBe(fromRun.verdict)
    // A hand-written label is not tied to a run.
    const standalone = labels.find(l => l.id.startsWith('demo-standalone'))!
    expect((await api.get(`/api/labels/${encodeURIComponent(standalone.id)}/reveal`)).status).toBe(404)
  })

  it('lists scenarios and rubrics with no validation errors', async () => {
    const { api } = await demo()
    const s = (await api.get('/api/scenarios')).json<ScenariosResponse>()
    expect(s.scenarios.length).toBe(9)
    expect(s.validation.errors).toEqual([])
    expect(s.scenarios.some(x => !x.needsModel)).toBe(true)
    const r = (await api.get('/api/rubrics')).json()
    expect(r.rubrics.map((x: { rubric: { id: string } }) => x.rubric.id).sort()).toEqual(['intake', 'scheduling'])
    expect(r.problems).toEqual([])
  })

  it('cannot spend: a plan that calls a model is refused at start, and a checks-only plan still runs', async () => {
    const { api } = await demo()
    const body = { only: ['reschedule-tomorrow-3pm'] }
    const preview = (await api.post('/api/run/preview', body)).json<RunPreviewResponse>()
    expect(preview.preview.anyModelCalls).toBe(true)
    const start = await api.post('/api/run/start', { ...body, previewToken: preview.previewToken, confirm: true })
    expect(start.status).toBe(503)
    expect(start.json().error.code).toBe('provider_unavailable')

    const det = (await api.post('/api/run/preview', { only: ['reschedule-asks-before-acting'] })).json<RunPreviewResponse>()
    expect(det.preview.anyModelCalls).toBe(false)
  })

  it('is all synthetic: marked as demo data, no em-dashes, no secret-looking text', async () => {
    const { dir } = await demo()
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap(n => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]))
    const files = walk(dir)
    expect(files.length).toBeGreaterThan(20)
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      expect(text, f).not.toContain('—')
      expect(text, f).not.toMatch(/sk-ant|sk-[A-Za-z0-9]{20}|@[a-z0-9-]+\.(com|org|net)/i)
    }
    expect(readFileSync(join(dir, '.evals', 'labels.jsonl'), 'utf8')).toContain('Synthetic demo label')
    expect(DEMO_DIR.endsWith('.evals-demo')).toBe(true)
  })

  it('refuses to clear a directory it did not make', async () => {
    const dir = tempDir('evals-demo-foreign-')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'precious.txt'), 'keep me')
    await expect(seedDemo(dir, 'http://127.0.0.1:4010')).rejects.toThrow(/was not made by the demo seeder/)
    expect(readFileSync(join(dir, 'precious.txt'), 'utf8')).toBe('keep me')
  })
})
