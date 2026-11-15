import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadLabels } from '../../src/index.js'
import type { LabelsResponse, QueueResponse } from '../../src/ui/api-types.js'
import { fixture, type Fixture } from './harness.js'
import { critiqueOf, saveSuite, type RunSpec } from './records.js'

const fixtures: Fixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(f => f.stop()))
})

const SCENARIO = 'reschedule-tomorrow-3pm' // its rubric ("scheduling") has these two criteria
const CRITERIA = ['confirms-before-acting', 'no-medical-advice']

/** A server with 20 saved runs (so 40 run x criterion items), half of them failing "confirms-before-acting". */
async function seeded(runs = 20) {
  const f = await fixture()
  fixtures.push(f)
  const specs: RunSpec[] = Array.from({ length: runs }, (_, i) => ({
    runId: `run-${String(i).padStart(2, '0')}`,
    scenario: SCENARIO,
    criteria: { [CRITERIA[0]!]: i % 2 === 0 ? 'fail' : 'pass', [CRITERIA[1]!]: 'pass' },
  }))
  saveSuite(f.workdir, specs, { suiteId: 'suite-1' })
  return f
}
const labelsFile = (f: Fixture) => join(f.workdir, '.evals', 'labels.jsonl')
const queue = async (f: Fixture, query = '') => (await f.api.get(`/api/queue${query}`)).json<QueueResponse>()
const labelBody = (itemId: string, over: Record<string, unknown> = {}) => ({ itemId, labeler: 'ann', verdict: 'fail', critique: 'It never asked first.', ...over })

describe('GET /api/queue', () => {
  it('is blind: no judge verdict or critique appears anywhere in the response', async () => {
    const f = await seeded()
    const res = await f.api.get('/api/queue?limit=200')
    expect(res.status).toBe(200)
    expect(res.text).not.toContain('JUDGE-CRITIQUE')
    expect(res.text).not.toMatch(/critique/i)
    expect(res.text).not.toMatch(/"verdict"/)
    const body = res.json<QueueResponse>()
    expect(body.items.length).toBeGreaterThan(0)
    for (const item of body.items) {
      expect(JSON.stringify(item)).not.toContain(critiqueOf(item.runId, item.criterion.id))
      expect(item.criterion.text).toMatch(/\w/) // the labeler sees the question, not the judge's answer
    }
    // It stays blind after labelling other items, and in every other labels endpoint that lists items.
    await f.api.post('/api/labels', labelBody(body.items[0]!.itemId))
    expect(await f.api.get('/api/queue?limit=200').then(r => r.text)).not.toContain('JUDGE-CRITIQUE')
    expect(await f.api.get('/api/labels').then(r => r.text)).not.toContain('JUDGE-CRITIQUE')
  })

  it('carries the rubric text for each criterion, the input, the output and the context', async () => {
    const f = await seeded(4)
    const body = await queue(f, '?limit=100')
    const item = body.items.find(i => i.itemId === `run-00:${CRITERIA[0]}`)!
    expect(item).toMatchObject({
      suiteId: 'suite-1', runId: 'run-00', scenarioId: SCENARIO, input: 'Question for run-00', output: 'Answer for run-00', group: 'run-00',
      criterion: { id: 'confirms-before-acting', critical: false, text: expect.stringContaining('confirm') },
    })
    expect(body.items.find(i => i.criterion.id === 'no-medical-advice')!.criterion.critical).toBe(true)
  })

  it('carries when the run started, so several runs of one scenario can be told apart', async () => {
    const f = await seeded(3)
    const items = (await queue(f, '?limit=100')).items
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) expect(new Date(item.startedAt).toISOString()).toBe(item.startedAt)
  })

  it('does not change how an item is sampled with the page size: sampled_by comes from the whole plan', async () => {
    const f = await seeded()
    const small = (await queue(f, '?limit=5')).items
    const large = (await queue(f, '?limit=200')).items
    expect(large.length).toBeGreaterThan(small.length)
    // An item in both pages has the same reason in each.
    for (const s of small) expect(large.find(l => l.itemId === s.itemId)?.reason).toBe(s.reason)
    // Labelling an item that only the large page lists records the plan's answer, with no limit involved.
    const onlyLarge = large.filter(l => !small.some(s => s.itemId === l.itemId))
    for (const item of [onlyLarge.find(i => i.reason === 'random')!, onlyLarge.find(i => i.reason !== 'random')!]) {
      const r = await f.api.post('/api/labels', labelBody(item.itemId))
      expect(r.status).toBe(201)
      expect(r.json().label.sampled_by).toBe(item.reason === 'random' ? 'random' : 'targeted')
    }
  })

  it('is the same on every reload, and respects limit', async () => {
    const f = await seeded()
    const a = await queue(f, '?limit=10')
    const b = await queue(f, '?limit=10')
    expect(a.items.map(i => i.itemId)).toEqual(b.items.map(i => i.itemId))
    expect(a.items).toHaveLength(10)
    expect(a.stats).toMatchObject({ candidates: 40, queued: 10, labelled: 0, labelledRandom: 0, quotaMet: true, minRandomShare: 0.3 })
    expect((await f.api.get('/api/queue?limit=0')).status).toBe(400)
    expect((await f.api.get('/api/queue?limit=500')).status).toBe(400)
  })

  it('holds the random quota across the whole labelling session', async () => {
    const f = await seeded()
    for (let i = 0; i < 40; i++) {
      const q = await queue(f, '?limit=5')
      if (q.items.length === 0) break
      const item = q.items[0]!
      const r = await f.api.post('/api/labels', labelBody(item.itemId, { verdict: i % 2 === 0 ? 'fail' : 'pass' }))
      expect(r.status).toBe(201)
    }
    const labels = (await f.api.get('/api/labels')).json<LabelsResponse>()
    expect(labels.labels.length).toBeGreaterThan(10)
    expect(labels.stats.randomShare!).toBeGreaterThanOrEqual(0.3)
    expect(labels.stats.warnings.join(' ')).not.toMatch(/Only \d+% of labels were randomly sampled/)
    expect((await queue(f, '?limit=5')).stats.quotaMet).toBe(true)
  })

  it('explains an empty queue', async () => {
    const f = await fixture()
    fixtures.push(f)
    const empty = await queue(f)
    expect(empty.items).toEqual([])
    expect(empty.notes.join(' ')).toMatch(/no saved runs/i)
  })
})

