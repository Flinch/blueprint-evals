import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../../src/cli/main.js'
import { createFakeProvider, partition } from '../../src/index.js'
import { syntheticLabels } from '../label-helpers.js'
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
  })
})
