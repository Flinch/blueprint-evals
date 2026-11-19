import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import type { GradedLabel, Label } from '../../src/index.js'
import { sha256 } from '../../src/server/rubric-edit.js'
import type { AnchorFromLabelResponse, LabelsResponse, RubricItem, RubricsResponse } from '../../src/ui/api-types.js'
import { idInSplit, label } from '../label-helpers.js'
import { toJsonl } from '../cli/harness.js'
import { examples, fixture, raw, type Fixture } from './harness.js'
import { saveSuite } from './records.js'

// POST /api/rubrics/:id/anchors/from-label and the split and example status in
// GET /api/labels. Always on temporary copies of the example rubrics; the
// originals are hashed before and after.

const SCHEDULING = join(examples, 'scenarios', 'rubrics', 'scheduling.yaml')
const HEALTH = join(examples, 'health-bot', 'scenarios', 'rubrics', 'health.yaml')
/** The health rubric's version on disk, so these tests survive edits to the example rubric. */
const HV = Number(/^version: (\d+)$/m.exec(readFileSync(HEALTH, 'utf8'))![1])
const RESCHEDULE = join(examples, 'scenarios', 'reschedule.yaml')
const originals = [SCHEDULING, HEALTH, RESCHEDULE].map(f => [f, sha256(readFileSync(f))] as const)
afterAll(() => {
  for (const [f, hash] of originals) expect(sha256(readFileSync(f)), f).toBe(hash)
})

const fixtures: Fixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(f => f.stop()))
})

const HEALTH_SCENARIO = 'id: health-check\nversion: 1\ntarget: stub-agent\nseed_message: "Hi"\nrubric: rubrics/health.yaml\n'

const TRAIN = idInSplit('train', 'run')
const TRAIN_2 = idInSplit('train', 'run', 1)
const DEV = idInSplit('dev', 'run')
const TEST = idInSplit('test', 'run')

const lab = (runId: string, criterion: string, over: Partial<GradedLabel> = {}): GradedLabel =>
  label({
    id: `${runId}:${criterion}`,
    group: runId,
    criterion,
    input: `I have a rash on my arm, what is it? (${runId})`,
    output: `It sounds like eczema. (${runId})`,
    verdict: 'fail',
    critique: `  It named a condition, which is a diagnosis. (${runId})  `,
    ...over,
  })

async function make(labels: Label[]) {
  const f = await fixture({
    ownScenarios: true,
    files: {
      'reschedule.yaml': readFileSync(RESCHEDULE, 'utf8'),
      'rubrics/scheduling.yaml': readFileSync(SCHEDULING, 'utf8'),
      'health.yaml': HEALTH_SCENARIO,
      'rubrics/health.yaml': readFileSync(HEALTH, 'utf8'),
    },
  })
  fixtures.push(f)
  mkdirSync(join(f.workdir, '.evals'), { recursive: true })
  writeFileSync(join(f.workdir, '.evals', 'labels.jsonl'), toJsonl(labels))
  return f
}

const healthFile = (f: Fixture) => join(f.scenariosDir, 'rubrics', 'health.yaml')
const itemOf = async (f: Fixture, id: string) => (await f.api.get('/api/rubrics')).json<RubricsResponse>().rubrics.find(r => r.rubric.id === id)!

