import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { partition } from '../../src/index.js'
import type { CalibratePreviewResponse, CalibrationResponse, CalibrateStartResponse } from '../../src/ui/api-types.js'
import { syntheticLabels } from '../label-helpers.js'
import { labelJudgeProvider, rubricYaml, toJsonl } from '../cli/harness.js'
import { fixture, type Fixture } from './harness.js'

const fixtures: Fixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(f => f.stop()))
})

const labels = syntheticLabels(400)
const { dev } = partition(labels)
const randomInDev = dev.filter(l => l.sampled_by === 'random').length

const SCENARIO = 'id: s\nversion: 1\ntarget: stub-agent\nseed_message: hi\nchecks:\n  - type: must_not_call\n    tool: x\n'

async function calibrationFixture(opts: { provider?: ReturnType<typeof labelJudgeProvider>; rubric?: string; labelText?: string } = {}) {
  const provider = opts.provider ?? labelJudgeProvider('agree')
  const f = await fixture({ provider, ownScenarios: true, files: { 's.yaml': SCENARIO, 'rubrics/calib.yaml': opts.rubric ?? rubricYaml() } })
  fixtures.push(f)
  const file = join(f.workdir, '.evals', 'labels.jsonl')
  mkdirSync(join(f.workdir, '.evals'), { recursive: true })
  writeFileSync(file, opts.labelText ?? toJsonl(labels))
  return { f, provider }
}

const req = { rubricId: 'calib', split: 'dev' as const }

