import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createStubAgent } from '../../examples/stub-agent/agent.js'
import { runCli } from '../../src/cli/main.js'
import { examples, exampleConfigFor, harness, tempDir, writeFiles } from '../cli/harness.js'
import { raw } from './harness.js'

const scenarios = join(examples, 'scenarios')
const DETERMINISTIC = 'reschedule-asks-before-acting'

describe('evals run saves to .evals/runs', () => {
  const good = createStubAgent()
  const bad = createStubAgent({ defect: 'no-confirm' })
  let goodConfig = ''
  let badConfig = ''
  beforeAll(async () => {
    const dir = tempDir()
    writeFiles(dir, { 'good.yaml': exampleConfigFor(await good.listen()), 'bad.yaml': exampleConfigFor(await bad.listen()) })
    goodConfig = join(dir, 'good.yaml')
    badConfig = join(dir, 'bad.yaml')
  })
  afterAll(async () => {
    await good.close()
    await bad.close()
  })

  const runsOf = (dir: string) => {
    const d = join(dir, '.evals', 'runs')
    return existsSync(d) ? readdirSync(d) : []
  }

  it('writes a suite record by default, with the fields the UI reads, and prints nothing new', async () => {
    const cwd = tempDir('evals-save-')
    const h = harness({ cwd })
    const before = harness({ cwd: tempDir() })
    expect(await runCli(['run', scenarios, '--config', goodConfig, '--only', DETERMINISTIC], h.io)).toBe(0)
    await runCli(['run', scenarios, '--config', goodConfig, '--only', DETERMINISTIC, '--no-save'], before.io)
    // The console output is the same with and without saving.
    const normal = (t: string) => t.replace(/\d+(ms|\.\ds)/g, 'T').replace(/ +/g, ' ')
    expect(normal(h.stdout())).toBe(normal(before.stdout()))
    expect(h.stderr()).toBe('')

    const files = runsOf(cwd)
    expect(files).toHaveLength(1)
    const record = JSON.parse(readFileSync(join(cwd, '.evals', 'runs', files[0]!), 'utf8'))
    expect(record).toMatchObject({
      schemaVersion: 1,
      suiteId: files[0]!.replace(/\.json$/, ''),
      status: 'complete',
      configFile: goodConfig,
      scenarioPath: scenarios,
      summary: { runs: 1, pass: 1, fail: 0, error: 0 },
    })
    expect(record.command).toBe(`evals run ${scenarios} --config ${goodConfig} --only ${DETERMINISTIC}`)
    expect(new Date(record.startedAt).toISOString()).toBe(record.startedAt)
    expect(new Date(record.endedAt).getTime()).toBeGreaterThanOrEqual(new Date(record.startedAt).getTime())
    expect(record.results).toHaveLength(1)
    expect(record.results[0].trace.scenario.id).toBe(DETERMINISTIC)
    expect(record.results[0].trace.turns).toHaveLength(2)
  })

  it('saves a failing run too, and the exit code is unchanged', async () => {
    const cwd = tempDir('evals-save-')
    const h = harness({ cwd })
    expect(await runCli(['run', scenarios, '--config', badConfig, '--only', DETERMINISTIC], h.io)).toBe(1)
    const [file] = runsOf(cwd)
    expect(JSON.parse(readFileSync(join(cwd, '.evals', 'runs', file!), 'utf8')).summary).toMatchObject({ runs: 1, fail: 1 })
  })

  it('--no-save writes nothing, and --json keeps working next to the default', async () => {
    const cwd = tempDir('evals-save-')
    const none = harness({ cwd })
    expect(await runCli(['run', scenarios, '--config', goodConfig, '--only', DETERMINISTIC, '--no-save'], none.io)).toBe(0)
    expect(runsOf(cwd)).toEqual([])
    expect(existsSync(join(cwd, '.evals'))).toBe(false)

    const out = join(cwd, 'results.json')
    const both = harness({ cwd })
    expect(await runCli(['run', scenarios, '--config', goodConfig, '--only', DETERMINISTIC, '--json', out], both.io)).toBe(0)
    expect(JSON.parse(readFileSync(out, 'utf8')).results).toHaveLength(1)
    expect(runsOf(cwd)).toHaveLength(1)
    expect(both.stdout()).toMatch(/Results written to /)
  })

  it('does not save a run that was not confirmed, or one that never started', async () => {
    const cwd = tempDir('evals-save-')
    const h = harness({ cwd, isTTY: false })
    expect(await runCli(['run', scenarios, '--config', goodConfig, '--only', 'reschedule-tomorrow-3pm'], h.io)).toBe(2)
    expect(runsOf(cwd)).toEqual([])
    expect(await runCli(['run', scenarios, '--config', goodConfig, '--only', 'nope'], harness({ cwd }).io)).toBe(2)
    expect(runsOf(cwd)).toEqual([])
  })

  it('warns and carries on when the store cannot be written', async () => {
    const cwd = tempDir('evals-save-')
    writeFileSync(join(cwd, '.evals'), 'a file where the directory should be')
    const h = harness({ cwd })
    expect(await runCli(['run', scenarios, '--config', goodConfig, '--only', DETERMINISTIC], h.io)).toBe(0)
    expect(h.stderr()).toMatch(/Warning: could not save this run under \.evals\/runs/)
    expect(h.stdout()).toMatch(/PASS  reschedule-asks-before-acting/)
  })

  it('uses the workdir, not the shell\'s directory, when one is given', async () => {
    const cwd = tempDir('evals-cwd-')
    const workdir = tempDir('evals-work-')
    const h = harness({ cwd, workdir })
    await runCli(['run', scenarios, '--config', goodConfig, '--only', DETERMINISTIC], h.io)
    expect(runsOf(cwd)).toEqual([])
    expect(runsOf(workdir)).toHaveLength(1)
  })

  it('mentions --no-save in the help', async () => {
    const h = harness()
    await runCli(['run', '--help'], h.io)
    expect(h.stdout()).toMatch(/--no-save/)
    expect(h.stdout()).not.toContain('—')
  })
})