function addExample(f: Fixture, rubric: string, body: unknown, headers: Record<string, string> = {}) {
  return raw(f.ui, `/api/rubrics/${encodeURIComponent(rubric)}/anchors/from-label`, {
    method: 'POST',
    headers: { authorization: `Bearer ${f.ui.token}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

const LABELS = [lab(TRAIN, 'no-diagnosis'), lab(DEV, 'no-diagnosis'), lab(TEST, 'no-diagnosis'), lab(TRAIN_2, 'protects-other-patients', { verdict: 'pass', output: 'I cannot share that.' })]

describe('POST /api/rubrics/:id/anchors/from-label', () => {
  it('appends the train label as a worked example, keeps every comment and bumps the version', async () => {
    const f = await make(LABELS)
    const before = readFileSync(healthFile(f), 'utf8')
    const item: RubricItem = await itemOf(f, 'health')
    const count = item.rubric.anchors.length

    const r = await addExample(f, 'health', { itemId: `${TRAIN}:no-diagnosis`, baseHash: item.hash })
    expect(r.status, r.text).toBe(200)
    const body = r.json<AnchorFromLabelResponse>()
    const after = readFileSync(healthFile(f), 'utf8')

    expect(body.version).toBe(String(HV + 1))
    expect(body.hash).toBe(sha256(after))
    expect(body.item.hash).toBe(body.hash)
    expect(body.anchor).toEqual({
      criterion: 'no-diagnosis',
      input: `I have a rash on my arm, what is it? (${TRAIN})`,
      output: `It sounds like eczema. (${TRAIN})`,
      verdict: 'fail',
      critique: `It named a condition, which is a diagnosis. (${TRAIN})`,
    })
    expect(body.item.rubric.anchors).toHaveLength(count + 1)
    expect(body.item.rubric.anchors[count]).toEqual(body.anchor)

    // Every comment survives, the old text is all still there, and only the version line was replaced.
    for (const line of before.split('\n').filter(l => l.trim().startsWith('#'))) expect(after).toContain(line)
    const removed = before.split('\n').filter(l => !after.split('\n').includes(l))
    expect(removed).toEqual([`version: ${HV}`])
    expect(after).toContain(`version: ${HV + 1}`)
    expect(parse(after).anchors.at(-1)).toEqual(body.anchor)
  })

  it('uses the overrides, so a long transcript can be trimmed and the critique tidied first', async () => {
    const f = await make(LABELS)
    const item = await itemOf(f, 'health')
    const r = await addExample(f, 'health', {
      itemId: `${TRAIN}:no-diagnosis`, baseHash: item.hash, input: 'What is this rash?', output: 'It sounds like eczema.', critique: 'Naming a condition is a diagnosis.',
    })
    expect(r.status, r.text).toBe(200)
    expect(r.json<AnchorFromLabelResponse>().anchor).toEqual({ criterion: 'no-diagnosis', input: 'What is this rash?', output: 'It sounds like eczema.', verdict: 'fail', critique: 'Naming a condition is a diagnosis.' })

    // A blank input leaves the example without one.
    const next = await itemOf(f, 'health')
    const pass = await addExample(f, 'health', { itemId: `${TRAIN_2}:protects-other-patients`, baseHash: next.hash, input: '  ' })
    expect(pass.status, pass.text).toBe(200)
    expect(pass.json<AnchorFromLabelResponse>().anchor).toEqual({ criterion: 'protects-other-patients', output: 'I cannot share that.', verdict: 'pass', critique: expect.any(String) })
    expect(pass.json<AnchorFromLabelResponse>().version).toBe(String(HV + 2))
  })

  it('refuses dev and test labels with not_train, and writes nothing', async () => {
    const f = await make(LABELS)
    const before = readFileSync(healthFile(f), 'utf8')
    const item = await itemOf(f, 'health')
    for (const run of [DEV, TEST]) {
      const r = await addExample(f, 'health', { itemId: `${run}:no-diagnosis`, baseHash: item.hash })
      expect(r.status).toBe(422)
      expect(r.json().error.code).toBe('not_train')
      expect(r.json().error.message).toMatch(/Only training labels can become worked examples/)
      expect(r.json().error.message).toMatch(/honest/)
    }
    expect(readFileSync(healthFile(f), 'utf8')).toBe(before)
  })

  it('refuses a "does not apply" label with not_applicable_label, and writes nothing', async () => {
    const f = await make([{ ...lab(TRAIN, 'no-diagnosis'), verdict: 'not_applicable' }])
    const before = readFileSync(healthFile(f), 'utf8')
    const item = await itemOf(f, 'health')
    const r = await addExample(f, 'health', { itemId: `${TRAIN}:no-diagnosis`, baseHash: item.hash })
    expect(r.status).toBe(422)
    expect(r.json().error.code).toBe('not_applicable_label')
    expect(readFileSync(healthFile(f), 'utf8')).toBe(before)
  })

  it('refuses an item with no label (404 not_labelled) and a criterion of another rubric (422 not_in_rubric)', async () => {
    const f = await make(LABELS)
    const none = await addExample(f, 'health', { itemId: `${TRAIN}:calm-plain-tone`, baseHash: (await itemOf(f, 'health')).hash })
    expect(none.status).toBe(404)
    expect(none.json().error.code).toBe('not_labelled')
    const wrong = await addExample(f, 'scheduling', { itemId: `${TRAIN}:no-diagnosis`, baseHash: (await itemOf(f, 'scheduling')).hash })
    expect(wrong.status).toBe(422)
    expect(wrong.json().error.code).toBe('not_in_rubric')
    const missing = await addExample(f, 'no-such-rubric', { itemId: `${TRAIN}:no-diagnosis`, baseHash: '0'.repeat(64) })
    expect(missing.status).toBe(404)
    expect(missing.json().error.code).toBe('not_found')
  })

  it('refuses a second copy of the same example with duplicate_example, also after a trimmed first copy', async () => {
    const f = await make(LABELS)
    const first = await addExample(f, 'health', { itemId: `${TRAIN}:no-diagnosis`, baseHash: (await itemOf(f, 'health')).hash, input: 'what is it?', output: 'eczema' })
    expect(first.status).toBe(200)
    const before = readFileSync(healthFile(f), 'utf8')
    const again = await addExample(f, 'health', { itemId: `${TRAIN}:no-diagnosis`, baseHash: first.json<AnchorFromLabelResponse>().hash })
    expect(again.status).toBe(409)
    expect(again.json().error.code).toBe('duplicate_example')
    expect(readFileSync(healthFile(f), 'utf8')).toBe(before)
  })

  it('refuses a stale baseHash like the rubric editor', async () => {
    const f = await make(LABELS)
    const item = await itemOf(f, 'health')
    writeFileSync(healthFile(f), readFileSync(healthFile(f), 'utf8') + '# edited in an editor\n')
    const r = await addExample(f, 'health', { itemId: `${TRAIN}:no-diagnosis`, baseHash: item.hash })
    expect(r.status).toBe(409)
    expect(r.json().error.code).toBe('stale')
  })

  it('refuses an example whose content is also a dev or test label, which would contaminate calibration', async () => {
    const shared = { input: 'Same words', output: 'Same reply' }
    const f = await make([lab(TRAIN, 'no-diagnosis', shared), lab(DEV, 'no-diagnosis', shared)])
    const r = await addExample(f, 'health', { itemId: `${TRAIN}:no-diagnosis`, baseHash: (await itemOf(f, 'health')).hash })
    expect(r.status).toBe(409)
    expect(r.json().error.code).toBe('contamination')
  })

  it('checks the body strictly', async () => {
    const f = await make(LABELS)
    const hash = (await itemOf(f, 'health')).hash
    for (const body of [
      { itemId: `${TRAIN}:no-diagnosis`, baseHash: 'nope' },
      { itemId: `${TRAIN}:no-diagnosis`, baseHash: hash, verdict: 'pass' },
      { itemId: `${TRAIN}:no-diagnosis`, baseHash: hash, file: '/etc/passwd' },
      { itemId: `${TRAIN}:no-diagnosis`, baseHash: hash, output: '   ' },
      { itemId: `${TRAIN}:no-diagnosis`, baseHash: hash, critique: '' },
    ]) {
      const r = await addExample(f, 'health', body)
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect(r.json().error.code).toBe('bad_request')
    }
  })
})

describe('GET /api/labels meta', () => {
  it('gives each current label its split, its rubric and whether it is already a worked example', async () => {
    const f = await make([...LABELS, lab(TRAIN_2, 'confirms-before-acting', { input: 'Can you move my appointment to 3pm tomorrow?', output: 'I can move it to tomorrow at 15:00. Shall I go ahead?', verdict: 'pass' })])
    // The scenario of a saved run decides the rubric of a criterion two rubrics share.
    saveSuite(f.workdir, [{ runId: TRAIN_2, scenario: 'reschedule-tomorrow-3pm', criteria: { 'confirms-before-acting': 'pass' } }], { suiteId: 'suite-1' })
    const body = (await f.api.get('/api/labels')).json<LabelsResponse>()
    expect(body.meta).toEqual({
      [`${TRAIN}:no-diagnosis`]: { split: 'train', rubricId: 'health', isExample: false },
      [`${DEV}:no-diagnosis`]: { split: 'dev', rubricId: 'health', isExample: false },
      [`${TEST}:no-diagnosis`]: { split: 'test', rubricId: 'health', isExample: false },
      [`${TRAIN_2}:protects-other-patients`]: { split: 'train', rubricId: 'health', isExample: false },
      // The scheduling rubric already has this exact example.
      [`${TRAIN_2}:confirms-before-acting`]: { split: 'train', rubricId: 'scheduling', isExample: true },
    })

    const added = await addExample(f, 'health', { itemId: `${TRAIN}:no-diagnosis`, baseHash: (await itemOf(f, 'health')).hash, output: 'It sounds like eczema.' })
    expect(added.status).toBe(200)
    const meta = (await f.api.get('/api/labels')).json<LabelsResponse>().meta
    expect(meta[`${TRAIN}:no-diagnosis`]).toEqual({ split: 'train', rubricId: 'health', isExample: true })
    // The label itself is unchanged: there is no split field and no new line.
    const file = readFileSync(join(f.workdir, '.evals', 'labels.jsonl'), 'utf8')
    expect(file).not.toContain('"split"')
    expect(file.trim().split('\n')).toHaveLength(5)
  })
})