describe('calibration through the API', () => {
  it('previews the exact number of judge calls and issues a token', async () => {
    const { f, provider } = await calibrationFixture()
    const r = await f.api.post('/api/calibrate/preview', req)
    expect(r.status).toBe(200)
    const body = r.json<CalibratePreviewResponse>()
    expect(body.preview).toMatchObject({
      kind: 'calibrate',
      judgements: { count: randomInDev, split: 'dev', selection: 'random' },
      calls: { judge: randomInDev, total: randomInDev, simulator: 0 },
      cap: null,
      anyModelCalls: true,
      models: { judge: { model: 'claude-opus-5-5', effort: 'high' } },
    })
    expect(body.lines.join('\n')).toMatch(new RegExp(`Judgements: ${randomInDev} \\(random labels in the dev split\\), one judge call each`))
    expect(body.contamination).toBeNull()
    expect(body.labelsFile).toBe(join(f.workdir, '.evals', 'labels.jsonl'))
    expect(provider.calls).toHaveLength(0)
    const all = (await f.api.post('/api/calibrate/preview', { ...req, split: 'test', selection: 'all' })).json<CalibratePreviewResponse>()
    expect(all.preview.judgements!.count).toBe(partition(labels).test.length)
  })

  it('refuses to start without a valid token and confirm, with no calls made', async () => {
    const { f, provider } = await calibrationFixture()
    expect((await f.api.post('/api/calibrate/start', req)).status).toBe(428)
    const { previewToken } = (await f.api.post('/api/calibrate/preview', req)).json<CalibratePreviewResponse>()
    expect((await f.api.post('/api/calibrate/start', { ...req, previewToken })).status).toBe(428)
    expect((await f.api.post('/api/calibrate/start', { ...req, previewToken: 'x.y', confirm: true })).status).toBe(412)
    // A token for another split or selection is a different plan.
    expect((await f.api.post('/api/calibrate/start', { ...req, split: 'test', previewToken, confirm: true })).status).toBe(412)
    expect((await f.api.post('/api/calibrate/start', { ...req, selection: 'all', previewToken, confirm: true })).status).toBe(412)
    expect(provider.calls).toHaveLength(0)
  })

  it('refuses a token once the labels changed (the judgement count would no longer be the one shown)', async () => {
    const { f, provider } = await calibrationFixture()
    const { previewToken } = (await f.api.post('/api/calibrate/preview', req)).json<CalibratePreviewResponse>()
    writeFileSync(join(f.workdir, '.evals', 'labels.jsonl'), toJsonl(syntheticLabels(300)))
    const r = await f.api.post('/api/calibrate/start', { ...req, previewToken, confirm: true })
    expect(r.status).toBe(412)
    expect(provider.calls).toHaveLength(0)
  })

  it('measures the judge with the fake provider, returns the report and saves it', async () => {
    const { f, provider } = await calibrationFixture()
    expect((await f.api.get('/api/calibration')).json<CalibrationResponse>()).toEqual({ latest: null })
    const { previewToken } = (await f.api.post('/api/calibrate/preview', req)).json<CalibratePreviewResponse>()
    const r = await f.api.post('/api/calibrate/start', { ...req, previewToken, confirm: true })
    expect(r.status).toBe(200)
    const { record } = r.json<CalibrateStartResponse>()
    expect(provider.calls).toHaveLength(randomInDev)
    expect(provider.calls[0]).toMatchObject({ role: 'judge', effort: 'high', timeoutMs: 180_000 })
    expect(record).toMatchObject({ schemaVersion: 1, rubricId: 'calib', rubricVersion: '1', split: 'dev', selection: 'random', command: 'evals ui', labelsFile: join(f.workdir, '.evals', 'labels.jsonl') })
    expect(record.report.judge).toBe('rubric-judge(calib@1)')
    expect(record.report.metrics.tnr).toMatchObject({ rate: 1 })
    expect(record.report.metrics.tpr).toMatchObject({ rate: 1 })
    expect(record.report.errors).toEqual([])
    expect(record.report.usage.costUsd).toBe(0)

    const latest = (await f.api.get('/api/calibration')).json<CalibrationResponse>()
    expect(latest.latest).toEqual(record)
    // Another run replaces it as the latest.
    const again = await f.api.post('/api/calibrate/start', { ...req, previewToken, confirm: true })
    expect(again.status).toBe(200)
    expect((await f.api.get('/api/calibration')).json<CalibrationResponse>().latest!.calibrationId).toBe(again.json().record.calibrationId)
    // And nothing is running afterwards.
    expect((await f.api.get('/api/run/status')).json().activeJob).toBeNull()
  })

  it('measures the current labels, reports the blind ones too, and needs a new preview after a revision', async () => {
    // The fake judge agrees with every blind label. Four random dev labels are then changed to the opposite verdict.
    const changed = dev.filter(l => l.sampled_by === 'random').slice(0, 4)
    const revisions = changed.map(l => ({ ...l, id: `${l.id}~r1`, replaces: l.id, verdict: l.verdict === 'pass' ? 'fail' as const : 'pass' as const, critique: 'Changed after the reveal.' }))
    const { f, provider } = await calibrationFixture({ labelText: toJsonl([...labels, ...revisions]) })
    const preview = (await f.api.post('/api/calibrate/preview', req)).json<CalibratePreviewResponse>()
    // One judgement per item, never one per line.
    expect(preview.preview.judgements!.count).toBe(randomInDev)
    const { record } = (await f.api.post('/api/calibrate/start', { ...req, previewToken: preview.previewToken, confirm: true })).json<CalibrateStartResponse>()
    expect(provider.calls).toHaveLength(randomInDev)
    const r = record.report
    expect(r.metrics.n).toBe(randomInDev)
    expect(r.disagreements.map(d => d.id).sort()).toEqual(changed.map(l => l.id).sort())
    expect(r.metrics.accuracy).toBeCloseTo((randomInDev - 4) / randomInDev)
    expect(r.revisions).toMatchObject({ revised: 4, verdictChanged: 4 })
    expect(r.revisions!.blindMetrics!.accuracy).toBe(1)

    // A further revision changes the current labels, so the old token no longer covers the plan.
    const { previewToken } = (await f.api.post('/api/calibrate/preview', req)).json<CalibratePreviewResponse>()
    const again = { ...revisions[0]!, id: `${changed[0]!.id}~r2`, replaces: `${changed[0]!.id}~r1`, verdict: changed[0]!.verdict }
    writeFileSync(join(f.workdir, '.evals', 'labels.jsonl'), toJsonl([...labels, ...revisions, again]))
    expect((await f.api.post('/api/calibrate/start', { ...req, previewToken, confirm: true })).status).toBe(412)
  })

  it('refuses a label file with a broken replace chain', async () => {
    const orphan = { ...dev[0]!, id: 'missing~r1', replaces: 'missing' }
    const { f, provider } = await calibrationFixture({ labelText: toJsonl([...labels, orphan]) })
    const r = await f.api.post('/api/calibrate/preview', req)
    expect(r.status).toBe(422)
    expect(r.json().error).toMatchObject({ code: 'corrupt_record', message: expect.stringMatching(/replaces "missing", which is not in the file/) })
    expect(provider.calls).toHaveLength(0)
  })

  it('reports a judge that disagrees, without failing', async () => {
    const { f } = await calibrationFixture({ provider: labelJudgeProvider('always-pass') })
    const { previewToken } = (await f.api.post('/api/calibrate/preview', req)).json<CalibratePreviewResponse>()
    const { record } = (await f.api.post('/api/calibrate/start', { ...req, previewToken, confirm: true })).json<CalibrateStartResponse>()
    expect(record.report.metrics.tnr.rate).toBe(0)
    expect(record.report.disagreements.length).toBeGreaterThan(0)
  })

  it('refuses a contaminated judge before any spend, in the preview and at start', async () => {
    const devLabel = dev[0]!
    const rubric = rubricYaml(`anchors:\n  - criterion: confirms\n    input: ${JSON.stringify(devLabel.input)}\n    output: ${JSON.stringify(devLabel.output)}\n    verdict: pass\n    critique: Copied from a dev label.\n`)
    const { f, provider } = await calibrationFixture({ rubric })
    const preview = (await f.api.post('/api/calibrate/preview', req)).json<CalibratePreviewResponse>()
    expect(preview.contamination).toMatch(new RegExp(`${devLabel.id} \\(dev\\)`))
    const r = await f.api.post('/api/calibrate/start', { ...req, previewToken: preview.previewToken, confirm: true })
    expect(r.status).toBe(409)
    expect(r.json().error.code).toBe('contamination')
    expect(provider.calls).toHaveLength(0)
    expect((await f.api.get('/api/calibration')).json().latest).toBeNull()
  })

  it('rejects the train split, an unknown rubric, a missing label file and a broken one', async () => {
    const { f } = await calibrationFixture()
    expect((await f.api.post('/api/calibrate/preview', { ...req, split: 'train' })).status).toBe(400)
    expect((await f.api.post('/api/calibrate/preview', { ...req, selection: 'some' })).status).toBe(400)
    const unknown = await f.api.post('/api/calibrate/preview', { ...req, rubricId: 'nope' })
    expect(unknown.status).toBe(422)
    expect(unknown.json().error.message).toMatch(/No rubric "nope". Known: calib/)
    // No label file: nothing to judge, so no model call and no key is needed.
    const none = await calibrationFixture({ labelText: '' })
    const preview = (await none.f.api.post('/api/calibrate/preview', req)).json<CalibratePreviewResponse>()
    expect(preview.preview).toMatchObject({ anyModelCalls: false, judgements: { count: 0 } })
    const run = await none.f.api.post('/api/calibrate/start', req)
    expect(run.status).toBe(200)
    expect(run.json().record.report.metrics.n).toBe(0)
    expect(none.provider.calls).toHaveLength(0)
    // A label file that does not parse.
    writeFileSync(join(f.workdir, '.evals', 'labels.jsonl'), 'nope\n')
    expect((await f.api.post('/api/calibrate/preview', req)).json().error.code).toBe('corrupt_record')
  })
})
