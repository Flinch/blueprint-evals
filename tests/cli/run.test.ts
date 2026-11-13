import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createStubAgent } from '../../examples/stub-agent/agent.js'
import { runCli } from '../../src/cli/main.js'
import { createFakeProvider, FRAMEWORK_VERSION } from '../../src/index.js'
import { approvingProvider, examples, exampleConfigFor, harness, tempDir, writeFiles } from './harness.js'

const scenarios = join(examples, 'scenarios')
const DETERMINISTIC = 'reschedule-asks-before-acting'

// The CLI against the real stub agent over real HTTP, with the fake model
// provider. Nothing here reaches the network beyond localhost.
describe('evals run', () => {
  const good = createStubAgent()
  const bad = createStubAgent({ defect: 'no-confirm' })
  let goodConfig = ''
  let badConfig = ''
  beforeAll(async () => {
    const dir = tempDir()
    goodConfig = join(writeFiles(dir, { 'good.yaml': exampleConfigFor(await good.listen()), 'bad.yaml': exampleConfigFor(await bad.listen()) }), 'good.yaml')
    badConfig = join(dir, 'bad.yaml')
  })
  afterAll(async () => {
    await good.close()
    await bad.close()
  })

  describe('a deterministic scenario (no model calls)', () => {
    it('passes on the correct agent, exits 0, and needs no confirmation, no flag and no provider', async () => {
      const h = harness({ isTTY: false })
      const code = await runCli(['run', scenarios, '--config', goodConfig, '--only', DETERMINISTIC], h.io)
      expect(h.stderr()).toBe('')
      expect(code).toBe(0)
      expect(h.questions).toEqual([])
      expect(h.providersCreated()).toBe(0)
      const out = h.stdout()
      expect(out).toMatch(/No model calls will be made, so this run costs nothing\./)
      expect(out).toMatch(new RegExp(`RUN   ${DETERMINISTIC}\n`))
      expect(out).toMatch(new RegExp(`PASS  ${DETERMINISTIC}  score -  goal -  cost \\$0\\.0000  \\d+(ms|\\.\\ds)`))
      expect(out).toMatch(/Runs: 1 {3}pass 1 {3}fail 0 {3}error 0/)
      expect(out).toMatch(/Total cost: \$0\.00/)
    })

    it('fails on the agent with the planted defect, exits 1 and shows the failed check', async () => {
      const h = harness()
      const code = await runCli(['run', scenarios, '--config', badConfig, '--only', DETERMINISTIC], h.io)
      expect(code).toBe(1)
      expect(h.stdout()).toMatch(new RegExp(`FAIL  ${DETERMINISTIC}`))
      expect(h.stdout()).toMatch(/failed check: must_not_call\(reschedule_appointment\):/)
      expect(h.stdout()).toMatch(/Runs: 1 {3}pass 0 {3}fail 1 {3}error 0/)
    })

    it('reports an unreachable agent as an error and exits 1', async () => {
      const dir = writeFiles(tempDir(), { 'c.yaml': exampleConfigFor('http://127.0.0.1:1', [['    kind: http', '    kind: http\n    timeoutMs: 2000']]) })
      const h = harness()
      const code = await runCli(['run', scenarios, '--config', join(dir, 'c.yaml'), '--only', DETERMINISTIC], h.io)
      expect(code).toBe(1)
      expect(h.stdout()).toMatch(/ERROR .*\n {8}error: target "stub-agent" request failed/)
    })

    it('refuses a target that declares tool calls but has no mapping, before running', async () => {
      const config = `models:
  simulator: { model: m }
  judge: { model: m }
targets:
  stub-agent:
    kind: http
    url: http://127.0.0.1:1/chat
    toolCalls: verified
    request: { body: { message: "{{input.text}}" } }
    response: { text: "$.reply" }
`
      const dir = writeFiles(tempDir(), { 'c.yaml': config })
      const h = harness()
      expect(await runCli(['run', scenarios, '--config', join(dir, 'c.yaml'), '--only', DETERMINISTIC], h.io)).toBe(2)
      expect(h.stderr()).toMatch(/declares toolCalls: verified but has no response\.toolCalls mapping/)
    })
  })

  describe('cost preview and confirmation', () => {
    it('prints the preview with the example scenarios, and refuses without --yes when not a terminal', async () => {
      const provider = createFakeProvider({ error: 'must not be called' })
      const h = harness({ isTTY: false, provider })
      const code = await runCli(['run', scenarios, '--config', goodConfig], h.io)
      expect(code).toBe(2)
      expect(provider.calls).toHaveLength(0)
      expect(h.providersCreated()).toBe(0)
      expect(h.questions).toEqual([])
      const out = h.stdout()
      expect(out).toMatch(/Cost preview/)
      expect(out).toMatch(/Scenarios: 4 selected, 3 call a model, 1 deterministic only/)
      expect(out).toMatch(/Simulator calls: up to 13 \(claude-opus-5-5, effort low\)/)
      expect(out).toMatch(/Judge calls: up to 6 \(claude-opus-5-5, effort high\): 3 rubric judge, 3 goal check/)
      expect(out).toMatch(/upper bounds/)
      expect(out).toMatch(/WARNING: no cost cap is set/)
      expect(h.stderr()).toMatch(/no terminal to ask for confirmation\. Nothing was run\. Pass --yes/)
      expect(out).not.toMatch(/RUN /)
    })

    it('shows the cap, and the worst case as scenarios with a model times the cap', async () => {
      const h = harness()
      await runCli(['run', scenarios, '--config', goodConfig, '--max-cost', '0.5'], h.io)
      expect(h.stdout()).toMatch(/Cost cap per scenario: \$0\.50 \(--max-cost\)/)
      expect(h.stdout()).toMatch(/Worst-case total: \$1\.50 \(3 scenarios x \$0\.50\)/)
      expect(h.stdout()).not.toMatch(/no cost cap is set/)
    })

    it('takes the cap from the config, and --max-cost overrides it', async () => {
      const dir = writeFiles(tempDir(), { 'c.yaml': exampleConfigFor('http://127.0.0.1:1') + 'budget:\n  maxCostUsd: 2\n' })
      const config = join(dir, 'c.yaml')
      const fromConfig = harness()
      await runCli(['run', scenarios, '--config', config, '--tag', 'safety'], fromConfig.io)
      expect(fromConfig.stdout()).toMatch(/Scenarios: 2 selected, 2 call a model/)
      expect(fromConfig.stdout()).toMatch(/Cost cap per scenario: \$2\.00 \(budget\.maxCostUsd in the config\)/)
      expect(fromConfig.stdout()).toMatch(/Worst-case total: \$4\.00 \(2 scenarios x \$2\.00\)/)
      const overridden = harness()
      await runCli(['run', scenarios, '--config', config, '--tag', 'safety', '--max-cost', '1'], overridden.io)
      expect(overridden.stdout()).toMatch(/Cost cap per scenario: \$1\.00 \(--max-cost\)/)
    })

    it('warns when a used model has no price, and says a cap cannot then be enforced', async () => {
      const dir = writeFiles(tempDir(), { 'c.yaml': exampleConfigFor('http://127.0.0.1:1').replace('claude-opus-5-5: {', 'some-other-model: {') })
      const h = harness()
      await runCli(['run', scenarios, '--config', join(dir, 'c.yaml'), '--max-cost', '1'], h.io)
      expect(h.stdout()).toMatch(/WARNING: no price for model "claude-opus-5-5" in the config's pricing table\./)
      expect(h.stdout()).toMatch(/cost cap cannot be enforced/)
    })

    it('asks a person at a terminal, and runs nothing when they say no', async () => {
      const provider = approvingProvider()
      const h = harness({ isTTY: true, answer: false, provider })
      const code = await runCli(['run', scenarios, '--config', goodConfig, '--only', 'reschedule-tomorrow-3pm'], h.io)
      expect(code).toBe(2)
      expect(h.questions).toEqual(['Continue? [y/N]'])
      expect(h.stdout()).toMatch(/Cost preview/)
      expect(h.stdout()).toMatch(/Not confirmed\. Nothing was run and nothing was spent\./)
      expect(provider.calls).toHaveLength(0)
      expect(h.stdout()).not.toMatch(/RUN /)
    })

    it('runs when a person at a terminal says yes', async () => {
      const h = harness({ isTTY: true, answer: true, provider: approvingProvider() })
      const code = await runCli(['run', scenarios, '--config', goodConfig, '--only', 'reschedule-tomorrow-3pm'], h.io)
      expect(code).toBe(0)
      expect(h.questions).toHaveLength(1)
      expect(h.stdout()).toMatch(/PASS  reschedule-tomorrow-3pm/)
    })

    it('proceeds with --yes and the fake provider, end to end, with a persona, rubric judge and goal check', async () => {
      const provider = approvingProvider()
      const h = harness({ isTTY: false, provider })
      const code = await runCli(['run', scenarios, '--config', goodConfig, '--only', 'reschedule-tomorrow-3pm', '--yes'], h.io)
      expect(h.stderr()).toBe('')
      expect(code).toBe(0)
      expect(h.questions).toEqual([])
      expect(provider.calls.map(c => c.role)).toEqual(['simulator', 'simulator', 'judge', 'judge'])
      // The simulator and judge efforts and timeouts come from the config.
      expect(provider.calls[0]).toMatchObject({ effort: 'low', timeoutMs: 60_000 })
      expect(provider.calls[2]).toMatchObject({ effort: 'high', timeoutMs: 180_000 })
      expect(h.stdout()).toMatch(/PASS  reschedule-tomorrow-3pm  score 1\.00  goal yes  cost \$0\.0000/)
      expect(h.stdout()).toMatch(/Goal achieved: 1 of 1/)
    })

    it('shows failed criteria with the judge critique, and a goal that was not achieved', async () => {
      const provider = createFakeProvider((req, n) => {
        if (req.role === 'simulator') return { json: { action: 'end', message: '' } }
        return req.messages[0]!.content.includes('Criteria to judge')
          ? { json: { verdicts: [
              { criterion_id: 'confirms-before-acting', critique: 'The agent\nnever confirmed anything.', verdict: 'fail' },
              { criterion_id: 'no-medical-advice', critique: 'Fine.', verdict: 'pass' },
            ] } }
          : { json: { achieved: false, critique: 'Nothing was rescheduled.' + n } }
      })
      const h = harness({ provider })
      const code = await runCli(['run', scenarios, '--config', goodConfig, '--only', 'asks-for-medical-advice', '--yes'], h.io)
      expect(code).toBe(1)
      expect(h.stdout()).toMatch(/failed criterion: confirms-before-acting: The agent never confirmed anything\./)
      expect(h.stdout()).toMatch(/goal no/)
    })

    it('says the total cost is unknown when a model has no price', async () => {
      const provider = createFakeProvider(
        req => (req.role === 'simulator'
          ? { json: { action: 'end', message: '' } }
          : req.messages[0]!.content.includes('Criteria to judge')
            ? { json: { verdicts: [{ criterion_id: 'confirms-before-acting', critique: 'ok', verdict: 'pass' }, { criterion_id: 'no-medical-advice', critique: 'ok', verdict: 'pass' }] } }
            : { json: { achieved: true, critique: 'ok' } }),
        { usage: { inputTokens: 1, outputTokens: 1, costUsd: null } },
      )
      const h = harness({ provider })
      await runCli(['run', scenarios, '--config', goodConfig, '--only', 'asks-for-medical-advice', '--yes'], h.io)
      expect(h.stdout()).toMatch(/cost unknown/)
      expect(h.stdout()).toMatch(/Total cost: unknown/)
    })

    it('stops a run that passes the cap, as an error naming the limit', async () => {
      const provider = createFakeProvider({ json: { action: 'say', message: 'yes' } }, { usage: { inputTokens: 1, outputTokens: 1, costUsd: 1 } })
      const h = harness({ provider })
      const code = await runCli(['run', scenarios, '--config', goodConfig, '--only', 'reschedule-tomorrow-3pm', '--max-cost', '0.5', '--yes'], h.io)
      expect(code).toBe(1)
      expect(h.stdout()).toMatch(/error: Cost budget of \$0\.5 exceeded/)
    })
  })

  describe('selection', () => {
    it('--only runs just the named scenarios', async () => {
      const h = harness()
      await runCli(['run', scenarios, '--config', goodConfig, '--only', `${DETERMINISTIC}`], h.io)
      expect(h.stdout()).toMatch(/Scenarios: 1 selected/)
    })

    it('--tag selects by tag, and --only and --tag together intersect', async () => {
      const tagged = harness()
      await runCli(['run', scenarios, '--config', goodConfig, '--tag', 'deterministic'], tagged.io)
      expect(tagged.stdout()).toMatch(/Scenarios: 1 selected/)
      expect(tagged.stdout()).toMatch(new RegExp(`PASS  ${DETERMINISTIC}`))

      const several = harness()
      await runCli(['run', scenarios, '--config', goodConfig, '--tag', 'safety', '--tag', 'deterministic'], several.io)
      expect(several.stdout()).toMatch(/Scenarios: 3 selected, 2 call a model, 1 deterministic only/)

      const both = harness()
      expect(await runCli(['run', scenarios, '--config', goodConfig, '--tag', 'safety', '--only', DETERMINISTIC], both.io)).toBe(2)
      expect(both.stderr()).toMatch(/no scenarios matched --only and --tag/)
    })

    it('rejects an unknown id in --only, naming what was found', async () => {
      const h = harness()
      expect(await runCli(['run', scenarios, '--config', goodConfig, '--only', 'nope,also-nope'], h.io)).toBe(2)
      expect(h.stderr()).toMatch(/not found: nope, also-nope\. Found: /)
    })
  })

  describe('--json', () => {
    it('writes frameworkVersion, startedAt and every result with its full trace', async () => {
      const file = join(tempDir(), 'nested', 'results.json')
      const h = harness()
      const code = await runCli(['run', scenarios, '--config', goodConfig, '--tag', 'deterministic', '--json', file], h.io)
      expect(code).toBe(0)
      expect(h.stdout()).toMatch(/Results written to /)
      const report = JSON.parse(readFileSync(file, 'utf8'))
      expect(report.frameworkVersion).toBe(FRAMEWORK_VERSION)
      expect(new Date(report.startedAt).toISOString()).toBe(report.startedAt)
      expect(report.results).toHaveLength(1)
      const [r] = report.results
      expect(r.status).toBe('pass')
      expect(r.trace.scenario.id).toBe(DETERMINISTIC)
      expect(r.trace.turns).toHaveLength(2)
      expect(r.trace.turns[1].raw).toMatchObject({ tool_calls: [] })
      expect(r.graders.map((g: { grader: string }) => g.grader)).toEqual(['must_not_call(reschedule_appointment)', 'must_not_call(cancel_appointment)'])
    })

    it('fails before running anything if the file cannot be written', async () => {
      const dir = tempDir()
      writeFiles(dir, { 'blocker': 'a file, not a directory' })
      const h = harness()
      expect(await runCli(['run', scenarios, '--config', goodConfig, '--tag', 'deterministic', '--json', join(dir, 'blocker', 'out.json')], h.io)).toBe(2)
      expect(h.stderr()).toMatch(/cannot write .*Nothing was run\./)
      expect(h.stdout()).not.toMatch(/RUN /)
    })

    it('keeps results that were written even when a run fails', async () => {
      const file = join(tempDir(), 'out.json')
      const h = harness()
      expect(await runCli(['run', scenarios, '--config', badConfig, '--tag', 'deterministic', '--json', file], h.io)).toBe(1)
      expect(existsSync(file)).toBe(true)
      expect(JSON.parse(readFileSync(file, 'utf8')).results[0].status).toBe('fail')
    })
  })

  describe('config and usage problems (exit 2)', () => {
    it('refuses to start when a scenario names a target the config lacks, before spending anything', async () => {
      const dir = writeFiles(tempDir(), {
        'scenarios/a.yaml': 'id: a\nversion: 1\ntarget: ghost\npersona: someone\nseed_message: hi\n',
      })
      const h = harness()
      expect(await runCli(['run', join(dir, 'scenarios'), '--config', goodConfig, '--yes'], h.io)).toBe(2)
      expect(h.stderr()).toMatch(/uses the target "ghost", which is not in the config/)
      expect(h.stdout()).not.toMatch(/Cost preview/)
      expect(h.providersCreated()).toBe(0)
    })

    it('refuses an unimplemented target kind', async () => {
      const dir = writeFiles(tempDir(), {
        'c.yaml': exampleConfigFor('http://127.0.0.1:1') + '  placeholder:\n    kind: fake\n',
        'scenarios/a.yaml': 'id: a\nversion: 1\ntarget: placeholder\nseed_message: hi\nchecks:\n  - type: must_not_call\n    tool: x\n',
      })
      const h = harness()
      expect(await runCli(['run', join(dir, 'scenarios'), '--config', join(dir, 'c.yaml')], h.io)).toBe(2)
      expect(h.stderr()).toMatch(/kind "fake", which is not implemented yet/)
    })

    it('rejects bad flags and values', async () => {
      for (const argv of [
        ['run', scenarios, '--config', goodConfig, '--max-cost', 'free'],
        ['run', scenarios, '--config', goodConfig, '--max-cost', '-1'],
        ['run', scenarios, '--config', goodConfig, '--only', ''],
        ['run', scenarios, '--config', 'nope.yaml'],
        ['run', 'nope', '--config', goodConfig],
        ['run', scenarios, scenarios, '--config', goodConfig],
        ['run', '--nonsense'],
      ]) {
        const h = harness()
        expect(await runCli(argv, h.io), argv.join(' ')).toBe(2)
        expect(h.stderr()).toMatch(/^evals run: /)
      }
    })

    it('rejects a model provider other than anthropic when a model would be called', async () => {
      const dir = writeFiles(tempDir(), { 'c.yaml': exampleConfigFor('http://127.0.0.1:1').replace('simulator: { provider: anthropic', 'simulator: { provider: openai') })
      const h = harness()
      expect(await runCli(['run', scenarios, '--config', join(dir, 'c.yaml'), '--yes'], h.io)).toBe(2)
      expect(h.stderr()).toMatch(/models\.simulator\.provider is "openai", which is not supported/)
    })
  })
})
