import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseLabels } from '../../src/index.js'
import {
  appendLabel, buildQueue, createSuiteWriter, DuplicateLabelError, findQueueItem, findRun, InvalidIdError, labelStats, LabelValidationError, listLabels, listSuites,
  readSuite, readSuites, revealItem, storePaths, summarize, writeFileAtomic, type QueueItem, type RubricLookup,
} from '../../src/store/index.js'
import { label } from '../label-helpers.js'
import { critiqueOf, runResult, saveSuite, type RunSpec } from './records.js'
import { tempDir } from './harness.js'

describe('suite store', () => {
  const setup = () => {
    const workdir = tempDir('evals-store-')
    return { workdir, runs: storePaths(workdir).runs }
  }

  it('writes the record up front and after every run, atomically, so a crash leaves partial data', () => {
    const { runs } = setup()
    const w = createSuiteWriter({ dir: runs, command: 'evals run x', configFile: '/c.yaml', scenarioPath: '/s', startedAt: new Date('2026-11-12T10:00:00Z') })
    expect(existsSync(w.file)).toBe(false)
    w.start()
    let record = JSON.parse(readFileSync(w.file, 'utf8'))
    expect(record).toMatchObject({ schemaVersion: 1, suiteId: w.suiteId, startedAt: '2026-11-12T10:00:00.000Z', endedAt: null, status: 'running', command: 'evals run x', configFile: '/c.yaml', scenarioPath: '/s', results: [] })
    expect(record.summary.runs).toBe(0)

    w.onEvent({ type: 'run:start', runId: 'r1', scenarioId: 'a' })
    expect(JSON.parse(readFileSync(w.file, 'utf8')).results).toHaveLength(0) // only finished runs are saved
    w.onEvent({ type: 'run:end', runId: 'r1', result: runResult({ runId: 'r1' }) })
    // "Crash" here: no finish(). The file already holds the first result.
    record = JSON.parse(readFileSync(w.file, 'utf8'))
    expect(record.results).toHaveLength(1)
    expect(record.endedAt).toBeNull()
    expect(readSuite(runs, w.suiteId)!.results[0]!.trace.runId).toBe('r1')
    // No temporary files are left behind.
    expect(readdirSync(runs).filter(n => n.endsWith('.tmp'))).toEqual([])

    w.finish()
    record = JSON.parse(readFileSync(w.file, 'utf8'))
    expect(record.status).toBe('complete')
    expect(record.endedAt).not.toBeNull()
  })

  it('records cancelled and failed endings', () => {
    const { runs } = setup()
    const a = createSuiteWriter({ dir: runs, command: 'c', configFile: 'x', scenarioPath: 'y' })
    a.start()
    expect(a.finish({ cancelled: true }).status).toBe('cancelled')
    const b = createSuiteWriter({ dir: runs, command: 'c', configFile: 'x', scenarioPath: 'y' })
    b.start()
    expect(b.finish({ failed: true }).status).toBe('failed')
  })

  it('a failing write never fails the run it records, and is reported as a warning', () => {
    const { workdir } = setup()
    const blocked = join(workdir, 'blocker')
    writeFileSync(blocked, 'a file where the directory should be')
    const w = createSuiteWriter({ dir: join(blocked, 'runs'), command: 'c', configFile: 'x', scenarioPath: 'y' })
    expect(() => w.start()).toThrow()
    expect(() => w.onEvent({ type: 'run:end', runId: 'r', result: runResult({ runId: 'r' }) })).not.toThrow()
    expect(w.warnings.length).toBe(1)
  })

  it('writeFileAtomic replaces the target in one step and cleans up if it fails', () => {
    const dir = tempDir()
    const file = join(dir, 'a.json')
    writeFileAtomic(file, '1')
    writeFileAtomic(file, '2')
    expect(readFileSync(file, 'utf8')).toBe('2')
    expect(() => writeFileAtomic(join(file, 'nested', 'b.json'), 'x')).toThrow()
    expect(readdirSync(dir)).toEqual(['a.json'])
  })

  it('lists newest first, and skips corrupt files with a warning instead of throwing', () => {
    const { workdir, runs } = setup()
    saveSuite(workdir, [{ runId: 'a' }], { startedAt: '2026-11-10T00:00:00Z', suiteId: 'old' })
    saveSuite(workdir, [{ runId: 'b' }], { startedAt: '2026-11-12T00:00:00Z', suiteId: 'new' })
    writeFileSync(join(runs, 'garbage.json'), '{not json')
    writeFileSync(join(runs, 'truncated.json'), '{"schemaVersion":1,"suiteId":"truncated","startedAt":"x"')
    writeFileSync(join(runs, 'wrong-shape.json'), JSON.stringify({ schemaVersion: 1, suiteId: 'wrong-shape', results: 'nope' }))
    writeFileSync(join(runs, 'mismatch.json'), readFileSync(join(runs, 'new.json'), 'utf8'))
    writeFileSync(join(runs, 'notes.txt'), 'ignored')
    writeFileSync(join(runs, '.partial.json.1234.tmp'), 'ignored')

    const listing = listSuites(runs)
    expect(listing.suites.map(s => s.suiteId)).toEqual(['new', 'old'])
    expect(listing.warnings).toHaveLength(4)
    expect(listing.warnings.join('\n')).toMatch(/garbage\.json/)
    expect(listing.warnings.join('\n')).toMatch(/mismatch\.json.*does not match the file name/)
    expect(() => readSuite(runs, 'garbage')).toThrow(/not valid JSON/)
    expect(readSuite(runs, 'nothing-here')).toBeNull()
    // readSuites skips them as well.
    const all = readSuites(runs, 10)
    expect(all.suites.map(s => s.suiteId)).toEqual(['new', 'old'])
    expect(all.warnings.length).toBeGreaterThanOrEqual(4)
  })

  it('treats a missing directory as an empty store', () => {
    expect(listSuites(join(tempDir(), 'nope'))).toEqual({ suites: [], warnings: [] })
  })

  it('refuses ids that could escape the directory', () => {
    const { runs } = setup()
    for (const id of ['..', '../x', 'a/b', 'a\\b', '', '.hidden', 'a..b', 'x\0y', '/etc/passwd', 'a'.repeat(200)]) {
      expect(() => readSuite(runs, id), JSON.stringify(id)).toThrow(InvalidIdError)
      expect(() => findRun(runs, id), JSON.stringify(id)).toThrow(InvalidIdError)
      expect(() => createSuiteWriter({ dir: runs, command: 'c', configFile: 'x', scenarioPath: 'y', suiteId: id })).toThrow(InvalidIdError)
    }
  })

  it('finds a run in any suite by its id, and notices a changed file', () => {
    const { workdir, runs } = setup()
    saveSuite(workdir, [{ runId: 'run-1' }], { suiteId: 's1', startedAt: '2026-11-10T00:00:00Z' })
    expect(findRun(runs, 'run-1')?.suiteId).toBe('s1')
    expect(findRun(runs, 'run-9')).toBeNull()
    saveSuite(workdir, [{ runId: 'run-1' }, { runId: 'run-9' }], { suiteId: 's1', startedAt: '2026-11-10T00:00:00Z' })
    expect(findRun(runs, 'run-9')?.suiteId).toBe('s1')
  })

  it('summarises with a null-safe cost and a goal rate', () => {
    const s = summarize([runResult({ runId: 'a', costUsd: 0.5, goalAchieved: true }), runResult({ runId: 'b', costUsd: 0.25, goalAchieved: false, criteria: { c: 'fail' } })])
    expect(s).toMatchObject({ runs: 2, pass: 1, fail: 1, error: 0, costUsd: 0.75, goal: { achieved: 1, total: 2 } })
    expect(summarize([runResult({ runId: 'a', costUsd: 0.5 }), runResult({ runId: 'b', costUsd: null })]).costUsd).toBeNull()
    expect(summarize([])).toMatchObject({ runs: 0, costUsd: 0, avgScore: null })
  })
})

