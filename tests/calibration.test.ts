import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  anchorsFromLabels, ContaminationError, createFakeProvider, createRubricLabelJudge, evaluateJudge, formatReport, loadLabels,
  partition, RubricSchema, splitOf,
} from '../src/index.js'
import type { GradedLabel as Label, Label as AnyLabel, LabelJudge, LabelJudgement } from '../src/index.js'
import { idInSplit, label, syntheticLabels } from './label-helpers.js'

const judgeOf = (fn: (l: Label) => LabelJudgement | Promise<LabelJudgement>, anchors: LabelJudge['anchors'] = []): LabelJudge => ({
  name: 'fake-judge', anchors, judge: async l => fn(l),
})
const agrees = (l: Label): LabelJudgement => ({ verdict: l.verdict })

describe('evaluateJudge: what gets measured', () => {
  const labels = syntheticLabels(400)
  const { dev, test } = partition(labels)

  it('measures only the requested split, and only randomly sampled labels by default', async () => {
    const r = await evaluateJudge(labels, judgeOf(agrees), { split: 'dev' })
    const random = dev.filter(l => l.sampled_by === 'random')
    expect(r.inSplit).toBe(dev.length)
    expect(r.metrics.n).toBe(random.length)
    expect(r.excludedTargeted).toBe(dev.length - random.length)
    expect(r.items.every(i => splitOf({ id: i.id }) === 'dev')).toBe(true)
    expect(r.warnings.join(' ')).toMatch(/targeted dev label\(s\) were left out/)
  })

  it('can include targeted labels, and says the rates then describe the sample reviewed', async () => {
    const r = await evaluateJudge(labels, judgeOf(agrees), { split: 'test', selection: 'all' })
    expect(r.metrics.n).toBe(test.length)
    expect(r.excludedTargeted).toBe(0)
    expect(r.warnings.join(' ')).toMatch(/describe the sample reviewed/)
  })

  it('refuses the train split, since those labels may be in the prompt', async () => {
    await expect(evaluateJudge(labels, judgeOf(agrees), { split: 'train' as 'dev' })).rejects.toThrow(ContaminationError)
  })

  it('keeps "does not apply" labels out of the rates and the judging, and reports them by criterion', async () => {
    const devRandom = dev.filter(l => l.sampled_by === 'random')
    const na = devRandom.slice(0, 3).map(l => l.id)
    const withNa: AnyLabel[] = labels.map(l => (na.includes(l.id) ? { ...l, verdict: 'not_applicable' as const, critique: 'Nobody asked to book.' } : l))
    const seen: string[] = []
    const r = await evaluateJudge(withNa, judgeOf(l => (seen.push(l.id), agrees(l))), { split: 'dev' })
    expect(seen.some(id => na.includes(id))).toBe(false)
    expect(r.metrics.n).toBe(devRandom.length - 3)
    expect(r.inSplit).toBe(dev.length - 3)
    expect(r.notApplicable).toEqual({
      count: 3,
      byCriterion: { confirms: 3 },
      items: na.map(id => ({ id, criterion: 'confirms', critique: 'Nobody asked to book.' })),
    })
    expect(r.warnings.join(' ')).toMatch(/marked 3 dev item\(s\) as "does not apply" where the judge graded the criterion: confirms \(3\)/)
  })

  it('never turns a "does not apply" label into a few-shot example', () => {
    const train = partition(labels).train.slice(0, 2)
    const mixed: AnyLabel[] = [train[0]!, { ...train[1]!, verdict: 'not_applicable' }]
    expect(anchorsFromLabels(mixed).map(a => a.output)).toEqual([train[0]!.output])
  })

  it('computes the two rates against the expert, from what the judge actually said', async () => {
    // The judge misses every fourth expert-fail (passes it) and is otherwise right.
    let seenFails = 0
    const r = await evaluateJudge(labels, judgeOf(l => {
      if (l.verdict === 'fail' && seenFails++ % 4 === 0) return { verdict: 'pass' }
      return { verdict: l.verdict }
    }), { split: 'dev' })
    expect(r.metrics.tpr.rate).toBe(1)
    const fails = r.metrics.tnr.n
    expect(r.metrics.confusion.fp).toBe(Math.ceil(fails / 4))
    expect(r.metrics.tnr.rate).toBeCloseTo(1 - Math.ceil(fails / 4) / fails)
  })

  it('lists the disagreements with both critiques, so they can be read', async () => {
    const r = await evaluateJudge(labels, judgeOf(l => ({ verdict: l.verdict === 'pass' ? 'fail' : 'pass', critique: 'judge reasoning' })), { split: 'dev' })
    expect(r.disagreements).toHaveLength(r.items.length)
    expect(r.disagreements[0]).toMatchObject({ judgeCritique: 'judge reasoning', expertCritique: 'Acted without confirming.' })
  })

  it('reports an item the judge could not judge, and keeps it out of the rates', async () => {
    let n = 0
    const r = await evaluateJudge(labels, judgeOf(l => { if (n++ < 3) throw new Error('judge timed out'); return { verdict: l.verdict } }), { split: 'dev' })
    expect(r.errors).toHaveLength(3)
    expect(r.errors[0]).toMatchObject({ reason: 'judge timed out' })
    expect(r.metrics.n).toBe(r.items.length)
    expect(r.items.length + 3).toBe(dev.filter(l => l.sampled_by === 'random').length)
    expect(r.warnings.join(' ')).toMatch(/3 of \d+ items could not be judged/)
  })

  it('says so, instead of reporting zeros, when there is nothing to measure', async () => {
    const r = await evaluateJudge([], judgeOf(agrees), { split: 'dev' })
    expect(r.metrics.n).toBe(0)
    expect(r.warnings.join(' ')).toMatch(/no labels in the dev split/)
    const targetedOnly = [label({ id: idInSplit('dev'), sampled_by: 'targeted' })]
    expect((await evaluateJudge(targetedOnly, judgeOf(agrees), { split: 'dev' })).warnings.join(' ')).toMatch(/None of the 1 dev labels were randomly sampled/)
  })

  it('sums what the judge calls cost, and does not invent a total when a price is unknown', async () => {
    const priced = await evaluateJudge(labels, judgeOf(l => ({ verdict: l.verdict, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 } })), { split: 'dev' })
    expect(priced.usage.costUsd).toBeCloseTo(0.01 * priced.items.length)
    const unknown = await evaluateJudge(labels, judgeOf(l => ({ verdict: l.verdict, usage: { inputTokens: 1, outputTokens: 1, costUsd: null } })), { split: 'dev' })
    expect(unknown.usage.costUsd).toBeNull()
  })
})

