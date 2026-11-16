import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadLabels } from '../../src/index.js'
import type { LabelSuggestionsResponse, LabelsResponse, QueueResponse, RevealResponse } from '../../src/ui/api-types.js'
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

describe('POST /api/labels/:id/revise', () => {
  const revise = (f: Fixture, itemId: string, body: Record<string, unknown>) => f.api.post(`/api/labels/${encodeURIComponent(itemId)}/revise`, body)
  const reviseBody = (over: Record<string, unknown> = {}) => ({ labeler: 'ann', verdict: 'fail', critique: 'On a second look, it never asked.', ...over })
  /** Labels run-00's "confirms-before-acting" (which the judge failed) as a blind pass. */
  async function labelled() {
    const f = await seeded()
    const item = (await queue(f, '?limit=100')).items.find(i => i.runId === 'run-00' && i.criterion.id === CRITERIA[0])!
    const first = await f.api.post('/api/labels', labelBody(item.itemId, { verdict: 'pass', critique: 'Seems fine to me.' }))
    expect(first.status).toBe(201)
    return { f, item, original: first.json().label }
  }

  it('appends a revision that replaces the current label and keeps the blind label in the file', async () => {
    const { f, item, original } = await labelled()
    const r = await revise(f, item.itemId, reviseBody({ critique: '  It acted without asking.  ', labeler: ' bo ' }))
    expect(r.status).toBe(201)
    const { label } = r.json()
    expect(label).toMatchObject({
      id: `${item.itemId}~r1`, replaces: item.itemId, verdict: 'fail', critique: 'It acted without asking.', labeler: 'bo',
      group: original.group, criterion: original.criterion, input: original.input, output: original.output, sampled_by: original.sampled_by,
    })
    expect(new Date(label.at).toISOString()).toBe(label.at)
    // Append-only: the first line is untouched, and the file is what `evals calibrate` reads.
    expect(loadLabels(labelsFile(f))).toEqual([original, label])
  })

  it('chains a second revision onto the first', async () => {
    const { f, item } = await labelled()
    expect((await revise(f, item.itemId, reviseBody())).status).toBe(201)
    const second = await revise(f, item.itemId, reviseBody({ verdict: 'pass', critique: 'Back to pass: it did confirm in [2].' }))
    expect(second.status).toBe(201)
    expect(second.json().label).toMatchObject({ id: `${item.itemId}~r2`, replaces: `${item.itemId}~r1`, verdict: 'pass' })
    expect(loadLabels(labelsFile(f)).map(l => l.id)).toEqual([item.itemId, `${item.itemId}~r1`, `${item.itemId}~r2`])
  })

  it('answers 404 not_labelled for an item with no label, and writes nothing', async () => {
    const f = await seeded()
    const item = (await queue(f)).items[0]!
    for (const id of [item.itemId, 'nope:nope']) {
      const r = await revise(f, id, reviseBody())
      expect(r.status, id).toBe(404)
      expect(r.json().error.code).toBe('not_labelled')
    }
    expect(readFileOr(labelsFile(f))).toBe('')
  })

  it('answers 422 no_change when the verdict and trimmed critique are the same as the current label', async () => {
    const { f, item } = await labelled()
    const same = await revise(f, item.itemId, reviseBody({ verdict: 'pass', critique: '  Seems fine to me. ', labeler: 'someone else' }))
    expect(same.status).toBe(422)
    expect(same.json().error.code).toBe('no_change')
    // The comparison is with the current label, not the blind one.
    expect((await revise(f, item.itemId, reviseBody())).status).toBe(201)
    expect((await revise(f, item.itemId, reviseBody())).json().error.code).toBe('no_change')
    expect((await revise(f, item.itemId, reviseBody({ verdict: 'pass', critique: 'Seems fine to me.' }))).status).toBe(201)
    expect(loadLabels(labelsFile(f))).toHaveLength(3)
  })

  it('validates the body like POST /api/labels', async () => {
    const { f, item } = await labelled()
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ['no critique', { critique: undefined }, /critique/],
      ['blank critique', { critique: '   ' }, /critique is required/],
      ['long critique', { critique: 'x'.repeat(20_001) }, /critique/],
      ['no labeler', { labeler: ' ' }, /labeler is required/],
      ['bad verdict', { verdict: 'maybe' }, /verdict/],
      ['replaces', { replaces: 'x' }, /replaces/],
      ['sampled_by', { sampled_by: 'random' }, /sampled_by/],
      ['itemId', { itemId: item.itemId }, /itemId/],
    ]
    for (const [name, over, message] of cases) {
      const r = await revise(f, item.itemId, { ...reviseBody(), ...over })
      expect(r.status, name).toBe(400)
      expect(r.json().error.code, name).toBe('bad_request')
      expect(r.json().error.message, name).toMatch(message)
    }
    expect(loadLabels(labelsFile(f))).toHaveLength(1)
  })

  it('shows the current label in the reveal, with the blind label and whether the judge agreed with each', async () => {
    const { f, item } = await labelled()
    const id = encodeURIComponent(item.itemId)
    const before = (await f.api.get(`/api/labels/${id}/reveal`)).json<RevealResponse>()
    expect(before).toMatchObject({ labelId: item.itemId, agrees: false, blindAgrees: false, original: null, revisions: 0 })

    await revise(f, item.itemId, reviseBody())
    const after = await f.api.get(`/api/labels/${id}/reveal`)
    expect(after.status).toBe(200)
    expect(after.json<RevealResponse>()).toMatchObject({
      labelId: `${item.itemId}~r1`, runId: 'run-00',
      judge: { verdict: 'fail' },
      human: { verdict: 'fail', critique: 'On a second look, it never asked.', labeler: 'ann' },
      agrees: true,
      original: { verdict: 'pass', critique: 'Seems fine to me.' },
      revisions: 1,
      blindAgrees: false,
    })
    // The reveal is by item id. The revision line's id is not an item.
    expect((await f.api.get(`/api/labels/${encodeURIComponent(`${item.itemId}~r1`)}/reveal`)).status).toBe(403)
  })

  it('lists current labels with the superseded versions in history, and counts items in the stats', async () => {
    const { f, item, original } = await labelled()
    const other = (await queue(f, '?limit=100')).items[0]!
    await f.api.post('/api/labels', labelBody(other.itemId))
    await revise(f, item.itemId, reviseBody())
    const second = (await revise(f, item.itemId, reviseBody({ verdict: 'pass', critique: 'Pass after all.' }))).json().label
    const body = (await f.api.get('/api/labels')).json<LabelsResponse>()
    expect(body.labels.map(l => l.id).sort()).toEqual([other.itemId, second.id].sort())
    expect(Object.keys(body.history)).toEqual([item.itemId])
    expect(body.history[item.itemId]!.map(l => l.id)).toEqual([original.id, `${item.itemId}~r1`])
    expect(body.stats).toMatchObject({ total: 2, revisions: 1 })
    expect(body.stats.byVerdict.pass + body.stats.byVerdict.fail).toBe(2)
  })

  it('leaves the queue, its counts and the random quota as they were', async () => {
    const f = await seeded()
    const items = (await queue(f, '?limit=200')).items
    const random = items.find(i => i.reason === 'random')!
    const targeted = items.find(i => i.reason !== 'random')!
    await f.api.post('/api/labels', labelBody(random.itemId, { verdict: 'pass', critique: 'Fine.' }))
    await f.api.post('/api/labels', labelBody(targeted.itemId))
    const before = await queue(f, '?limit=200')
    const statsBefore = (await f.api.get('/api/labels')).json<LabelsResponse>().stats

    for (const id of [random.itemId, targeted.itemId]) expect((await revise(f, id, reviseBody({ verdict: 'pass', critique: 'Changed.' }))).status).toBe(201)
    expect((await revise(f, random.itemId, reviseBody({ critique: 'Changed again.' }))).status).toBe(201)

    const after = await queue(f, '?limit=200')
    expect(after.stats).toEqual(before.stats)
    expect(after.stats).toMatchObject({ labelled: 2, labelledRandom: 1 })
    expect(after.items.map(i => i.itemId)).toEqual(before.items.map(i => i.itemId))
    const statsAfter = (await f.api.get('/api/labels')).json<LabelsResponse>().stats
    expect(statsAfter).toMatchObject({ total: 2, random: statsBefore.random, targeted: statsBefore.targeted, randomShare: statsBefore.randomShare, bySplit: statsBefore.bySplit, revisions: 2 })
    // The revisions kept how each item was sampled.
    const lines = loadLabels(labelsFile(f))
    expect(lines.filter(l => l.replaces !== undefined && l.id.startsWith(random.itemId)).every(l => l.sampled_by === 'random')).toBe(true)
    expect(lines.filter(l => l.replaces !== undefined && l.id.startsWith(targeted.itemId)).every(l => l.sampled_by === 'targeted')).toBe(true)
    // A revised item is still labelled.
    expect((await f.api.post('/api/labels', labelBody(random.itemId))).json().error.code).toBe('duplicate_label')
  })

  it('treats a broken replace chain in the file as a corrupt record', async () => {
    const { f, item, original } = await labelled()
    const orphan = { ...original, id: 'gone:x~r1', replaces: 'gone:x' }
    writeFileSync(labelsFile(f), readFileSync(labelsFile(f), 'utf8') + JSON.stringify(orphan) + '\n')
    for (const path of ['/api/labels', '/api/queue', `/api/labels/${encodeURIComponent(item.itemId)}/reveal`]) {
      const r = await f.api.get(path)
      expect(r.status, path).toBe(422)
      expect(r.json().error.code, path).toBe('corrupt_record')
      expect(r.json().error.message, path).toMatch(/replaces "gone:x", which is not in the file/)
    }
    expect((await revise(f, item.itemId, reviseBody())).json().error.code).toBe('corrupt_record')
  })
})

