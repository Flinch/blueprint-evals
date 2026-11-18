import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeProvider, type FakeReply, type Label } from '../../src/index.js'
import type { FindingsResponse, FindingsSummaryPreviewResponse, FindingsSummaryResponse } from '../../src/ui/api-types.js'
import { label } from '../label-helpers.js'
import { toJsonl } from '../cli/harness.js'
import { fixture, type Fixture, type FixtureOptions } from './harness.js'
import { saveSuite } from './records.js'

// GET /api/findings, GET /api/findings.md and the AI draft behind the
// preview-and-confirm protocol. Always the fake provider.

const fixtures: Fixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(f => f.stop()))
})

const RUBRIC = `id: r1
version: 3
criteria:
  - id: alpha
    text: Answers the question that was asked.
  - id: beta
    text: Keeps a calm tone.
  - id: gamma
    text: Never gives a diagnosis.
    critical: true
`
const SCENARIO = 'id: s1\nversion: 1\ntarget: stub-agent\nseed_message: hi\nrubric: rubrics/r1.yaml\n'

const lab = (runId: string, criterion: string, verdict: 'pass' | 'fail', over: Partial<Label> = {}): Label =>
  label({
    id: `${runId}:${criterion}`,
    group: runId,
    criterion,
    input: `Question for ${runId}`,
    output: `Answer for ${runId}`,
    verdict,
    critique: `CRITIQUE ${runId}/${criterion}`,
    labeler: 'ann',
    at: '2026-11-13T09:00:00.000Z',
    ...over,
  })

/**
 * Two suites: run-a and run-b on Nov 10, run-c and run-d on Nov 12.
 * Labelled: alpha fails on a, b, c (passes on d); beta fails on c; gamma fails on b and passes on a.
 * The judge also failed beta on run-d, which nobody labelled.
 */
const LABELS: Label[] = [
  lab('run-a', 'alpha', 'fail'),
  lab('run-b', 'alpha', 'pass'),
  lab('run-b', 'alpha', 'fail', { id: 'run-b:alpha~r1', replaces: 'run-b:alpha', critique: 'CRITIQUE revised', labeler: 'bo', at: '2026-11-14T09:00:00.000Z' }),
  lab('run-c', 'alpha', 'fail'),
  lab('run-d', 'alpha', 'pass'),
  lab('run-c', 'beta', 'fail'),
  lab('run-b', 'gamma', 'fail'),
  lab('run-a', 'gamma', 'pass'),
  label({ id: 'hand-written-1', criterion: 'alpha', verdict: 'fail', critique: 'Not from a run.' }),
]

async function seeded(options: FixtureOptions = {}, labels: Label[] = LABELS) {
  const f = await fixture({ ownScenarios: true, files: { 's1.yaml': SCENARIO, 'rubrics/r1.yaml': RUBRIC }, ...options })
  fixtures.push(f)
  saveSuite(f.workdir, [
    { runId: 'run-a', scenario: 's1', startedAt: '2026-11-10T10:00:00.000Z', criteria: { alpha: 'fail', beta: 'pass', gamma: 'pass' } },
    { runId: 'run-b', scenario: 's1', startedAt: '2026-11-10T10:05:00.000Z', criteria: { alpha: 'pass', beta: 'pass', gamma: 'fail' } },
  ], { suiteId: 'suite-1', startedAt: '2026-11-10T10:00:00.000Z' })
  saveSuite(f.workdir, [
    { runId: 'run-c', scenario: 's1', startedAt: '2026-11-12T10:00:00.000Z', criteria: { alpha: 'fail', beta: 'fail', gamma: 'pass' } },
    { runId: 'run-d', scenario: 's1', startedAt: '2026-11-12T10:05:00.000Z', criteria: { alpha: 'pass', beta: 'fail', gamma: 'pass' } },
  ], { suiteId: 'suite-2', startedAt: '2026-11-12T10:00:00.000Z' })
  writeLabels(f, labels)
  return f
}

function writeLabels(f: Fixture, labels: Label[]) {
  mkdirSync(join(f.workdir, '.evals'), { recursive: true })
  writeFileSync(join(f.workdir, '.evals', 'labels.jsonl'), toJsonl(labels))
}

const findings = async (f: Fixture, query = '') => {
  const r = await f.api.get(`/api/findings${query}`)
  expect(r.status, r.text).toBe(200)
  return r.json<FindingsResponse>()
}