describe('evaluateJudge: the contamination guard', () => {
  const devId = idInSplit('dev', 'g')
  const testId = idInSplit('test', 'g')
  const trainId = idInSplit('train', 'g')
  const labels = [
    label({ id: devId, output: 'dev response', input: 'dev q' }),
    label({ id: testId, output: 'test response', input: 'test q' }),
    label({ id: trainId, output: 'train response', input: 'train q' }),
  ]
  const anchorFrom = (l: Label) => ({ criterion: l.criterion, input: l.input, output: l.output, verdict: l.verdict, critique: l.critique })

  it('refuses a judge whose prompt contains a dev label, naming it', async () => {
    const err = await evaluateJudge(labels, judgeOf(agrees, [anchorFrom(labels[0]!)]), { split: 'dev' }).then(
      () => { throw new Error('expected the evaluation to be refused') },
      (e: Error) => e,
    )
    expect(err).toBeInstanceOf(ContaminationError)
    expect(err.message).toContain(`${devId} (dev)`)
  })

  it('refuses a dev label in the prompt even when measuring on test', async () => {
    await expect(evaluateJudge(labels, judgeOf(agrees, [anchorFrom(labels[0]!)]), { split: 'test' })).rejects.toThrow(ContaminationError)
  })

  it('refuses a test label in the prompt', async () => {
    await expect(evaluateJudge(labels, judgeOf(agrees, [anchorFrom(labels[1]!)]), { split: 'test' })).rejects.toThrow(/test/)
  })

  it('notices a copied example even if its whitespace or case was changed', async () => {
    const copy = { ...anchorFrom(labels[0]!), output: '  DEV   response ', input: 'Dev Q' }
    await expect(evaluateJudge(labels, judgeOf(agrees, [copy]), { split: 'dev' })).rejects.toThrow(ContaminationError)
  })

  it('allows train labels and unrelated examples in the prompt', async () => {
    const fromTrain = anchorsFromLabels([labels[2]!])
    const unrelated = { output: 'something else entirely', verdict: 'fail' as const, critique: 'because' }
    const r = await evaluateJudge(labels, judgeOf(agrees, [...fromTrain, unrelated]), { split: 'dev' })
    expect(r.metrics.n).toBe(1)
  })

  it('cannot be bypassed by the helper: building anchors from a dev label throws first', () => {
    expect(() => anchorsFromLabels([labels[0]!])).toThrow(/Only train labels/)
  })
})

