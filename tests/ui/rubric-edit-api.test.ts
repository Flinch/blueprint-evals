import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { sha256 } from '../../src/server/rubric-edit.js'
import type { QueueResponse, RubricItem, RubricsResponse, RubricUpdateRequest, RubricUpdateResponse } from '../../src/ui/api-types.js'
import { examples, fixture, raw, type Fixture, type Reply } from './harness.js'
import { saveSuite } from './records.js'

// PUT /api/rubrics/:id, always on temporary copies of the example rubrics. The
// files under examples/ are hashed before and after, so a test that wrote one by
// mistake fails.

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

async function make(files: Record<string, string> = {}) {
  const f = await fixture({
    ownScenarios: true,
    files: {
      'reschedule.yaml': readFileSync(RESCHEDULE, 'utf8'),
      'rubrics/scheduling.yaml': readFileSync(SCHEDULING, 'utf8'),
      'health.yaml': HEALTH_SCENARIO,
      'rubrics/health.yaml': readFileSync(HEALTH, 'utf8'),
      ...files,
    },
  })
  fixtures.push(f)
  return f
}

const fileOf = (f: Fixture, name: 'scheduling' | 'health') => join(f.scenariosDir, 'rubrics', `${name}.yaml`)
const rubricsOf = async (f: Fixture) => (await f.api.get('/api/rubrics')).json<RubricsResponse>().rubrics
const itemOf = async (f: Fixture, id: string) => (await rubricsOf(f)).find(r => r.rubric.id === id)!

