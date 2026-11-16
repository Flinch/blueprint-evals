import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../../src/cli/main.js'
import { syntheticLabels } from '../label-helpers.js'
import { examples, exampleConfigFor, harness, rubricYaml, tempDir, toJsonl, writeFiles } from './harness.js'

const exampleScenarios = join(examples, 'scenarios')
const exampleConfig = join(examples, 'evals.config.yaml')

const scenario = (id: string, target = 'stub-agent') => `id: ${id}
version: 1
target: ${target}
seed_message: "hello"
checks:
  - type: must_not_call
    tool: cancel_appointment
`

describe('evals validate', () => {
  it('accepts the example files and prints the counts', async () => {
    const h = harness()
    const code = await runCli(['validate', exampleScenarios, '--config', exampleConfig], h.io)
    expect(h.stderr()).toBe('')
    expect(code).toBe(0)
    expect(h.stdout()).toMatch(/Scenarios: 4 in /)
    expect(h.stdout()).toMatch(/3 need a model \(persona, rubric or goal\), 1 deterministic only/)
    expect(h.stdout()).toMatch(/Rubrics: 1 used by scenarios/)
    expect(h.stdout()).toMatch(/Valid\./)
    expect(h.providersCreated()).toBe(0)
  })

  it('uses evals.config.yaml and ./scenarios from the current directory by default', async () => {
    const dir = writeFiles(tempDir(), { 'evals.config.yaml': exampleConfigFor('http://127.0.0.1:1'), 'scenarios/a.yaml': scenario('a') })
    const h = harness({ cwd: dir })
    expect(await runCli(['validate'], h.io)).toBe(0)
    expect(h.stdout()).toMatch(/Scenarios: 1 in scenarios/)
  })

  it('reports a scenario whose target is not in the config', async () => {
    const dir = writeFiles(tempDir(), { 'evals.config.yaml': exampleConfigFor('http://127.0.0.1:1'), 'scenarios/a.yaml': scenario('a', 'nowhere') })
    const h = harness({ cwd: dir })
    expect(await runCli(['validate'], h.io)).toBe(1)
    expect(h.stdout()).toMatch(/Scenario "a" .*uses the target "nowhere", which is not in the config\. Targets in the config: stub-agent\./)
    expect(h.stdout()).toMatch(/Validation failed\./)
  })

  it('reports target kinds that are not implemented, with a clear message', async () => {
    const config = exampleConfigFor('http://127.0.0.1:1') + `  vapi:\n    kind: vapi-chat\n    apiKey: "\${env:VAPI_KEY}"\n    assistantId: abc\n  placeholder:\n    kind: fake\n`
    const dir = writeFiles(tempDir(), {
      'evals.config.yaml': config,
      'scenarios/a.yaml': scenario('a', 'vapi'),
      'scenarios/b.yaml': scenario('b', 'placeholder'),
    })
    const h = harness({ cwd: dir, env: { VAPI_KEY: 'x' } })
    expect(await runCli(['validate'], h.io)).toBe(1)
    expect(h.stdout()).toMatch(/Target "vapi" has kind "vapi-chat", which is not implemented yet\. Only "http" targets can run\./)
    expect(h.stdout()).toMatch(/Target "placeholder" has kind "fake", which is not implemented yet/)
  })

  it('does not complain about unimplemented targets that no scenario uses', async () => {
    const config = exampleConfigFor('http://127.0.0.1:1') + `  placeholder:\n    kind: fake\n`
    const dir = writeFiles(tempDir(), { 'evals.config.yaml': config, 'scenarios/a.yaml': scenario('a') })
    const h = harness({ cwd: dir })
    expect(await runCli(['validate'], h.io)).toBe(0)
  })

  describe('environment variables', () => {
    const config = exampleConfigFor('http://127.0.0.1:1', [['    request:', '    headers:\n      authorization: "Bearer ${env:AGENT_TOKEN}"\n    request:']])
    const files = { 'evals.config.yaml': config, 'scenarios/a.yaml': scenario('a') }

    it('warns, without failing, when a referenced variable is unset', async () => {
      const h = harness({ cwd: writeFiles(tempDir(), files), env: {} })
      expect(await runCli(['validate'], h.io)).toBe(0)
      expect(h.stdout()).toMatch(/AGENT_TOKEN \(NOT SET\) used by stub-agent/)
      expect(h.stdout()).toMatch(/Warnings \(1\):\n {2}- Environment variable AGENT_TOKEN is not set \(used by target "stub-agent"\)\./)
      expect(h.stdout()).toMatch(/Valid, with warnings\./)
    })

    it('lists a set variable by name only and never prints its value', async () => {
      const h = harness({ cwd: writeFiles(tempDir(), files), env: { AGENT_TOKEN: 'sk-super-secret-value' } })
      expect(await runCli(['validate'], h.io)).toBe(0)
      expect(h.stdout()).toMatch(/AGENT_TOKEN \(set\)/)
      expect(h.stdout()).not.toMatch(/Warnings/)
      expect(h.stdout() + h.stderr()).not.toContain('sk-super-secret-value')
    })

    it('treats an empty variable as unset', async () => {
      const h = harness({ cwd: writeFiles(tempDir(), files), env: { AGENT_TOKEN: '' } })
      await runCli(['validate'], h.io)
      expect(h.stdout()).toMatch(/NOT SET/)
    })
  })

  it('reports an invalid scenario file by name, and an unknown rubric criterion in the labels', async () => {
    const dir = writeFiles(tempDir(), {
      'evals.config.yaml': exampleConfigFor('http://127.0.0.1:1'),
      'scenarios/bad.yaml': 'id: Bad Id\nversion: 1\ntarget: stub-agent\nseed_message: hi\n',
      'rubric.yaml': rubricYaml(),
      'labels.jsonl': toJsonl(syntheticLabels(3).map(l => ({ ...l, criterion: 'other' }))),
    })
    const h = harness({ cwd: dir })
    expect(await runCli(['validate', '--labels', 'labels.jsonl', '--rubric', 'rubric.yaml'], h.io)).toBe(1)
    expect(h.stdout()).toMatch(/bad\.yaml/)
    expect(h.stdout()).toMatch(/labels are about criteria that rubric "calib" does not have: other/)
  })

  it('checks a label file and prints the label warnings', async () => {
    const dir = writeFiles(tempDir(), {
      'evals.config.yaml': exampleConfigFor('http://127.0.0.1:1'),
      'scenarios/a.yaml': scenario('a'),
      'rubric.yaml': rubricYaml(),
      'labels.jsonl': toJsonl(syntheticLabels(10).map(l => ({ ...l, sampled_by: 'targeted' as const }))),
    })
    const h = harness({ cwd: dir })
    expect(await runCli(['validate', '--labels', 'labels.jsonl', '--rubric', 'rubric.yaml'], h.io)).toBe(0)
    expect(h.stdout()).toMatch(/Labels: 10 in labels\.jsonl/)
    expect(h.stdout()).toMatch(/Only 0% of labels were randomly sampled/)
  })

  it('counts items, says how many labels were revised, and fails on a broken replace chain', async () => {
    const labels = syntheticLabels(10)
    const revised = [0, 1].map(i => ({ ...labels[i]!, id: `${labels[i]!.id}~r1`, replaces: labels[i]!.id, verdict: 'pass' as const }))
    const files = (extra: object[]) => ({
      'evals.config.yaml': exampleConfigFor('http://127.0.0.1:1'),
      'scenarios/a.yaml': scenario('a'),
      'labels.jsonl': toJsonl([...labels, ...revised, ...extra] as typeof labels),
    })
    const ok = harness({ cwd: writeFiles(tempDir(), files([])) })
    expect(await runCli(['validate', '--labels', 'labels.jsonl'], ok.io)).toBe(0)
    expect(ok.stdout()).toMatch(/Labels: 10 in labels\.jsonl, 2 of them revised after the first label \(12 lines\)/)

    const fork = { ...revised[0]!, id: `${labels[0]!.id}~r2` }
    const bad = harness({ cwd: writeFiles(tempDir(), files([fork])) })
    expect(await runCli(['validate', '--labels', 'labels.jsonl'], bad.io)).toBe(1)
    expect(bad.stdout()).toMatch(/both replace/)
  })

  it('treats a missing file or an unusable invocation as a usage problem (2), not a validation failure', async () => {
    const dir = writeFiles(tempDir(), { 'scenarios/a.yaml': scenario('a') })
    for (const [argv, pattern] of [
      [['validate'], /config file not found: evals\.config\.yaml/],
      [['validate', '--config', 'missing.yaml'], /config file not found: missing\.yaml/],
      [['validate', 'nope', '--config', exampleConfig], /scenarios path not found/],
      [['validate', 'a', 'b'], /at most one path/],
      [['validate', '--bogus'], /Unknown option/],
    ] as const) {
      const h = harness({ cwd: dir })
      expect(await runCli([...argv], h.io), argv.join(' ')).toBe(2)
      expect(h.stderr()).toMatch(pattern)
    }
    const empty = harness({ cwd: tempDir() })
    expect(await runCli(['validate', '--config', exampleConfig], empty.io)).toBe(2)
    expect(empty.stderr()).toMatch(/no scenarios path given/)
  })
})
