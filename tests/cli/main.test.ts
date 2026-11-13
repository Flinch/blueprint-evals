import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../../src/cli/main.js'
import { createConsoleReporter, createJsonReporter, FRAMEWORK_VERSION } from '../../src/index.js'
import type { RunResult } from '../../src/index.js'
import { makeTrace } from '../helpers.js'
import { examples, harness, tempDir } from './harness.js'

describe('evals (dispatch)', () => {
  it('prints usage to stderr and exits 2 with no command', async () => {
    const h = harness()
    expect(await runCli([], h.io)).toBe(2)
    expect(h.stderr()).toMatch(/Usage: evals <command>/)
    expect(h.stdout()).toBe('')
  })

  it('prints usage and exits 2 on an unknown command', async () => {
    const h = harness()
    expect(await runCli(['deploy'], h.io)).toBe(2)
    expect(h.stderr()).toMatch(/Unknown command "deploy"\./)
    expect(h.stderr()).toMatch(/validate \[path\]/)
  })

  it('does not treat object prototype names as commands', async () => {
    const h = harness()
    expect(await runCli(['constructor'], h.io)).toBe(2)
    expect(h.stderr()).toMatch(/Unknown command "constructor"/)
  })

  it('shows help, with exit 0, at the top level and for every command', async () => {
    const texts: string[] = []
    for (const argv of [['--help'], ['validate', '--help'], ['run', '--help'], ['calibrate', '-h']]) {
      const h = harness()
      expect(await runCli(argv, h.io), argv.join(' ')).toBe(0)
      expect(h.stderr()).toBe('')
      texts.push(h.stdout())
    }
    expect(texts[0]).toMatch(/Commands:/)
    expect(texts[1]).toMatch(/Usage: evals validate/)
    expect(texts[2]).toMatch(/--yes/)
    expect(texts[2]).toMatch(/Exit codes: 0 every run passed, 1 a run failed or errored, 2/)
    expect(texts[3]).toMatch(/--split dev\|test/)
    // No em-dashes in anything a user reads.
    for (const t of texts) expect(t).not.toContain('—')
  })

  it('prints the version', async () => {
    const h = harness()
    expect(await runCli(['--version'], h.io)).toBe(0)
    expect(h.stdout().trim()).toBe(FRAMEWORK_VERSION)
  })

  it('has no em-dashes in its previews and errors either', async () => {
    const h = harness()
    await runCli(['run', join(examples, 'scenarios'), '--config', join(examples, 'evals.config.yaml')], h.io)
    await runCli(['validate', join(examples, 'scenarios'), '--config', join(examples, 'evals.config.yaml')], h.io)
    expect(h.stdout() + h.stderr()).not.toContain('—')
  })
})

function result(over: Partial<RunResult> = {}): RunResult {
  return {
    trace: makeTrace([]),
    graders: [],
    status: 'pass',
    score: 1,
    goalAchieved: true,
    costUsd: 0.0123,
    durationMs: 1500,
    warnings: [],
    ...over,
  }
}

describe('console reporter', () => {
  it('prints a line at start and end, the failures with critiques, and a summary', () => {
    let out = ''
    const r = createConsoleReporter(t => void (out += t))
    const failing = result({
      status: 'fail',
      score: 0.5,
      goalAchieved: false,
      graders: [
        { grader: 'must_not_call(x)', status: 'fail', reason: 'x was called at turn 1' },
        {
          grader: 'rubric-judge(r@1)',
          status: 'fail',
          reason: 'Failed: c1',
          criteria: [
            { id: 'c1', verdict: 'fail', critique: 'Line one.\n  Line two.', weight: 1, critical: true },
            { id: 'c2', verdict: 'pass', critique: 'fine', weight: 1, critical: false },
          ],
        },
      ],
      warnings: ['Look at this.'],
    })
    r.onEvent({ type: 'run:start', runId: 'r1', scenarioId: 's' })
    r.onEvent({ type: 'turn', runId: 'r1', turn: { index: 0, role: 'user', content: 'hi', at: 'x' } })
    r.onEvent({ type: 'run:end', runId: 'r1', result: failing })
    r.onEvent({ type: 'run:end', runId: 'r2', result: result({ costUsd: null, goalAchieved: null, score: null, status: 'error', error: 'target blew up' }) })
    r.printSummary()

    expect(out).toMatch(/^RUN   s\n/)
    expect(out).toMatch(/FAIL  s  score 0\.50  goal no  cost \$0\.0123  1\.5s/)
    expect(out).toMatch(/failed check: must_not_call\(x\): x was called at turn 1/)
    expect(out).toMatch(/failed criterion: c1 \(critical\): Line one\. Line two\./)
    expect(out).not.toMatch(/c2/)
    expect(out).toMatch(/ERROR s  score -  goal -  cost unknown/)
    expect(out).toMatch(/error: target blew up/)
    expect(out).toMatch(/Runs: 2 {3}pass 0 {3}fail 1 {3}error 1/)
    expect(out).toMatch(/Goal achieved: 0 of 1/)
    expect(out).toMatch(/Total cost: unknown/)
    expect(out).toMatch(/Warnings\n {2}- Look at this\./)
  })

  it('adds up the cost when every run has one', () => {
    let out = ''
    const r = createConsoleReporter(t => void (out += t))
    r.onEvent({ type: 'run:end', runId: 'a', result: result({ costUsd: 0.5 }) })
    r.onEvent({ type: 'run:end', runId: 'b', result: result({ costUsd: 0.25 }) })
    r.printSummary()
    expect(out).toMatch(/Total cost: \$0\.75/)
  })
})

describe('json reporter', () => {
  it('writes the file on flush and again after every run, creating the directory', () => {
    const file = join(tempDir(), 'deep', 'out.json')
    const r = createJsonReporter(file, { startedAt: new Date('2026-11-12T00:00:00.000Z') })
    r.flush()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ frameworkVersion: FRAMEWORK_VERSION, startedAt: '2026-11-12T00:00:00.000Z', results: [] })
    r.onEvent({ type: 'run:start', runId: 'a', scenarioId: 's' })
    r.onEvent({ type: 'run:end', runId: 'a', result: result() })
    const written = JSON.parse(readFileSync(file, 'utf8'))
    expect(written.results).toHaveLength(1)
    expect(written.results[0].trace.scenario.id).toBe('s')
    expect(r.results).toHaveLength(1)
  })
})