describe('GET /api/queue?criterion=', () => {
  it('returns only that criterion, in the same blind order and with the same reasons as the unfiltered queue', async () => {
    const f = await seeded()
    const all = await queue(f, '?limit=200')
    for (const criterion of CRITERIA) {
      const one = await queue(f, `?limit=200&criterion=${criterion}`)
      expect(one.items.length).toBeGreaterThan(0)
      expect(one.items.every(i => i.criterion.id === criterion)).toBe(true)
      // Exactly the unfiltered items for that criterion, in the same order, each with the same reason.
      const expected = all.items.filter(i => i.criterion.id === criterion)
      expect(one.items.map(i => [i.itemId, i.reason])).toEqual(expected.map(i => [i.itemId, i.reason]))
      // Every stat but the page size is about the whole plan.
      const { queued, ...rest } = one.stats
      const { queued: allQueued, ...allRest } = all.stats
      expect(rest).toEqual(allRest)
      expect(queued).toBe(one.items.length)
      expect(allQueued).toBe(all.items.length)
    }
  })

  it('counts what is up for review per criterion from the whole plan, sorted by id', async () => {
    const f = await seeded()
    const all = await queue(f, '?limit=200')
    const counts = CRITERIA.map(id => ({ id, pending: all.items.filter(i => i.criterion.id === id).length })).filter(c => c.pending > 0)
    expect(all.stats.byCriterion).toEqual(counts)
    expect(all.stats.byCriterion.reduce((n, c) => n + c.pending, 0)).toBe(all.stats.pending)
    // A small page, or a filter, does not change the counts.
    expect((await queue(f, '?limit=1')).stats.byCriterion).toEqual(counts)
    expect((await queue(f, `?limit=1&criterion=${CRITERIA[1]}`)).stats.byCriterion).toEqual(counts)
  })

  it('applies the page limit after the filter, with no random top-up taken from outside the criterion', async () => {
    const f = await seeded()
    const all = await queue(f, '?limit=200')
    const page = await queue(f, `?limit=3&criterion=${CRITERIA[0]}`)
    expect(page.items.map(i => i.itemId)).toEqual(all.items.filter(i => i.criterion.id === CRITERIA[0]).slice(0, 3).map(i => i.itemId))
  })

  it('never changes how an item is sampled: a label posted from a filtered page records the plan\'s answer', async () => {
    const f = await seeded()
    const all = (await queue(f, '?limit=200')).items
    const one = (await queue(f, `?limit=200&criterion=${CRITERIA[1]}`)).items
    // "no-medical-advice" is always a judge pass, so everything listed for it is a random sample.
    expect(one.every(i => i.reason === 'random')).toBe(true)
    for (const item of one.slice(0, 2)) {
      expect(all.find(a => a.itemId === item.itemId)?.reason).toBe(item.reason)
      const r = await f.api.post('/api/labels', labelBody(item.itemId, { verdict: 'pass', critique: 'Fine.' }))
      expect(r.status).toBe(201)
      expect(r.json().label.sampled_by).toBe('random')
    }
    // The quota and the counts move as they would for the same labels made in mixed mode.
    const after = await queue(f, '?limit=200')
    expect(after.stats).toMatchObject({ labelled: 2, labelledRandom: 2 })
    expect(after.stats.byCriterion.find(c => c.id === CRITERIA[1])!.pending).toBe(one.length - 2)
  })

  it('gives an empty list and a note for an unknown criterion, with the stats unchanged', async () => {
    const f = await seeded()
    const all = await queue(f, '?limit=200')
    const none = await queue(f, '?criterion=no-such-criterion')
    expect(none.items).toEqual([])
    expect(none.notes.join(' ')).toMatch(/No items for "no-such-criterion" are up for review/)
    expect({ ...none.stats, queued: 0 }).toEqual({ ...all.stats, queued: 0 })
    // An empty value is no filter. A very long one is refused.
    expect((await queue(f, '?limit=200&criterion=')).items.map(i => i.itemId)).toEqual(all.items.map(i => i.itemId))
    expect((await f.api.get(`/api/queue?criterion=${'x'.repeat(201)}`)).status).toBe(400)
  })

  it('stays blind', async () => {
    const f = await seeded()
    const res = await f.api.get(`/api/queue?limit=200&criterion=${CRITERIA[0]}`)
    expect(res.text).not.toContain('JUDGE-CRITIQUE')
    expect(res.text).not.toMatch(/critique/i)
    expect(res.text).not.toMatch(/"verdict"/)
  })
})