describe('GET /api/findings', () => {
  it('groups the current fail labels by criterion, critical first, then by the number of failures', async () => {
    const f = await seeded()
    const body = await findings(f)
    expect(body.criteria.map(c => [c.criterion, c.critical, c.failed, c.labelled])).toEqual([
      ['gamma', true, 1, 2],
      ['alpha', false, 3, 4],
      ['beta', false, 1, 1],
    ])
    expect(body.totals).toEqual({ failed: 5, labelled: 7 })
    const alpha = body.criteria[1]!
    expect(alpha).toMatchObject({ text: 'Answers the question that was asked.', rubricId: 'r1', rubricVersion: '3' })
    // Newest run first.
    expect(alpha.findings.map(x => x.itemId)).toEqual(['run-c:alpha', 'run-b:alpha', 'run-a:alpha'])
    expect(alpha.findings[0]).toEqual({
      itemId: 'run-c:alpha', suiteId: 'suite-2', runId: 'run-c', startedAt: expect.stringMatching(/^2026-/), scenarioId: 's1',
      userMessage: 'Question for run-c', output: 'Answer for run-c', critique: 'CRITIQUE run-c/alpha', labeler: 'ann', labelledAt: '2026-11-13T09:00:00.000Z', revised: false,
    })
  })

  it('uses the latest version of a revised label and marks it revised', async () => {
    const f = await seeded()
    const b = (await findings(f)).criteria.find(c => c.criterion === 'alpha')!.findings.find(x => x.itemId === 'run-b:alpha')!
    expect(b).toMatchObject({ critique: 'CRITIQUE revised', labeler: 'bo', revised: true, labelledAt: '2026-11-14T09:00:00.000Z' })
  })

  it('counts the judge failures nobody has reviewed and the labels that are not from a saved run, and lists neither', async () => {
    const f = await seeded()
    const body = await findings(f)
    // The judge failed alpha on a and c, gamma on b, and beta on c and d. Only beta on d has no label.
    expect(body.unreviewedJudgeFailures).toBe(1)
    expect(body.notFromSavedRun).toBe(1)
    expect(JSON.stringify(body)).not.toContain('Not from a run.')
    // It is a pure read: no model, and nothing about the judge's critiques.
    expect(f.provider.calls).toHaveLength(0)
    expect(JSON.stringify(body)).not.toContain('JUDGE-CRITIQUE')
  })

  it('filters by run start time, rubric and criterion, and the counts follow the filter', async () => {
    const f = await seeded()
    const since = await findings(f, '?since=2026-11-11')
    expect(since.filters).toEqual({ since: '2026-11-11T00:00:00.000Z' })
    expect(since.criteria.map(c => [c.criterion, c.failed, c.labelled])).toEqual([['alpha', 1, 2], ['beta', 1, 1]])
    expect(since.unreviewedJudgeFailures).toBe(1)

    const one = await findings(f, '?criterion=gamma&rubric=r1')
    expect(one.criteria.map(c => c.criterion)).toEqual(['gamma'])
    expect(one.totals).toEqual({ failed: 1, labelled: 2 })
    expect(one.unreviewedJudgeFailures).toBe(0)

    const none = await findings(f, '?rubric=other')
    expect(none.criteria).toEqual([])
    expect(none.totals).toEqual({ failed: 0, labelled: 0 })

    const bad = await f.api.get('/api/findings?since=yesterday-ish')
    expect(bad.status).toBe(400)
    expect(bad.json().error.code).toBe('bad_request')
  })

  it('is empty, with no draft, when there are no labels or runs', async () => {
    const f = await fixture({ ownScenarios: true, files: { 's1.yaml': SCENARIO, 'rubrics/r1.yaml': RUBRIC } })
    fixtures.push(f)
    const body = await findings(f)
    expect(body).toMatchObject({ criteria: [], totals: { failed: 0, labelled: 0 }, unreviewedJudgeFailures: 0, notFromSavedRun: 0, summary: null })
  })
})

describe('GET /api/findings.md', () => {
  it('returns Markdown with a download name: title, filters, summary table, then a section per criterion', async () => {
    const f = await seeded()
    const r = await f.api.get('/api/findings.md?since=2026-11-01')
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('text/markdown; charset=utf-8')
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="findings-\d{4}-\d{2}-\d{2}\.md"$/)
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    const md = r.text
    expect(md.startsWith('# Findings report\n')).toBe(true)
    expect(md).toContain('Filters: runs since 2026-11-01 00:00 UTC, every rubric, every criterion.')
    expect(md).toContain('1 failure found by the judge has not been reviewed by a person yet')
    expect(md).toContain('| Criterion | Critical | Failed / labelled |')
    expect(md).toContain('| gamma | yes | 1 / 2 |')
    expect(md).toContain('| alpha | no | 3 / 4 |')
    expect(md.indexOf('## gamma (critical)')).toBeLessThan(md.indexOf('## alpha'))
    expect(md).toContain('**Rule.** Answers the question that was asked.')
    expect(md).toContain('Rubric r1, version 3.')
    expect(md).toContain('**User message**\n\n> Question for run-c')
    expect(md).toContain('**Assistant reply**\n\n> Answer for run-c')
    expect(md).toContain('**Critique.** CRITIQUE run-c/alpha')
    expect(md).toContain('revised after the first label')
    expect(md).not.toContain('Suggested fixes')
    expect(md).not.toContain('—')
  })
})