describe('createRubricLabelJudge', () => {
  const rubric = RubricSchema.parse({
    id: 'sched', version: 2,
    criteria: [{ id: 'confirms', text: 'Confirms before acting' }, { id: 'no-advice', text: 'No medical advice' }],
    anchors: [
      { criterion: 'confirms', output: 'Done.', verdict: 'fail', critique: 'No confirmation.' },
      { criterion: 'no-advice', output: 'Take more.', verdict: 'fail', critique: 'Dosing advice.' },
      { output: 'General example', verdict: 'pass', critique: 'Fine overall.' },
    ],
  })
  const verdictFor = (id: string, verdict: 'pass' | 'fail') => ({ json: { verdicts: [{ criterion_id: id, critique: 'because', verdict }] } })

  it('judges the label against its own criterion only, with only the examples that illustrate it', async () => {
    const provider = createFakeProvider(verdictFor('confirms', 'fail'))
    const j = createRubricLabelJudge({ rubric, provider })
    const out = await j.judge(label({ criterion: 'confirms', input: 'Move it', output: 'Done now.' }))

    expect(out).toMatchObject({ verdict: 'fail', critique: 'because' })
    const prompt = provider.calls[0]!.messages[0]!.content
    expect(prompt).toContain('id: confirms')
    expect(prompt).not.toContain('no-advice')
    expect(prompt).toContain('No confirmation.')
    expect(prompt).not.toContain('Dosing advice.')
    expect(prompt).toContain('General example')
    expect(provider.calls[0]!.role).toBe('judge')
  })

  it('shows the judge the input as the user turn and the output as the assistant turn', async () => {
    const provider = createFakeProvider(verdictFor('confirms', 'pass'))
    await createRubricLabelJudge({ rubric, provider }).judge(label({ input: 'Move it to 3pm', output: 'Shall I go ahead?' }))
    const prompt = provider.calls[0]!.messages[0]!.content
    expect(prompt).toContain('[0] user: Move it to 3pm')
    expect(prompt).toContain('[1] assistant: Shall I go ahead?')
  })

  it('carries the rubric context into the label judge prompt, and leaves it out when unset', async () => {
    const withContext = RubricSchema.parse({ ...rubric, context: 'Existing appointment: Thursday 10:00 with Dr. Okafor.' })
    const provider = createFakeProvider(verdictFor('confirms', 'pass'))
    await createRubricLabelJudge({ rubric: withContext, provider }).judge(label({ criterion: 'confirms', output: 'Done now.' }))
    const prompt = provider.calls[0]!.messages[0]!.content
    expect(prompt).toContain('<reference_facts>\nExisting appointment: Thursday 10:00 with Dr. Okafor.\n</reference_facts>')
    expect(prompt.indexOf('<reference_facts>')).toBeLessThan(prompt.indexOf('Criteria to judge'))

    const plain = createFakeProvider(verdictFor('confirms', 'pass'))
    await createRubricLabelJudge({ rubric, provider: plain }).judge(label({ criterion: 'confirms', output: 'Done now.' }))
    expect(plain.calls[0]!.messages[0]!.content).not.toContain('reference_facts')
  })

  it('works when a label has no input', async () => {
    const provider = createFakeProvider(verdictFor('confirms', 'pass'))
    await createRubricLabelJudge({ rubric, provider }).judge(label({ input: undefined, output: 'Hello there friend.' }))
    expect(provider.calls[0]!.messages[0]!.content).toContain('[0] assistant: Hello there friend.')
  })

  it('declares every example in its prompt so the guard can check them', () => {
    expect(createRubricLabelJudge({ rubric, provider: createFakeProvider({ text: '' }) }).anchors).toHaveLength(3)
  })

  it('turns a criterion the rubric does not have, a refusal and a timeout into reported errors', async () => {
    const ids = [idInSplit('dev', 'r', 0), idInSplit('dev', 'r', 1), idInSplit('dev', 'r', 2)]
    const labels = [label({ id: ids[0]!, criterion: 'ghost' }), label({ id: ids[1]! }), label({ id: ids[2]! })]
    const replies = [{ refusal: true as const }, { error: 'timed out' }]
    let i = 0
    const provider = createFakeProvider(() => replies[Math.min(i++, 1)]!)
    const r = await evaluateJudge(labels, createRubricLabelJudge({ rubric, provider }), { split: 'dev' })
    expect(r.errors.map(e => e.reason).join(' | ')).toMatch(/does not have[\s\S]*not a verdict on the agent[\s\S]*timed out/)
    expect(r.metrics.n).toBe(0)
  })

  it('end to end: a judge that mostly agrees scores well, and its misses show up as disagreements', async () => {
    const labels = syntheticLabels(300)
    // The judge catches fails except when the output number is divisible by 6.
    const provider = createFakeProvider(req => {
      const m = /response number (\d+)/.exec(req.messages[0]!.content)
      const n = Number(m?.[1])
      const truth = n % 2 === 0 ? 'pass' : 'fail'
      const miss = truth === 'fail' && n % 3 === 0
      return verdictFor('confirms', miss ? 'pass' : truth)
    }, { usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.02 } })
    const r = await evaluateJudge(labels, createRubricLabelJudge({ rubric, provider }), { split: 'test' })

    expect(r.metrics.tpr.rate).toBe(1)
    expect(r.metrics.tnr.rate).toBeLessThan(1)
    expect(r.metrics.tnr.rate).toBeGreaterThan(0.5)
    expect(r.disagreements.every(d => d.expert === 'fail' && d.judge === 'pass')).toBe(true)
    expect(r.usage.costUsd).toBeCloseTo(0.02 * r.items.length)
  })
})