describe('label file', () => {
  const file = () => join(tempDir('evals-labels-'), 'labels.jsonl')
  const good = (over: Record<string, unknown> = {}) => {
    const { at: _at, ...rest } = label({ id: 'a' })
    return { ...rest, ...over }
  }

  it('appends valid labels the calibration can read back, and never rewrites what is there', () => {
    const f = file()
    appendLabel(f, good({ id: 'a' }))
    const first = readFileSync(f, 'utf8')
    appendLabel(f, good({ id: 'b', verdict: 'pass' }))
    const text = readFileSync(f, 'utf8')
    expect(text.startsWith(first)).toBe(true)
    expect(parseLabels(text).map(l => l.id)).toEqual(['a', 'b'])
    expect(listLabels(f).map(l => l.id)).toEqual(['a', 'b'])
    expect(listLabels(join(tempDir(), 'missing.jsonl'))).toEqual([])
  })

  it('repairs a missing final newline instead of gluing two labels together', () => {
    const f = file()
    appendLabel(f, good({ id: 'a' }))
    writeFileSync(f, readFileSync(f, 'utf8').trimEnd())
    appendLabel(f, good({ id: 'b' }))
    expect(listLabels(f).map(l => l.id)).toEqual(['a', 'b'])
  })

  it('rejects a duplicate id, a split field, a missing critique and unknown fields', () => {
    const f = file()
    appendLabel(f, good({ id: 'a' }))
    expect(() => appendLabel(f, good({ id: 'a' }))).toThrow(DuplicateLabelError)
    expect(() => appendLabel(f, good({ id: 'x', split: 'test' }))).toThrow(/"split" is not a label field/)
    expect(() => appendLabel(f, good({ id: 'x', critique: '' }))).toThrow(LabelValidationError)
    expect(() => appendLabel(f, good({ id: 'x', critique: undefined }))).toThrow(/critique/)
    expect(() => appendLabel(f, good({ id: 'x', verdict: 'maybe' }))).toThrow(/verdict/)
    expect(() => appendLabel(f, good({ id: 'x', extra: 1 }))).toThrow(LabelValidationError)
    expect(() => appendLabel(f, 'nope')).toThrow(/JSON object/)
    expect(listLabels(f)).toHaveLength(1)
  })

  it('refuses to append to a file that is already broken, rather than hiding it', () => {
    const f = file()
    appendLabel(f, good({ id: 'a' }))
    appendFileSync(f, 'not json\n')
    expect(() => appendLabel(f, good({ id: 'b' }))).toThrow(/not valid JSON/)
  })

  it('computes stats including the random share and the split counts', () => {
    const stats = labelStats([label({ id: 'a', sampled_by: 'random' }), label({ id: 'b', sampled_by: 'targeted' }), label({ id: 'c', sampled_by: 'targeted', verdict: 'pass' })])
    expect(stats).toMatchObject({ total: 3, random: 1, targeted: 2, byVerdict: { pass: 1, fail: 2 }, labelers: ['expert-1'], minRandomShare: 0.3 })
    expect(stats.randomShare).toBeCloseTo(1 / 3)
    expect(stats.warnings.join(' ')).not.toMatch(/Only/)
    expect(labelStats([label({ id: 'a', sampled_by: 'targeted' })]).warnings.join(' ')).toMatch(/Only 0% of labels were randomly sampled/)
  })
})