describe('POST /api/labels', () => {
  it('writes a label in the existing format, taking the content from the server and sampled_by from the plan', async () => {
    const f = await seeded()
    const item = (await queue(f, '?limit=10')).items[0]!
    const r = await f.api.post('/api/labels', labelBody(item.itemId, { verdict: 'pass', critique: '  Looks fine.  ', labeler: ' ann ' }))
    expect(r.status).toBe(201)
    const { label } = r.json()
    expect(label).toMatchObject({
      id: item.itemId, group: item.group, criterion: item.criterion.id, input: item.input, output: item.output, verdict: 'pass', critique: 'Looks fine.',
      labeler: 'ann', sampled_by: item.reason === 'random' ? 'random' : 'targeted',
    })
    expect(new Date(label.at).toISOString()).toBe(label.at)
    expect(label.split).toBeUndefined()
    // The file is what `evals calibrate` reads.
    expect(loadLabels(labelsFile(f))).toEqual([label])
    // The item left the queue, and its label shows up.
    expect((await queue(f, '?limit=100')).items.some(i => i.itemId === item.itemId)).toBe(false)
    expect((await f.api.get('/api/labels')).json<LabelsResponse>()).toMatchObject({ file: labelsFile(f), stats: { total: 1 } })
  })

  it('records sampled_by from the server\'s plan: a client cannot claim an item was random', async () => {
    const f = await seeded()
    const items = (await queue(f, '?limit=40')).items
    const targeted = items.find(i => i.reason !== 'random')!
    const random = items.find(i => i.reason === 'random')!
    // The body has no field for it. Sending one is refused.
    const forged = await f.api.post('/api/labels', { ...labelBody(targeted.itemId), sampled_by: 'random' })
    expect(forged.status).toBe(400)
    expect((await f.api.post('/api/labels', labelBody(targeted.itemId))).json().label.sampled_by).toBe('targeted')
    expect((await f.api.post('/api/labels', labelBody(random.itemId))).json().label.sampled_by).toBe('random')
  })

  it('rejects a missing or blank critique, labeler or verdict, and a split field', async () => {
    const f = await seeded()
    const id = (await queue(f)).items[0]!.itemId
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ['no critique', { critique: undefined }, /critique/],
      ['blank critique', { critique: '   ' }, /critique is required/],
      ['no labeler', { labeler: '' }, /labeler is required/],
      ['no verdict', { verdict: undefined }, /verdict/],
      ['bad verdict', { verdict: 'maybe' }, /verdict/],
      ['split', { split: 'test' }, /split/],
      ['unknown field', { group: 'mine' }, /group/],
    ]
    for (const [name, over, message] of cases) {
      const r = await f.api.post('/api/labels', { ...labelBody(id), ...over })
      expect(r.status, name).toBe(400)
      expect(r.json().error.code, name).toBe('bad_request')
      expect(r.json().error.message, name).toMatch(message)
    }
    expect((await f.api.post('/api/labels', { labeler: 'a', verdict: 'pass', critique: 'x' })).status).toBe(400)
    expect(readFileOr(labelsFile(f))).toBe('')
  })

  it('rejects a duplicate, an unknown item, and an item that is not up for review', async () => {
    const f = await seeded()
    const items = (await queue(f, '?limit=40')).items
    const id = items[0]!.itemId
    expect((await f.api.post('/api/labels', labelBody(id))).status).toBe(201)
    const dup = await f.api.post('/api/labels', labelBody(id))
    expect(dup.status).toBe(409)
    expect(dup.json().error.code).toBe('duplicate_label')
    const unknown = await f.api.post('/api/labels', labelBody('run-99:confirms-before-acting'))
    expect(unknown.status).toBe(404)
    expect(unknown.json().error.code).toBe('item_not_found')
    // A judge pass that was not sampled is a real item, but it is not in the queue: labelling it would let a labeller pick which passes to review.
    const queued = new Set((await queue(f, '?limit=200')).items.map(i => i.itemId))
    const skipped = Array.from({ length: 20 }, (_, i) => `run-${String(i).padStart(2, '0')}:${CRITERIA[1]}`).find(x => !queued.has(x))
    expect(skipped).toBeDefined()
    const off = await f.api.post('/api/labels', labelBody(skipped!))
    expect(off.status).toBe(422)
    expect(off.json().error.code).toBe('item_not_in_queue')
  })

  it('refuses to write over a label file it cannot read, and says so', async () => {
    const f = await seeded()
    const item = (await queue(f)).items[0]!
    writeFileSync(labelsFile(f), 'not json\n')
    const r = await f.api.post('/api/labels', labelBody(item.itemId))
    expect(r.status).toBe(422)
    expect(r.json().error.code).toBe('corrupt_record')
    expect(readFileSync(labelsFile(f), 'utf8')).toBe('not json\n')
    expect((await f.api.get('/api/labels')).status).toBe(422)
  })

  it('uses the label file named with --labels', async () => {
    const custom = join(await seededDir(), 'my-labels.jsonl')
    const f = await fixture({ server: { labelsFile: custom } })
    fixtures.push(f)
    saveSuite(f.workdir, [{ runId: 'r-1', scenario: SCENARIO, criteria: { [CRITERIA[0]!]: 'fail' } }])
    const item = (await queue(f)).items[0]!
    expect((await f.api.post('/api/labels', labelBody(item.itemId))).status).toBe(201)
    expect(loadLabels(custom)).toHaveLength(1)
    expect((await f.api.get('/api/labels')).json().file).toBe(custom)
  })
})