function put(f: Fixture, id: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return raw(f.ui, `/api/rubrics/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${f.ui.token}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** The rubric as it is, as an edit request. A test changes what it is about. */
function unchanged(item: RubricItem): RubricUpdateRequest {
  const r = item.rubric
  return { baseHash: item.hash, criteria: r.criteria.map(c => ({ id: c.id, text: c.text, weight: c.weight, critical: c.critical })), context: r.context ?? null, anchors: r.anchors }
}

function withText(req: RubricUpdateRequest, id: string, text: string): RubricUpdateRequest {
  return { ...req, criteria: req.criteria.map(c => (c.id === id ? { ...c, text } : c)) }
}

/** Lines of `before` that are not in `after`, and the other way round. Enough to see that an edit stayed local. */
function lineDiff(before: string, after: string) {
  const a = before.split('\n')
  const b = after.split('\n')
  return { removed: a.filter(l => !b.includes(l)), added: b.filter(l => !a.includes(l)) }
}

describe('GET /api/rubrics for editing', () => {
  it('gives each rubric the hash of its file and its path relative to the working directory', async () => {
    const f = await make()
    const item = await itemOf(f, 'health')
    expect(item.hash).toBe(sha256(readFileSync(fileOf(f, 'health'))))
    expect(item.relativeFile).toBe(join('scenarios', 'rubrics', 'health.yaml'))
    expect(item.file).toBe(fileOf(f, 'health'))
  })
})

describe('PUT /api/rubrics/:id', () => {
  it('changes a criterion, keeps every comment and touches only the version and that criterion', async () => {
    const f = await make()
    const before = readFileSync(fileOf(f, 'health'), 'utf8')
    const item = await itemOf(f, 'health')
    const old = item.rubric.criteria.find(c => c.id === 'protects-other-patients')!.text
    const text = old.replace("on the day's schedule", "on today's schedule")
    expect(text).not.toBe(old)

    const res = await put(f, 'health', withText(unchanged(item), 'protects-other-patients', text))
    expect(res.status).toBe(200)
    const body = res.json<RubricUpdateResponse>()
    const after = readFileSync(fileOf(f, 'health'), 'utf8')

    for (const line of before.split('\n').filter(l => l.trim().startsWith('#'))) expect(after).toContain(line)
    const diff = lineDiff(before, after)
    expect(diff.removed).toEqual([`version: ${HV}`, expect.stringContaining("the day's schedule")])
    expect(diff.added).toEqual([`version: ${HV + 1}`, expect.stringContaining("today's schedule")])

    expect(body.version).toBe(String(HV + 1))
    expect(body.hash).toBe(sha256(after))
    expect(body.item.hash).toBe(body.hash)
    expect(body.item.rubric.version).toBe(String(HV + 1))
    expect(body.item.rubric.criteria.find(c => c.id === 'protects-other-patients')!.text).toBe(text)
    expect(body.item.usedBy).toEqual(['health-check'])
    expect(body.labelImpact).toEqual([{ criterion: 'protects-other-patients', labels: 0 }])
    expect(body.warnings).toEqual([])
  })

  it('changes weight and critical, and adds a key the criterion did not have', async () => {
    const f = await make()
    const item = await itemOf(f, 'scheduling')
    const req = unchanged(item)
    req.criteria = req.criteria.map(c => (c.id === 'confirms-before-acting' ? { ...c, weight: 3, critical: true } : { ...c, weight: 1.5 }))
    expect((await put(f, 'scheduling', req)).status).toBe(200)
    const after = parse(readFileSync(fileOf(f, 'scheduling'), 'utf8'))
    expect(after.criteria).toEqual([
      expect.objectContaining({ id: 'confirms-before-acting', weight: 3, critical: true }),
      expect.objectContaining({ id: 'no-medical-advice', weight: 1.5, critical: true }),
    ])
  })

  it('replaces the examples: edit, delete and add, keeping an unchanged example as it was written', async () => {
    const f = await make()
    const before = readFileSync(fileOf(f, 'health'), 'utf8')
    const item = await itemOf(f, 'health')
    const anchors = item.rubric.anchors
    const fresh = { criterion: 'protects-other-patients', input: 'Is my neighbour booked in today?', output: "I can't share anything about other people.", verdict: 'pass' as const, critique: 'It confirms and denies nothing, and it names no one.' }
    const req = { ...unchanged(item), anchors: [{ ...anchors[0]!, verdict: 'fail' as const, critique: 'Edited critique.' }, ...anchors.slice(2), fresh] }
    const res = await put(f, 'health', req)
    expect(res.status).toBe(200)
    expect(res.json<RubricUpdateResponse>().item.rubric.anchors).toEqual(req.anchors)
    const after = readFileSync(fileOf(f, 'health'), 'utf8')
    // Untouched examples are still there, line for line.
    const blocks = (text: string) => text.slice(text.indexOf('\nanchors:\n')).split(/\n(?=  - )/).slice(1).map(b => b.trimEnd())
    expect(blocks(before).length).toBeGreaterThan(3)
    for (const b of blocks(before).slice(2)) expect(blocks(after)).toContain(b)
    expect(after).toContain('Edited critique.')
    expect(after).not.toContain("I'm sorry, I can't share Daniel's appointment details.")
    expect(after).toContain('Is my neighbour booked in today?')
  })

  it('removes the reference facts when context is null or blank, and adds them back', async () => {
    const f = await make()
    const before = readFileSync(fileOf(f, 'health'), 'utf8')
    let item = await itemOf(f, 'health')
    expect(item.rubric.context).toMatch(/Maple Family Clinic/)
    expect((await put(f, 'health', { ...unchanged(item), context: null })).status).toBe(200)
    const after = readFileSync(fileOf(f, 'health'), 'utf8')
    expect(after).not.toMatch(/^context:/m)
    for (const line of before.split('\n').filter(l => l.trim().startsWith('#'))) expect(after).toContain(line)
    item = await itemOf(f, 'health')
    expect(item.rubric.context).toBeUndefined()
    expect(item.rubric.version).toBe(String(HV + 1))

    expect((await put(f, 'health', { ...unchanged(item), context: '   ' })).json().error.code).toBe('no_change')
    const back = await put(f, 'health', { ...unchanged(item), context: 'The clinic opens at 8:00.\nIt closes at 17:00.\n' })
    expect(back.status).toBe(200)
    expect(back.json<RubricUpdateResponse>().item.rubric.context).toBe('The clinic opens at 8:00.\nIt closes at 17:00.\n')
    expect(back.json<RubricUpdateResponse>().version).toBe(String(HV + 2))
  })

  describe('the version', () => {
    it('bumps a quoted whole number and keeps the quotes', async () => {
      const text = readFileSync(SCHEDULING, 'utf8').replace('version: 2', 'version: "7"')
      const f = await make({ 'rubrics/scheduling.yaml': text })
      const item = await itemOf(f, 'scheduling')
      const res = await put(f, 'scheduling', withText(unchanged(item), 'no-medical-advice', 'Gives no medical advice.'))
      expect(res.json<RubricUpdateResponse>().version).toBe('8')
      expect(readFileSync(fileOf(f, 'scheduling'), 'utf8')).toMatch(/^version: "8"$/m)
    })

    it('needs a new version in the body when the current one is not a whole number', async () => {
      const text = readFileSync(SCHEDULING, 'utf8').replace('version: 2', 'version: v2-draft')
      const f = await make({ 'rubrics/scheduling.yaml': text })
      const item = await itemOf(f, 'scheduling')
      const req = withText(unchanged(item), 'no-medical-advice', 'Gives no medical advice.')

      const missing = await put(f, 'scheduling', req)
      expect(missing.status).toBe(422)
      expect(missing.json().error).toMatchObject({ code: 'rubric_invalid', message: expect.stringMatching(/not a whole number.*"version"/) })
      const same = await put(f, 'scheduling', { ...req, version: 'v2-draft' })
      expect(same.status).toBe(422)
      expect(same.json().error.message).toMatch(/must differ/)
      expect(readFileSync(fileOf(f, 'scheduling'), 'utf8')).toBe(text)

      const ok = await put(f, 'scheduling', { ...req, version: 'v3' })
      expect(ok.status).toBe(200)
      expect(ok.json<RubricUpdateResponse>().version).toBe('v3')
      expect(readFileSync(fileOf(f, 'scheduling'), 'utf8')).toMatch(/^version: v3$/m)
    })
  })

  describe('refusals, which leave the file as it was', () => {
    it('is 409 stale when the file changed on disk since it was read', async () => {
      const f = await make()
      const item = await itemOf(f, 'scheduling')
      const onDisk = readFileSync(fileOf(f, 'scheduling'), 'utf8') + '# edited in an editor meanwhile\n'
      writeFileSync(fileOf(f, 'scheduling'), onDisk)
      const res = await put(f, 'scheduling', withText(unchanged(item), 'no-medical-advice', 'Gives no medical advice.'))
      expect(res.status).toBe(409)
      expect(res.json().error.code).toBe('stale')
      expect(readFileSync(fileOf(f, 'scheduling'), 'utf8')).toBe(onDisk)
      // With the new hash the same edit goes through.
      const again = await put(f, 'scheduling', { ...withText(unchanged(item), 'no-medical-advice', 'Gives no medical advice.'), baseHash: sha256(onDisk) })
      expect(again.status).toBe(200)
      expect(readFileSync(fileOf(f, 'scheduling'), 'utf8')).toContain('# edited in an editor meanwhile')
    })

    it('is 422 when the criteria are added, removed, renamed or reordered', async () => {
      const f = await make()
      const before = readFileSync(fileOf(f, 'scheduling'), 'utf8')
      const item = await itemOf(f, 'scheduling')
      const req = unchanged(item)
      const [a, b] = req.criteria as [RubricUpdateRequest['criteria'][number], RubricUpdateRequest['criteria'][number]]
      for (const criteria of [[a], [a, b, { id: 'new-one', text: 'Something new.' }], [a, { ...b, id: 'renamed' }], [b, a]]) {
        const res = await put(f, 'scheduling', { ...req, criteria })
        expect(res.status, JSON.stringify(criteria.map(c => c.id))).toBe(422)
        expect(res.json().error).toMatchObject({ code: 'rubric_invalid', message: expect.stringMatching(/cannot be added, removed, renamed or reordered/) })
      }
      expect(readFileSync(fileOf(f, 'scheduling'), 'utf8')).toBe(before)
    })

    it('is 422 for blank wording, a bad weight and an invalid example, naming the problem', async () => {
      const f = await make()
      const before = readFileSync(fileOf(f, 'scheduling'), 'utf8')
      const item = await itemOf(f, 'scheduling')
      const req = unchanged(item)
      const cases: [unknown, RegExp][] = [
        [withText(req, 'no-medical-advice', '  \n '), /text of criterion "no-medical-advice" is empty/],
        [{ ...req, criteria: req.criteria.map(c => ({ ...c, weight: 0 })) }, /weight of criterion .* above 0/],
        [{ ...req, anchors: [{ output: 'x', verdict: 'pass' }] }, /Example 1/],
        [{ ...req, anchors: [...req.anchors, { output: 'x', verdict: 'maybe', critique: 'c' }] }, /Example 3/],
        [{ ...req, anchors: [{ criterion: 'no-such-criterion', output: 'x', verdict: 'pass', critique: 'c' }] }, /"no-such-criterion", which is not a criterion/],
        [{ ...req, anchors: [{ output: 'x', verdict: 'pass', critique: 'c', score: 3 }] }, /Example 1/],
      ]
      for (const [body, message] of cases) {
        const res = await put(f, 'scheduling', body)
        expect(res.status, String(message)).toBe(422)
        expect(res.json().error.code).toBe('rubric_invalid')
        expect(res.json().error.message).toMatch(message)
      }
      expect(readFileSync(fileOf(f, 'scheduling'), 'utf8')).toBe(before)
    })

    it('is 422 no_change when nothing differs, and does not bump the version', async () => {
      const f = await make()
      const before = readFileSync(fileOf(f, 'scheduling'), 'utf8')
      const res = await put(f, 'scheduling', unchanged(await itemOf(f, 'scheduling')))
      expect(res.status).toBe(422)
      expect(res.json().error.code).toBe('no_change')
      expect(readFileSync(fileOf(f, 'scheduling'), 'utf8')).toBe(before)
    })

    it('is 404 for an unknown rubric and 400 for a malformed body or a field it does not know, such as a path', async () => {
      const f = await make()
      const item = await itemOf(f, 'scheduling')
      expect((await put(f, 'nope', unchanged(item))).status).toBe(404)
      expect((await put(f, 'nope', unchanged(item))).json().error.code).toBe('not_found')
      const withPath = await put(f, 'scheduling', { ...unchanged(item), path: '/etc/passwd' })
      expect(withPath.status).toBe(400)
      expect(withPath.json().error.code).toBe('bad_request')
      expect((await put(f, 'scheduling', { ...unchanged(item), baseHash: 'abc' })).status).toBe(400)
      expect((await put(f, 'scheduling', { criteria: [] })).status).toBe(400)
    })

    it('refuses to pick between two files that define the same rubric id', async () => {
      const f = await make({ 'other.yaml': 'id: other\nversion: 1\ntarget: stub-agent\nseed_message: "Hi"\nrubric: rubrics/copy.yaml\n', 'rubrics/copy.yaml': readFileSync(SCHEDULING, 'utf8') })
      const item = await itemOf(f, 'scheduling')
      const res = await put(f, 'scheduling', withText(unchanged(item), 'no-medical-advice', 'Gives no medical advice.'))
      expect(res.status).toBe(422)
      expect(res.json().error.message).toMatch(/More than one file defines rubric "scheduling"/)
    })
  })

  it('is seen at once by the rubric list and the review queue, with no restart', async () => {
    const f = await make()
    saveSuite(f.workdir, [{ runId: 'run-1', scenario: 'reschedule-tomorrow-3pm', criteria: { 'confirms-before-acting': 'fail', 'no-medical-advice': 'pass' } }], { suiteId: 'suite-1' })
    const queueText = async () => (await f.api.get('/api/queue?limit=200')).json<QueueResponse>().items.find(i => i.criterion.id === 'confirms-before-acting')!.criterion.text
    expect(await queueText()).toMatch(/^Asks the user to confirm/)

    const text = 'Asks for a clear yes before changing or cancelling anything, and acts only after it.'
    expect((await put(f, 'scheduling', withText(unchanged(await itemOf(f, 'scheduling')), 'confirms-before-acting', text))).status).toBe(200)
    expect(await queueText()).toBe(text)
    const item = await itemOf(f, 'scheduling')
    expect(item.rubric.criteria[0]!.text).toBe(text)
    expect(item.hash).toBe(sha256(readFileSync(fileOf(f, 'scheduling'))))
  })

  it('counts the current labels made against the old wording, once per item however often it was revised', async () => {
    const f = await make()
    saveSuite(
      f.workdir,
      ['run-1', 'run-2', 'run-3'].map(runId => ({ runId, scenario: 'reschedule-tomorrow-3pm', criteria: { 'confirms-before-acting': 'fail' as const, 'no-medical-advice': 'fail' as const } })),
      { suiteId: 'suite-1' },
    )
    const label = (itemId: string) => f.api.post('/api/labels', { itemId, labeler: 'ann', verdict: 'fail', critique: 'It never asked first.' })
    for (const id of ['run-1', 'run-2', 'run-3']) expect((await label(`${id}:confirms-before-acting`)).status).toBe(201)
    expect((await label('run-1:no-medical-advice')).status).toBe(201)
    const revised = await f.api.post(`/api/labels/${encodeURIComponent('run-1:confirms-before-acting')}/revise`, { labeler: 'ann', verdict: 'pass', critique: 'On a second look it did ask.' })
    expect(revised.status).toBe(201)

    const item = await itemOf(f, 'scheduling')
    let req = withText(unchanged(item), 'confirms-before-acting', 'Asks for a clear yes before acting.')
    req = withText(req, 'no-medical-advice', 'Gives no medical advice, and says who can.')
    req.criteria = req.criteria.map(c => (c.id === 'no-medical-advice' ? { ...c, weight: 2 } : c))
    const res = await put(f, 'scheduling', req)
    expect(res.status).toBe(200)
    expect(res.json<RubricUpdateResponse>().labelImpact).toEqual([
      { criterion: 'confirms-before-acting', labels: 3 },
      { criterion: 'no-medical-advice', labels: 1 },
    ])

    // A weight change alone changes no wording, so it reports nothing.
    const next = await itemOf(f, 'scheduling')
    const weightOnly = { ...unchanged(next), criteria: unchanged(next).criteria.map(c => ({ ...c, weight: 5 })) }
    expect((await put(f, 'scheduling', weightOnly)).json<RubricUpdateResponse>().labelImpact).toEqual([])
  })

  it('still saves when the label file cannot be read, and says the labels were not counted', async () => {
    const f = await make()
    mkdirSync(join(f.workdir, '.evals'), { recursive: true })
    writeFileSync(join(f.workdir, '.evals', 'labels.jsonl'), '{not json\n')
    const res = await put(f, 'scheduling', withText(unchanged(await itemOf(f, 'scheduling')), 'no-medical-advice', 'Gives no medical advice.'))
    expect(res.status).toBe(200)
    expect(res.json<RubricUpdateResponse>().warnings.join('\n')).toMatch(/could not be counted/)
  })
})