describe('GET /api/labels/suggestions', () => {
  const C = 'confirms-before-acting'
  const suggest = async (f: Fixture, query: string) => {
    const r = await f.api.get(`/api/labels/suggestions?${query}`)
    expect(r.status, query).toBe(200)
    return r.json<LabelSuggestionsResponse>()
  }
  let n = 0
  /** Writes one label line straight to the file, with a chosen time. Item ids need not be queue items. */
  async function write(f: Fixture, over: Record<string, unknown>, minute: number) {
    const { appendLabel } = await import('../../src/store/index.js')
    return appendLabel(
      labelsFile(f),
      { id: `item-${++n}:${(over.criterion as string | undefined) ?? C}`, criterion: C, output: 'o', verdict: 'fail', critique: 'x', labeler: 'ann', sampled_by: 'random', ...over },
      new Date(Date.UTC(2026, 10, 1, 9, minute)),
    )
  }
  async function empty() {
    const f = await fixture()
    fixtures.push(f)
    return f
  }

  it('ranks by how often a normalised critique was written, then by the most recent, and shows the latest wording', async () => {
    const f = await empty()
    await write(f, { critique: 'Acted without asking.' }, 1)
    await write(f, { critique: '  acted   WITHOUT asking. ' }, 2)
    await write(f, { critique: 'Acted without asking.\n' }, 3)
    await write(f, { critique: 'Never confirmed the time.' }, 4)
    await write(f, { critique: 'Never confirmed the time.' }, 5)
    await write(f, { critique: 'Older single.' }, 6)
    await write(f, { critique: 'Newer single.' }, 7)
    await write(f, { critique: 'Oldest single.' }, 0)
    await write(f, { critique: 'Fifth single.' }, 8)
    const body = await suggest(f, `criterion=${C}&verdict=fail`)
    expect(body).toEqual({ suggestions: ['Acted without asking.', 'Never confirmed the time.', 'Fifth single.', 'Newer single.'], fromOtherLabelers: false })
  })

  it('filters by criterion and verdict', async () => {
    const f = await empty()
    await write(f, { critique: 'Fail critique.' }, 1)
    await write(f, { critique: 'Pass critique.', verdict: 'pass' }, 2)
    await write(f, { critique: 'Other criterion.', criterion: 'no-medical-advice' }, 3)
    expect((await suggest(f, `criterion=${C}&verdict=fail`)).suggestions).toEqual(['Fail critique.'])
    expect((await suggest(f, `criterion=${C}&verdict=pass`)).suggestions).toEqual(['Pass critique.'])
    expect((await suggest(f, 'criterion=no-medical-advice&verdict=fail')).suggestions).toEqual(['Other criterion.'])
    expect(await suggest(f, 'criterion=nothing-here&verdict=fail')).toEqual({ suggestions: [], fromOtherLabelers: false })
  })

  it('prefers the named labeler, and falls back to everyone, saying so, when they have none', async () => {
    const f = await empty()
    await write(f, { critique: 'Ann wrote this.', labeler: 'ann' }, 1)
    await write(f, { critique: 'Bo wrote this.', labeler: 'bo' }, 2)
    await write(f, { critique: 'Bo wrote this.', labeler: 'bo' }, 3)
    expect(await suggest(f, `criterion=${C}&verdict=fail&labeler=ann`)).toEqual({ suggestions: ['Ann wrote this.'], fromOtherLabelers: false })
    expect(await suggest(f, `criterion=${C}&verdict=fail&labeler=${encodeURIComponent(' bo ')}`)).toEqual({ suggestions: ['Bo wrote this.'], fromOtherLabelers: false })
    expect(await suggest(f, `criterion=${C}&verdict=fail&labeler=cy`)).toEqual({ suggestions: ['Bo wrote this.', 'Ann wrote this.'], fromOtherLabelers: true })
    expect(await suggest(f, `criterion=${C}&verdict=fail`)).toEqual({ suggestions: ['Bo wrote this.', 'Ann wrote this.'], fromOtherLabelers: false })
    // Nothing from anyone is no fallback.
    expect(await suggest(f, `criterion=${C}&verdict=pass&labeler=cy`)).toEqual({ suggestions: [], fromOtherLabelers: false })
  })

  it('leaves out critiques over 300 characters', async () => {
    const f = await empty()
    await write(f, { critique: 'y'.repeat(301) }, 1)
    await write(f, { critique: 'y'.repeat(301) }, 2)
    await write(f, { critique: 'z'.repeat(300) }, 3)
    expect((await suggest(f, `criterion=${C}&verdict=fail`)).suggestions).toEqual(['z'.repeat(300)])
  })

  it('uses the current label of a revised item, and can leave one item out', async () => {
    const f = await seeded()
    const item = (await queue(f, '?limit=200')).items.find(i => i.criterion.id === C)!
    await f.api.post('/api/labels', labelBody(item.itemId, { critique: 'First thought.' }))
    expect((await suggest(f, `criterion=${C}&verdict=fail`)).suggestions).toEqual(['First thought.'])
    await f.api.post(`/api/labels/${encodeURIComponent(item.itemId)}/revise`, { labeler: 'ann', verdict: 'pass', critique: 'Second thought.' })
    expect((await suggest(f, `criterion=${C}&verdict=fail`)).suggestions).toEqual([])
    expect((await suggest(f, `criterion=${C}&verdict=pass`)).suggestions).toEqual(['Second thought.'])
    expect((await suggest(f, `criterion=${C}&verdict=pass&exclude=${encodeURIComponent(item.itemId)}`)).suggestions).toEqual([])
  })

  it('never includes the judge\'s critiques', async () => {
    const f = await seeded()
    const items = (await queue(f, '?limit=200')).items
    for (const item of items.slice(0, 4)) await f.api.post('/api/labels', labelBody(item.itemId, { critique: `Mine for ${item.itemId}` }))
    for (const c of CRITERIA) {
      for (const v of ['pass', 'fail']) {
        const r = await f.api.get(`/api/labels/suggestions?criterion=${c}&verdict=${v}`)
        expect(r.text).not.toContain('JUDGE-CRITIQUE')
      }
    }
  })

  it('refuses a missing criterion or a bad verdict, and a corrupt file', async () => {
    const f = await seeded()
    for (const q of ['verdict=fail', `criterion=${C}`, `criterion=${C}&verdict=maybe`, '']) {
      const r = await f.api.get(`/api/labels/suggestions?${q}`)
      expect(r.status, q).toBe(400)
      expect(r.json().error.code).toBe('bad_request')
    }
    writeFileSync(labelsFile(f), 'not json\n')
    expect((await f.api.get(`/api/labels/suggestions?criterion=${C}&verdict=fail`)).json().error.code).toBe('corrupt_record')
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