describe('GET /api/labels/:id/reveal', () => {
  it('refuses before the item is labelled, and shows the judge only after', async () => {
    const f = await seeded()
    const item = (await queue(f, '?limit=100')).items.find(i => i.runId === 'run-00' && i.criterion.id === CRITERIA[0])!
    const id = encodeURIComponent(item.itemId)

    const early = await f.api.get(`/api/labels/${id}/reveal`)
    expect(early.status).toBe(403)
    expect(early.json().error.code).toBe('not_labelled')
    expect(early.text).not.toContain('JUDGE-CRITIQUE')
    // Nor for an id that does not exist: the answer does not depend on whether the run does.
    expect((await f.api.get(`/api/labels/${encodeURIComponent('nope:nope')}/reveal`)).status).toBe(403)

    await f.api.post('/api/labels', labelBody(item.itemId, { verdict: 'pass', critique: 'Seems fine to me.' }))
    const late = await f.api.get(`/api/labels/${id}/reveal`)
    expect(late.status).toBe(200)
    expect(late.json()).toMatchObject({
      labelId: item.itemId, runId: 'run-00', suiteId: 'suite-1',
      judge: { verdict: 'fail', critique: critiqueOf('run-00', CRITERIA[0]!), critical: false, grader: 'rubric-judge(r@1)' },
      human: { verdict: 'pass', critique: 'Seems fine to me.', labeler: 'ann' },
      agrees: false,
    })
  })

  it('answers 404 for a label that is not for an item from a saved run', async () => {
    const f = await seeded()
    const { appendLabel } = await import('../../src/store/index.js')
    appendLabel(labelsFile(f), { id: 'hand-made', criterion: 'c', output: 'o', verdict: 'pass', critique: 'x', labeler: 'a', sampled_by: 'random' })
    appendLabel(labelsFile(f), { id: 'gone-run:confirms-before-acting', criterion: 'c', output: 'o', verdict: 'pass', critique: 'x', labeler: 'a', sampled_by: 'random' })
    for (const id of ['hand-made', 'gone-run:confirms-before-acting']) {
      const r = await f.api.get(`/api/labels/${encodeURIComponent(id)}/reveal`)
      expect(r.status, id).toBe(404)
      expect(r.json().error.code).toBe('not_revealable')
    }
  })
})

function readFileOr(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

async function seededDir(): Promise<string> {
  const { tempDir } = await import('./harness.js')
  return tempDir('evals-labels-dir-')
}