describe('evals ui', () => {
  async function start(args: string[], opts: { cwd?: string; files?: Record<string, string> } = {}) {
    const cwd = opts.cwd ?? writeFiles(tempDir('evals-uicmd-'), { 'evals.config.yaml': exampleConfigFor('http://127.0.0.1:1'), ...(opts.files ?? {}) })
    const stop = new AbortController()
    const opened: string[] = []
    const h = harness({ cwd })
    h.io.signal = stop.signal
    h.io.openUrl = url => void opened.push(url)
    const done = runCli(['ui', ...args], h.io)
    // Wait for the URL line.
    for (let i = 0; i < 200 && !/running at http:/.test(h.stdout()); i++) await new Promise(r => setTimeout(r, 10))
    const match = /running at (http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+))/.exec(h.stdout())
    return { h, cwd, opened, done, stop, url: match?.[1], port: Number(match?.[2]), token: match?.[3] }
  }

  it('starts on 127.0.0.1, prints a URL with a token, serves the API with it, and stops cleanly on the signal', async () => {
    const s = await start(['--port', '0', '--no-open', scenarios])
    expect(s.url).toBeDefined()
    expect(s.token!.length).toBeGreaterThanOrEqual(40)
    expect(s.h.stdout()).toMatch(/Local only: it listens on 127\.0\.0\.1/)
    expect(s.h.stdout()).toMatch(/Data: \.evals/)

    const health = await raw({ port: s.port }, '/api/health', { headers: { authorization: `Bearer ${s.token}` } })
    expect(health.status).toBe(200)
    expect(health.json().scenarioPath).toBe(scenarios)
    expect((await raw({ port: s.port }, '/api/health')).status).toBe(401)
    expect(s.opened).toEqual([])

    s.stop.abort()
    expect(await s.done).toBe(0)
    await expect(raw({ port: s.port }, '/api/health')).rejects.toThrow()
    expect(s.h.stderr()).toBe('')
  })

  it('opens the browser with the tokened URL unless --no-open', async () => {
    const s = await start(['--port', '0', scenarios])
    expect(s.opened).toEqual([s.url])
    s.stop.abort()
    await s.done
  })

  it('serves what the CLI saved: the same store', async () => {
    const cwd = writeFiles(tempDir('evals-uicmd-'), { 'evals.config.yaml': exampleConfigFor('http://127.0.0.1:1') })
    const agent = createStubAgent()
    const config = join(cwd, 'agent.yaml')
    writeFileSync(config, exampleConfigFor(await agent.listen()))
    try {
      expect(await runCli(['run', scenarios, '--config', config, '--only', DETERMINISTIC], harness({ cwd }).io)).toBe(0)
    } finally {
      await agent.close()
    }
    const s = await start(['--port', '0', '--no-open', scenarios], { cwd })
    const suites = await raw({ port: s.port }, '/api/suites', { headers: { authorization: `Bearer ${s.token}` } })
    expect(suites.json().suites).toHaveLength(1)
    expect(suites.json().suites[0].command).toMatch(/^evals run /)
    s.stop.abort()
    await s.done
  })

  it('starts without a config or scenarios, so saved runs can still be viewed', async () => {
    const s = await start(['--port', '0', '--no-open'], { cwd: tempDir('evals-empty-') })
    expect(s.h.stdout()).toMatch(/Config: none found/)
    expect(s.h.stdout()).toMatch(/Scenarios: none found/)
    s.stop.abort()
    expect(await s.done).toBe(0)
  })

  it('takes --labels and --config', async () => {
    const cwd = writeFiles(tempDir('evals-uicmd-'), { 'other.yaml': exampleConfigFor('http://127.0.0.1:1') })
    const s = await start(['--port', '0', '--no-open', '--config', 'other.yaml', '--labels', 'mine/labels.jsonl'], { cwd })
    const health = await raw({ port: s.port }, '/api/health', { headers: { authorization: `Bearer ${s.token}` } })
    expect(health.json()).toMatchObject({ configFile: join(cwd, 'other.yaml'), labelsFile: join(cwd, 'mine', 'labels.jsonl') })
    s.stop.abort()
    await s.done
  })

  it('shows help with exit 0 and no em-dash', async () => {
    const h = harness()
    expect(await runCli(['ui', '--help'], h.io)).toBe(0)
    expect(h.stdout()).toMatch(/Usage: evals ui/)
    expect(h.stdout()).toMatch(/127\.0\.0\.1 only/)
    expect(h.stdout()).not.toContain('—')
    const top = harness()
    await runCli(['--help'], top.io)
    expect(top.stdout()).toMatch(/ui \[path\]/)
  })

  it('exits 2 for usage problems', async () => {
    const cwd = tempDir('evals-uicmd-')
    mkdirSync(join(cwd, 'labels-dir'))
    for (const argv of [
      ['ui', '--port', 'abc'],
      ['ui', '--port', '70000'],
      ['ui', '--port', '-1'],
      ['ui', '--config', 'missing.yaml'],
      ['ui', 'does-not-exist'],
      ['ui', scenarios, scenarios],
      ['ui', '--labels', 'labels-dir'],
      ['ui', '--nonsense'],
    ]) {
      const h = harness({ cwd })
      h.io.signal = AbortSignal.abort()
      expect(await runCli(argv, h.io), argv.join(' ')).toBe(2)
      expect(h.stderr()).toMatch(/^evals ui: /)
    }
  })

  it('exits 2 when the port is taken, and says how to pick another', async () => {
    const blocker = createServer()
    await new Promise<void>(r => blocker.listen(0, '127.0.0.1', r))
    const port = (blocker.address() as { port: number }).port
    try {
      const h = harness({ cwd: tempDir() })
      h.io.signal = AbortSignal.abort()
      expect(await runCli(['ui', '--port', String(port), '--no-open'], h.io)).toBe(2)
      expect(h.stderr()).toMatch(/port \d+ is already in use\. Pass --port <n>, or --port 0/)
    } finally {
      await new Promise<void>(r => blocker.close(() => r()))
    }
  })
})
