import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../../src/cli/main.js'
import { createFakeProvider, partition } from '../../src/index.js'
import { idInSplit, label, syntheticLabels } from '../label-helpers.js'
import { saveSuite } from '../ui/records.js'
import { exampleConfigFor, harness, labelJudgeProvider, rubricYaml, tempDir, toJsonl, writeFiles } from './harness.js'

const labels = syntheticLabels(400)
const { dev, test } = partition(labels)
const randomIn = (split: typeof dev) => split.filter(l => l.sampled_by === 'random').length

function workspace(over: Record<string, string> = {}) {
  const dir = writeFiles(tempDir(), {
    'evals.config.yaml': exampleConfigFor('http://127.0.0.1:1'),
    'rubric.yaml': rubricYaml(),
    'labels.jsonl': toJsonl(labels),
    ...over,
  })
  return dir
}
const base = ['calibrate', '--labels', 'labels.jsonl', '--rubric', 'rubric.yaml']

describe('evals calibrate', () => {
  it('previews the number of judgements, then measures with the fake provider and prints the report', async () => {
    const provider = labelJudgeProvider('agree')
    const h = harness({ cwd: workspace(), provider })
    const code = await runCli([...base, '--split', 'dev', '--yes'], h.io)
    expect(h.stderr()).toBe('')
    expect(code).toBe(0)
    const out = h.stdout()
    expect(out).toMatch(new RegExp(`Judgements: ${randomIn(dev)} \\(random labels in the dev split\\), one judge call each`))
    expect(out).toMatch(/Judge: claude-opus-5-5, effort high/)
    expect(provider.calls).toHaveLength(randomIn(dev))
    expect(provider.calls[0]).toMatchObject({ role: 'judge', effort: 'high', timeoutMs: 180_000 })
    expect(out).toMatch(/Judge: rubric-judge\(calib@1\)/)
    expect(out).toMatch(/True negative rate: 100%/)
    expect(out).toMatch(/True positive rate: 100%/)
    expect(out).toMatch(/Spend: \$0\.00/)
    expect(out).not.toMatch(/INSUFFICIENT/)
  })

  it('counts every label in the split with --selection all', async () => {
    const provider = labelJudgeProvider('agree')
    const h = harness({ cwd: workspace(), provider })
    expect(await runCli([...base, '--split', 'test', '--selection', 'all', '--yes'], h.io)).toBe(0)
    expect(h.stdout()).toMatch(new RegExp(`Judgements: ${test.length} \\(all labels in the test split\\)`))
    expect(provider.calls).toHaveLength(test.length)
    expect(h.stdout()).toMatch(/describe the sample reviewed/)
  })

  it('exits 0 even when the rates are low: it is a measurement, not a gate', async () => {
    const h = harness({ cwd: workspace(), provider: labelJudgeProvider('always-pass') })
    const code = await runCli([...base, '--split', 'dev', '--yes'], h.io)
    expect(code).toBe(0)
    expect(h.stdout()).toMatch(/True negative rate: 0%/)
    expect(h.stdout()).toMatch(/Disagreements \(/)
  })

  it('prints insufficient-sample warnings prominently', async () => {
    const dir = workspace({ 'labels.jsonl': toJsonl(syntheticLabels(40)) })
    const h = harness({ cwd: dir, provider: labelJudgeProvider('agree') })
    const code = await runCli([...base, '--split', 'dev', '--yes'], h.io)
    expect(code).toBe(0)
    expect(h.stdout()).toMatch(/Status: INSUFFICIENT SAMPLE/)
    expect(h.stdout()).toMatch(/\nINSUFFICIENT SAMPLE: do not rely on these rates\.\n {2}- Only \d+ labels/)
  })

  it('reports unknown spend when the judge model has no price', async () => {
    const dir = workspace({ 'evals.config.yaml': exampleConfigFor('http://127.0.0.1:1').replace('claude-opus-5-5: {', 'other: {') })
    const provider = createFakeProvider(
      () => ({ json: { verdicts: [{ criterion_id: 'confirms', critique: 'ok', verdict: 'pass' }] } }),
      { usage: { inputTokens: 1, outputTokens: 1, costUsd: null } },
    )
    const h = harness({ cwd: dir, provider })
    await runCli([...base, '--split', 'dev', '--yes'], h.io)
    expect(h.stdout()).toMatch(/WARNING: no price for model "claude-opus-5-5"/)
    expect(h.stdout()).toMatch(/Spend: unknown/)
  })

  describe('confirmation', () => {
    it('refuses without --yes when not a terminal, and makes no model call', async () => {
      const provider = labelJudgeProvider()
      const h = harness({ cwd: workspace(), provider, isTTY: false })
      expect(await runCli([...base, '--split', 'dev'], h.io)).toBe(2)
      expect(provider.calls).toHaveLength(0)
      expect(h.stdout()).toMatch(/Cost preview/)
      expect(h.stderr()).toMatch(/no terminal to ask for confirmation\. Nothing was run\. Pass --yes/)
    })

    it('asks at a terminal, and stops on no', async () => {
      const provider = labelJudgeProvider()
      const no = harness({ cwd: workspace(), provider, isTTY: true, answer: false })
      expect(await runCli([...base, '--split', 'dev'], no.io)).toBe(2)
      expect(no.questions).toHaveLength(1)
      expect(provider.calls).toHaveLength(0)

      const yes = harness({ cwd: workspace(), provider, isTTY: true, answer: true })
      expect(await runCli([...base, '--split', 'dev'], yes.io)).toBe(0)
      expect(provider.calls.length).toBeGreaterThan(0)
    })

    it('needs no confirmation when there is nothing to judge', async () => {
      const dir = workspace({ 'labels.jsonl': toJsonl(syntheticLabels(5).map(l => ({ ...l, sampled_by: 'targeted' as const }))) })
      const h = harness({ cwd: dir, isTTY: false })
      expect(await runCli([...base, '--split', 'dev'], h.io)).toBe(0)
      expect(h.stdout()).toMatch(/Judgements: 0 /)
      expect(h.stdout()).toMatch(/No model calls will be made/)
      expect(h.stdout()).toMatch(/INSUFFICIENT SAMPLE/)
    })
  })

  describe('refusals', () => {
    it('refuses the train split, naming why, with no model call', async () => {
      const provider = labelJudgeProvider()
      const h = harness({ cwd: workspace(), provider })
      expect(await runCli([...base, '--split', 'train', '--yes'], h.io)).toBe(2)
      expect(h.stderr()).toMatch(/cannot calibrate on the train split.*may appear in the judge's prompt/)
      expect(provider.calls).toHaveLength(0)
      expect(h.stdout()).toBe('')
    })

    it('exits 2 with the message when a few-shot example is a dev label (contamination), before any model call', async () => {
      const leaked = dev[0]!
      const rubric = rubricYaml(`anchors:
  - criterion: confirms
    input: ${JSON.stringify(leaked.input)}
    output: ${JSON.stringify(leaked.output)}
    verdict: pass
    critique: copied from a dev label
`)
      const provider = labelJudgeProvider()
      const h = harness({ cwd: workspace({ 'rubric.yaml': rubric }), provider })
      expect(await runCli([...base, '--split', 'test', '--yes'], h.io)).toBe(2)
      expect(h.stderr()).toMatch(/few-shot examples include labels from the dev or test split/)
      expect(h.stderr()).toContain(`${leaked.id} (dev)`)
      expect(provider.calls).toHaveLength(0)
    })

    it('refuses a contaminated judge before showing the cost preview, so nobody approves a spend that will be refused', async () => {
      const leaked = dev[0]!
      const rubric = rubricYaml(`anchors:
  - criterion: confirms
    input: ${JSON.stringify(leaked.input)}
    output: ${JSON.stringify(leaked.output)}
    verdict: pass
    critique: copied from a dev label
`)
      const h = harness({ cwd: workspace({ 'rubric.yaml': rubric }), provider: labelJudgeProvider() })
      // No --yes and no terminal: it must refuse for contamination, not for the missing confirmation.
      expect(await runCli([...base, '--split', 'test'], h.io)).toBe(2)
      expect(h.stdout()).toBe('')
      expect(h.stderr()).toMatch(/few-shot examples include labels/)
      expect(h.stderr()).toMatch(/Nothing was run and nothing was spent/)
    })

    it('exits 1, and lists them, when some labels could not be judged', async () => {
      const provider = createFakeProvider({ error: 'the model fell over' })
      const h = harness({ cwd: workspace(), provider })
      expect(await runCli([...base, '--split', 'dev', '--yes'], h.io)).toBe(1)
      expect(h.stdout()).toMatch(/Could not be judged:/)
      expect(h.stdout()).toMatch(/the model fell over/)
    })

    it('needs --labels, --rubric and --split, and rejects bad values', async () => {
      for (const [argv, pattern] of [
        [['calibrate', '--rubric', 'rubric.yaml', '--split', 'dev'], /--labels is required/],
        [['calibrate', '--labels', 'labels.jsonl', '--split', 'dev'], /--rubric is required/],
        [['calibrate', '--labels', 'labels.jsonl', '--rubric', 'rubric.yaml'], /--split is required/],
        [[...base, '--split', 'holdout'], /--split must be dev or test/],
        [[...base, '--split', 'dev', '--selection', 'some'], /--selection must be random or all/],
        [[...base, '--split', 'dev', 'extra'], /unexpected argument "extra"/],
        [['calibrate', '--labels', 'missing.jsonl', '--rubric', 'rubric.yaml', '--split', 'dev'], /labels file not found/],
        [[...base, '--split', 'dev', '--config', 'missing.yaml'], /config file not found/],
      ] as const) {
        const h = harness({ cwd: workspace() })
        expect(await runCli([...argv], h.io), argv.join(' ')).toBe(2)
        expect(h.stderr()).toMatch(pattern)
      }
    })

    it('exits 2 on a label file that does not parse, naming the line', async () => {
      const h = harness({ cwd: workspace({ 'labels.jsonl': '{"id": "a"}\n' }) })
      expect(await runCli([...base, '--split', 'dev', '--yes'], h.io)).toBe(2)
      expect(h.stderr()).toMatch(join('labels.jsonl') + ':1')
    })

    it('exits 2 on a broken replace chain, before any model call', async () => {
      const provider = labelJudgeProvider('agree')
      const orphan = { ...dev[0]!, id: 'missing~r1', replaces: 'missing' }
      const h = harness({ cwd: workspace({ 'labels.jsonl': toJsonl([...labels, orphan]) }), provider })
      expect(await runCli([...base, '--split', 'dev', '--yes'], h.io)).toBe(2)
      expect(h.stderr()).toMatch(/replaces "missing", which is not in the file/)
      expect(provider.calls).toHaveLength(0)
    })
  })

  it('judges each item once with its current label, and prints the agreement on the blind labels', async () => {
    const changed = dev.filter(l => l.sampled_by === 'random').slice(0, 2)
    const revisions = changed.map(l => ({ ...l, id: `${l.id}~r1`, replaces: l.id, verdict: l.verdict === 'pass' ? 'fail' as const : 'pass' as const }))
    const provider = labelJudgeProvider('agree')
    const h = harness({ cwd: workspace({ 'labels.jsonl': toJsonl([...labels, ...revisions]) }), provider })
    expect(await runCli([...base, '--split', 'dev', '--yes'], h.io)).toBe(0)
    expect(provider.calls).toHaveLength(randomIn(dev))
    expect(h.stdout()).toMatch(/Changed after seeing the judge: 2 of these labels \(2 changed the verdict\)/)
    expect(h.stdout()).toMatch(/On the original, blind labels: accuracy 100%/)
  })

  describe('evidence', () => {
    const runId = idInSplit('dev', 'run')
    const STARTED = '2026-11-16T03:00:00.000Z'
    const turns = [
      { role: 'user' as const, content: 'Cancel my Thursday visit.' },
      { role: 'assistant' as const, content: 'It is cancelled.', toolCalls: [{ name: 'cancel_appointment', arguments: { day: 'Thursday' }, result: { status: 'no_active_appointment', is_error: true } }] },
    ]
    const fromRun = label({ id: `${runId}:confirms`, group: runId, criterion: 'confirms', input: 'Cancel my Thursday visit.', output: 'It is cancelled.', verdict: 'fail' })
    const handWritten = label({ id: idInSplit('dev', 'hand'), criterion: 'confirms', input: 'Move it', output: 'Done.', verdict: 'pass' })

    it('judges a label made from a saved run on the whole run with its date, falls back for a hand-written one, and says how many took each path', async () => {
      const cwd = workspace({ 'evals.config.yaml': `${exampleConfigFor('http://127.0.0.1:1')}\ntimezone: America/Toronto\n`, 'labels.jsonl': toJsonl([fromRun, handWritten]) })
      saveSuite(cwd, [{ runId, turns, startedAt: STARTED, criteria: { confirms: 'fail' } }])
      const provider = createFakeProvider({ json: { verdicts: [{ criterion_id: 'confirms', critique: 'ok', verdict: 'fail' }] } })
      const h = harness({ cwd, provider })
      expect(await runCli([...base, '--split', 'dev', '--yes'], h.io)).toBe(0)
      expect(provider.calls).toHaveLength(2)
      const prompts = provider.calls.map(c => c.messages[0]!.content)
      const full = prompts.find(p => p.includes('cancel_appointment'))!
      expect(full).toContain('The conversation took place on Sunday, 15 November 2026 (America/Toronto).')
      expect(full).toContain('[1] assistant: It is cancelled.\n    tool call: cancel_appointment({"day":"Thursday"})\n    tool result: {"status":"no_active_appointment","is_error":true}')
      const fallback = prompts.find(p => p.includes('[1] assistant: Done.'))!
      expect(fallback).not.toContain('The conversation took place')
      const out = h.stdout()
      // In the preview, before anything is spent, and in the report.
      expect(out.indexOf("Evidence: 1 judged on the whole saved run, 1 on the label's text alone.")).toBeGreaterThanOrEqual(0)
      expect(out).toMatch(/WARNING: 1 of 2 items were judged on the label's text alone/)
      expect(out).toMatch(/Evidence: 1 judged on the whole saved run, 1 on the label's text alone\n/)
      expect(out).toMatch(/  - 1 of 2 items were judged on the label's text alone/)
    })
  })
})