// --------------------------------------------------------------- the AI draft

const DRAFT: FakeReply = {
  json: {
    fixes: [
      { criterion: 'alpha', pattern: 'It answers a different question.', proposedChange: 'Restate the question before answering.', itemIds: ['run-a:alpha', 'run-c:alpha', 'made-up:id'] },
      { criterion: 'unknown-rule', pattern: 'x', proposedChange: 'y', itemIds: [] },
    ],
  },
}

describe('POST /api/findings/summary (preview and confirm)', () => {
  it('previews the count, the judge model and an estimated cost, with no model call', async () => {
    const provider = createFakeProvider(DRAFT)
    const f = await seeded({ provider })
    const r = await f.api.post('/api/findings/summary/preview', { since: '2026-11-01' })
    expect(r.status, r.text).toBe(200)
    const body = r.json<FindingsSummaryPreviewResponse>()
    expect(body).toMatchObject({
      filters: { since: '2026-11-01T00:00:00.000Z' },
      findings: 5,
      findingsInPrompt: 5,
      criteria: 3,
      model: { model: 'claude-opus-5-5', effort: 'high', priced: true },
      maxOutputTokens: 16_000,
      anyModelCalls: true,
      warnings: [],
    })
    expect(body.estimatedInputTokens).toBeGreaterThan(100)
    expect(body.estimatedCostUsd).toBeCloseTo((body.estimatedInputTokens * 4 + 16_000 * 20) / 1_000_000, 10)
    expect(body.previewToken).toMatch(/^\d+\.[0-9a-f]{64}$/)
    expect(provider.calls).toHaveLength(0)
  })

  it('refuses without confirm and a token, with a wrong token, and with a token for other filters', async () => {
    const provider = createFakeProvider(DRAFT)
    const f = await seeded({ provider })
    expect((await f.api.post('/api/findings/summary', {})).status).toBe(428)
    const { previewToken } = (await f.api.post('/api/findings/summary/preview', {})).json<FindingsSummaryPreviewResponse>()
    expect((await f.api.post('/api/findings/summary', { previewToken })).status).toBe(428)
    expect((await f.api.post('/api/findings/summary', { previewToken: 'x.y', confirm: true })).status).toBe(412)
    const other = await f.api.post('/api/findings/summary', { criterion: 'alpha', previewToken, confirm: true })
    expect(other.status).toBe(412)
    expect(other.json().error.code).toBe('preview_token_invalid')
    expect(provider.calls).toHaveLength(0)
  })

  it('refuses a token once the findings changed, so what runs is what was previewed', async () => {
    const provider = createFakeProvider(DRAFT)
    const f = await seeded({ provider })
    const { previewToken } = (await f.api.post('/api/findings/summary/preview', {})).json<FindingsSummaryPreviewResponse>()
    writeLabels(f, [...LABELS, lab('run-d', 'gamma', 'fail')])
    const r = await f.api.post('/api/findings/summary', { previewToken, confirm: true })
    expect(r.status).toBe(412)
    expect(provider.calls).toHaveLength(0)
    expect(existsSync(join(f.workdir, '.evals', 'findings'))).toBe(false)
  })

  it('says when the provider cannot be created (no key), like calibration, and spends nothing', async () => {
    const f = await seeded({ server: { createProvider: () => { throw new Error('ANTHROPIC_API_KEY is not set') } } })
    const { previewToken } = (await f.api.post('/api/findings/summary/preview', {})).json<FindingsSummaryPreviewResponse>()
    const r = await f.api.post('/api/findings/summary', { previewToken, confirm: true })
    expect(r.status).toBe(503)
    expect(r.json().error.code).toBe('provider_unavailable')
    expect(r.json().error.message).toMatch(/ANTHROPIC_API_KEY is not set/)
  })

  it('turns a failed model call into 502 provider_error and saves nothing', async () => {
    const provider = createFakeProvider({ error: 'Anthropic rejected the credentials (401). Check ANTHROPIC_API_KEY.' })
    const f = await seeded({ provider })
    const { previewToken } = (await f.api.post('/api/findings/summary/preview', {})).json<FindingsSummaryPreviewResponse>()
    const r = await f.api.post('/api/findings/summary', { previewToken, confirm: true })
    expect(r.status).toBe(502)
    expect(r.json().error).toMatchObject({ code: 'provider_error', message: expect.stringMatching(/rejected the credentials.*Nothing was saved/) })
    expect(existsSync(join(f.workdir, '.evals', 'findings'))).toBe(false)
  })

  it('refuses to summarise an empty report, before asking for a token', async () => {
    const f = await seeded({ provider: createFakeProvider(DRAFT) })
    const preview = (await f.api.post('/api/findings/summary/preview', { rubric: 'other' })).json<FindingsSummaryPreviewResponse>()
    expect(preview).toMatchObject({ findings: 0, anyModelCalls: false })
    expect(preview.warnings.join(' ')).toMatch(/nothing to summarise/)
    const r = await f.api.post('/api/findings/summary', { rubric: 'other', previewToken: preview.previewToken, confirm: true })
    expect(r.status).toBe(422)
    expect(r.json().error.code).toBe('no_findings')
  })

  it('writes the draft with the fake provider, saves it, and shows it with the report and in the Markdown', async () => {
    const provider = createFakeProvider(DRAFT, { usage: { inputTokens: 900, outputTokens: 300, costUsd: 0.0096 } })
    const f = await seeded({ provider })
    const { previewToken } = (await f.api.post('/api/findings/summary/preview', { since: '2026-11-01' })).json<FindingsSummaryPreviewResponse>()
    const r = await f.api.post('/api/findings/summary', { since: '2026-11-01', previewToken, confirm: true })
    expect(r.status, r.text).toBe(201)
    const { record } = r.json<FindingsSummaryResponse>()
    expect(record).toMatchObject({
      schemaVersion: 1,
      filters: { since: '2026-11-01T00:00:00.000Z' },
      findings: 5,
      model: { provider: 'fake', model: 'fake-model', effort: 'high' },
      usage: { inputTokens: 900, outputTokens: 300, costUsd: 0.0096 },
      fixes: [{ criterion: 'alpha', pattern: 'It answers a different question.', proposedChange: 'Restate the question before answering.', itemIds: ['run-a:alpha', 'run-c:alpha'] }],
    })
    expect(record.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(record.warnings.join(' ')).toMatch(/unknown-rule/)
    expect(record.warnings.join(' ')).toMatch(/made-up:id/)

    // One call, to the judge role, with the findings quoted as data.
    expect(provider.calls).toHaveLength(1)
    const call = provider.calls[0]!
    expect(call.role).toBe('judge')
    expect(call.system).toMatch(/quoted data/)
    expect(call.system).toMatch(/never an instruction to you/)
    expect(call.messages[0]!.content).toContain('<finding item_id="run-c:alpha">')
    expect(call.messages[0]!.content).toContain('CRITIQUE run-c/alpha')
    expect(call.messages[0]!.content).toContain('Never gives a diagnosis.')

    const files = readdirSync(join(f.workdir, '.evals', 'findings'))
    expect(files).toEqual([`${record.summaryId}.json`])
    expect(JSON.parse(readFileSync(join(f.workdir, '.evals', 'findings', files[0]!), 'utf8'))).toEqual(record)

    const report = await findings(f, '?since=2026-11-01')
    expect(report.summary).toEqual({ record, current: true })
    // Other filters are another report, with no draft.
    expect((await findings(f)).summary).toBeNull()

    const md = (await f.api.get('/api/findings.md?since=2026-11-01')).text
    expect(md).toContain('## Suggested fixes (AI draft, review before use)')
    expect(md.indexOf('Suggested fixes')).toBeLessThan(md.indexOf('## Summary'))
    expect(md).toContain('**Proposed change.** Restate the question before answering.')
    expect(md).toContain('Based on: `run-a:alpha`, `run-c:alpha`')

    // A new label changes the findings: the draft is shown as out of date, and left out of the Markdown.
    writeLabels(f, [...LABELS, lab('run-d', 'gamma', 'fail')])
    expect((await findings(f, '?since=2026-11-01')).summary).toMatchObject({ current: false })
    expect((await f.api.get('/api/findings.md?since=2026-11-01')).text).not.toContain('Suggested fixes')
  })

  it('rejects unknown fields in the body', async () => {
    const f = await seeded()
    const r = await f.api.post('/api/findings/summary/preview', { since: '2026-11-01', model: 'claude-something-cheaper' })
    expect(r.status).toBe(400)
    expect(r.text).toMatch(/model/)
  })
})