describe('formatReport and the example labels', () => {
  const labels = loadLabels(join(import.meta.dirname, '..', 'examples', 'labels', 'scheduling.jsonl'))

  it('states the rates with intervals, flags an insufficient sample, and lists disagreements', async () => {
    const r = await evaluateJudge(labels, judgeOf(l => ({ verdict: 'pass', critique: 'looks fine' })), { split: 'dev', selection: 'all' })
    const text = formatReport(r)
    expect(text).toContain('Judge: fake-judge')
    expect(text).toMatch(/True negative rate: (n\/a|\d+% \[\d+% to \d+%\])/)
    expect(text).toContain('INSUFFICIENT SAMPLE')
    expect(text).toContain('Warnings:')
  })

  it('shows a disagreement with both critiques', async () => {
    const dev = [
      label({ id: idInSplit('dev', 'q', 0), verdict: 'fail', output: 'Booked it without asking.', critique: 'No confirmation step.' }),
      label({ id: idInSplit('dev', 'q', 1), verdict: 'pass', output: 'Shall I go ahead?', critique: 'Asks first.' }),
    ]
    const r = await evaluateJudge(dev, judgeOf(() => ({ verdict: 'pass', critique: 'judge says fine' })), { split: 'dev' })
    expect(r.disagreements).toHaveLength(1)
    const text = formatReport(r)
    expect(text).toMatch(/Disagreements \(1\):/)
    expect(text).toContain('expert: No confirmation step.')
    expect(text).toContain('judge:  judge says fine')
  })

  it('writes n/a, not a made-up rate, when a class is empty', async () => {
    const onlyPass = [label({ id: idInSplit('dev', 'p'), verdict: 'pass' })]
    const text = formatReport(await evaluateJudge(onlyPass, judgeOf(agrees), { split: 'dev' }))
    expect(text).toContain('True negative rate: n/a (no expert-fail labels)')
  })
})