// A synthetic store: 20 runs, two criteria each. Even runs fail "c-fail", all pass "c-pass".
function population(runs = 20) {
  const specs: RunSpec[] = Array.from({ length: runs }, (_, i) => ({
    runId: `run-${String(i).padStart(2, '0')}`,
    criteria: { 'c-fail': i % 2 === 0 ? 'fail' : 'pass', 'c-pass': 'pass' },
    tags: i % 2 === 0 ? ['x'] : ['y'],
  }))
  const workdir = tempDir('evals-queue-')
  const suite = saveSuite(workdir, specs, { suiteId: 'suite-1' })
  return { workdir, suites: [suite], specs }
}
const rubricFor: RubricLookup = () => ({ criteria: [{ id: 'c-fail', text: 'The first rubric text.', critical: false }, { id: 'c-pass', text: 'The second rubric text.', critical: true }] })

describe('review queue', () => {
  it('never carries the judge verdict or critique, in any field of any item', () => {
    const { suites } = population()
    const queue = buildQueue({ suites, labels: [], rubricFor, limit: 100 })
    expect(queue.items.length).toBeGreaterThan(0)
    const text = JSON.stringify(queue)
    expect(text).not.toContain('JUDGE-CRITIQUE')
    expect(text).not.toMatch(/critique/i)
    expect(text).not.toMatch(/"verdict"/)
    expect(text).not.toMatch(/"judge/i)
    for (const item of queue.items) {
      expect(Object.keys(item).sort()).toEqual(['context', 'criterion', 'group', 'input', 'itemId', 'output', 'outputTurn', 'reason', 'runId', 'scenarioId', 'suiteId'])
      expect(Object.keys(item.criterion).sort()).toEqual(['critical', 'id', 'text'])
    }
  })

  it('builds one item per run and criterion, with the input, output, group and rubric text', () => {
    const { suites } = population(4)
    const q = buildQueue({ suites, labels: [], rubricFor, limit: 100, minRandomShare: 1 })
    expect(q.items).toHaveLength(8)
    const item = q.items.find(i => i.itemId === 'run-00:c-fail')!
    expect(item).toMatchObject({
      suiteId: 'suite-1', runId: 'run-00', scenarioId: 'scenario-a', input: 'Question for run-00', output: 'Answer for run-00', group: 'run-00', outputTurn: 1,
      criterion: { id: 'c-fail', text: 'The first rubric text.', critical: false },
    })
    expect(item.context).toEqual([{ index: 0, role: 'user', content: 'Question for run-00' }])
    // Without a rubric the text is unknown, and the item is still there.
    const bare = buildQueue({ suites, labels: [], limit: 100, minRandomShare: 1 })
    expect(bare.items.find(i => i.itemId === 'run-00:c-fail')!.criterion.text).toBeNull()
  })

  it('uses the final assistant reply as the output and renders everything before it as the input', () => {
    const workdir = tempDir()
    const suite = saveSuite(workdir, [{
      runId: 'multi', criteria: { 'c-fail': 'fail' },
      turns: [{ role: 'user', content: 'first ask' }, { role: 'assistant', content: 'a clarifying question' }, { role: 'user', content: 'my answer' }, { role: 'assistant', content: 'final reply' }],
    }])
    const [item] = buildQueue({ suites: [suite], labels: [], limit: 5 }).items
    expect(item!.output).toBe('final reply')
    expect(item!.input).toContain('first ask')
    expect(item!.input).toContain('a clarifying question')
    expect(item!.input).toContain('my answer')
    expect(item!.context).toHaveLength(3)
    expect(item!.outputTurn).toBe(3)
  })

  it('skips runs with nothing to label', () => {
    const workdir = tempDir()
    const suite = saveSuite(workdir, [{ runId: 'silent', criteria: { 'c-fail': 'fail' }, turns: [{ role: 'user', content: 'hello?' }] }])
    expect(buildQueue({ suites: [suite], labels: [] }).items).toEqual([])
  })

  it('excludes items that are already labelled', () => {
    const { suites } = population(6)
    const before = buildQueue({ suites, labels: [], limit: 100, minRandomShare: 1 })
    const labelled = label({ id: 'run-00:c-fail', group: 'run-00', sampled_by: 'targeted' })
    const after = buildQueue({ suites, labels: [labelled], limit: 100, minRandomShare: 1 })
    expect(after.items).toHaveLength(before.items.length - 1)
    expect(after.items.some(i => i.itemId === 'run-00:c-fail')).toBe(false)
    expect(after.stats.labelled).toBe(1)
  })

  describe('random quota', () => {
    it('makes at least 30 percent of everything up for review random, including judge passes', () => {
      const { suites } = population(20)
      const q = buildQueue({ suites, labels: [], limit: 1000 })
      const random = q.items.filter(i => i.reason === 'random')
      expect(q.items.length).toBe(q.stats.pending)
      expect(random.length / q.items.length).toBeGreaterThanOrEqual(0.3)
      // Random items come from the whole population: a judge pass can be one. Targeted ones are only judge failures.
      expect(random.length).toBe(Math.ceil(0.3 * 40))
      const targeted = q.items.filter(i => i.reason !== 'random')
      expect(targeted.every(i => i.reason === 'targeted-failure' && i.criterion.id === 'c-fail' && Number(i.runId.slice(4)) % 2 === 0)).toBe(true)
    })

    it('puts the quota in every page, not only the whole queue', () => {
      const { suites } = population(20)
      for (const limit of [3, 5, 10, 20]) {
        const q = buildQueue({ suites, labels: [], limit })
        const size = Math.min(limit, q.stats.pending)
        expect(q.items).toHaveLength(size)
        expect(q.items.filter(i => i.reason === 'random').length, `limit ${limit}`).toBeGreaterThanOrEqual(Math.ceil(0.3 * size))
      }
    })

    it('counts the labels already made, so a labeller who skipped random items is caught up', () => {
      const { suites } = population(20)
      // 10 labels, all targeted: 40 candidates + 10 labelled = 50, so 15 random are needed in total.
      const labels = Array.from({ length: 10 }, (_, i) => label({ id: `old-${i}`, sampled_by: 'targeted' }))
      const q = buildQueue({ suites, labels, limit: 1000 })
      expect(q.items.filter(i => i.reason === 'random')).toHaveLength(15)
      expect(q.stats.quotaMet).toBe(false)
      // With plenty of random labels already, no more are needed.
      const enough = Array.from({ length: 10 }, (_, i) => label({ id: `old-${i}`, sampled_by: 'random' }))
      const q2 = buildQueue({ suites, labels: enough, limit: 1000 })
      expect(q2.items.filter(i => i.reason === 'random')).toHaveLength(5)
      expect(q2.stats.quotaMet).toBe(true)
      const lots = Array.from({ length: 40 }, (_, i) => label({ id: `old-${i}`, sampled_by: 'random' }))
      expect(buildQueue({ suites, labels: lots, limit: 1000 }).items.some(i => i.reason === 'random')).toBe(false)
    })

    it('keeps the labels, once everything is done, at or above the share', () => {
      const { suites } = population(20)
      const labels: ReturnType<typeof label>[] = []
      for (let guard = 0; guard < 100; guard++) {
        const q = buildQueue({ suites, labels, limit: 4 })
        if (q.items.length === 0) break
        const item = q.items[0]!
        labels.push(label({ id: item.itemId, group: item.group, sampled_by: findQueueItem({ suites, labels, limit: 4 }, item.itemId).status === 'ok' ? (item.reason === 'random' ? 'random' : 'targeted') : 'targeted' }))
      }
      expect(labels.length).toBeGreaterThan(0)
      expect(labels.filter(l => l.sampled_by === 'random').length / labels.length).toBeGreaterThanOrEqual(0.3)
    })
  })

  describe('stable ordering', () => {
    const ids = (q: { items: QueueItem[] }) => q.items.map(i => `${i.itemId}/${i.reason}`)

    it('is identical on every call with the same data, and does not depend on suite order', () => {
      const { suites } = population(20)
      const a = buildQueue({ suites, labels: [], limit: 12 })
      expect(ids(buildQueue({ suites, labels: [], limit: 12 }))).toEqual(ids(a))
      const workdir = tempDir()
      const other = saveSuite(workdir, [{ runId: 'zzz-1', criteria: { 'c-fail': 'fail' } }], { suiteId: 'suite-2' })
      const both = buildQueue({ suites: [...suites, other], labels: [], limit: 1000 })
      const reversed = buildQueue({ suites: [other, ...suites], labels: [], limit: 1000 })
      expect(ids(reversed)).toEqual(ids(both))
    })

    it('changes with the seed, so the order is a shuffle and not the file order', () => {
      const { suites } = population(20)
      const a = ids(buildQueue({ suites, labels: [], limit: 1000, seed: 'one' }))
      const b = ids(buildQueue({ suites, labels: [], limit: 1000, seed: 'two' }))
      expect(a).not.toEqual(b)
      expect([...a].sort()).not.toEqual(a) // not sorted by id either
    })

    it('keeps the remaining items in the same relative order after one is labelled', () => {
      const { suites } = population(20)
      const full = buildQueue({ suites, labels: [], limit: 1000 })
      const first = full.items[0]!
      const after = buildQueue({ suites, labels: [label({ id: first.itemId, group: first.group, sampled_by: first.reason === 'random' ? 'random' : 'targeted' })], limit: 1000 })
      expect(ids(after)).toEqual(ids(full).slice(1))
    })

    it('does not let position reveal why an item is there', () => {
      const { suites } = population(40)
      const reasons = buildQueue({ suites, labels: [], limit: 1000 }).items.map(i => i.reason === 'random')
      // Random items are spread through the queue rather than bunched at the front or the back.
      const firstHalf = reasons.slice(0, reasons.length / 2).filter(Boolean).length
      const secondHalf = reasons.slice(reasons.length / 2).filter(Boolean).length
      expect(firstHalf).toBeGreaterThan(0)
      expect(secondHalf).toBeGreaterThan(0)
    })
  })

  it('targets an error run: criteria the judge never decided are queued for a human', () => {
    const workdir = tempDir()
    const suite = saveSuite(workdir, [{ runId: 'broke', status: 'error', error: 'judge timed out' }])
    const q = buildQueue({ suites: [suite], labels: [], rubricFor, limit: 10, minRandomShare: 0 })
    expect(q.items.map(i => `${i.criterion.id}/${i.reason}`).sort()).toEqual(['c-fail/targeted-error', 'c-pass/targeted-error'])
    expect(JSON.stringify(q)).not.toContain('timed out')
  })

  describe('reveal', () => {
    it('shows the judge verdict and critique for a labelled item, and whether the human agreed', () => {
      const { suites } = population(4)
      const find = (id: string) => ({ suiteId: 'suite-1', result: suites[0]!.results.find(r => r.trace.runId === id)! })
      const l = label({ id: 'run-00:c-fail', group: 'run-00', verdict: 'pass', critique: 'human view', labeler: 'ann' })
      const r = revealItem(l, find)!
      expect(r.judge).toEqual({ verdict: 'fail', critique: critiqueOf('run-00', 'c-fail'), critical: false, grader: 'rubric-judge(r@1)' })
      expect(r.human).toMatchObject({ verdict: 'pass', critique: 'human view', labeler: 'ann' })
      expect(r.agrees).toBe(false)
      expect(revealItem({ ...l, verdict: 'fail' }, find)!.agrees).toBe(true)
    })

    it('says so when the judge never decided, and returns null when the label is not for a queue item or the run is gone', () => {
      const workdir = tempDir()
      const suite = saveSuite(workdir, [{ runId: 'broke', status: 'error', error: 'judge timed out' }])
      const find = (id: string) => (id === 'broke' ? { suiteId: 's', result: suite.results[0]! } : null)
      const r = revealItem(label({ id: 'broke:c-fail' }), find)!
      expect(r.judge).toBeNull()
      expect(r.runError).toBe('judge timed out')
      expect(r.agrees).toBeNull()
      expect(revealItem(label({ id: 'hand-made' }), find)).toBeNull()
      expect(revealItem(label({ id: 'gone:c-fail' }), find)).toBeNull()
    })
  })
})
