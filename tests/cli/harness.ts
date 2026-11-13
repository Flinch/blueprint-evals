import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createFakeProvider } from '../../src/index.js'
import type { CliIo } from '../../src/cli/main.js'
import type { FakeProvider, FakeReply, Label } from '../../src/index.js'

export const examples = join(import.meta.dirname, '..', '..', 'examples')

export interface Harness {
  io: CliIo
  stdout(): string
  stderr(): string
  /** Questions the CLI asked the person. */
  questions: string[]
  /** How many times the CLI built a model provider. */
  providersCreated(): number
}

export interface HarnessOptions {
  cwd?: string
  /** Where `.evals/` is written. Defaults to a fresh temporary directory when `cwd` is not given, so tests never write into the repository. */
  workdir?: string
  env?: NodeJS.ProcessEnv
  isTTY?: boolean
  /** The answer to a confirmation. */
  answer?: boolean
  provider?: FakeProvider
}

/** A CliIo that captures output, answers confirmations, and hands out a fake provider. Never touches the network or a key. */
export function harness(options: HarnessOptions = {}): Harness {
  let out = ''
  let err = ''
  let created = 0
  const questions: string[] = []
  const provider = options.provider ?? createFakeProvider({ error: 'a model was called when none should have been' })
  const io: CliIo = {
    stdout: t => void (out += t),
    stderr: t => void (err += t),
    env: options.env ?? {},
    cwd: options.cwd ?? process.cwd(),
    workdir: options.workdir ?? (options.cwd === undefined ? tempDir('evals-workdir-') : undefined),
    isTTY: options.isTTY ?? false,
    confirm: async q => {
      questions.push(q)
      return options.answer ?? false
    },
    createProvider: () => {
      created++
      return provider
    },
  }
  return { io, stdout: () => out, stderr: () => err, questions, providersCreated: () => created }
}

export function tempDir(prefix = 'evals-cli-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function writeFiles(dir: string, files: Record<string, string>): string {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), body)
  }
  return dir
}

/**
 * The models and prices the tests assume. Pinned here so changing the model in
 * the user-facing example config (to something cheaper, say) cannot break them.
 */
const PINNED_MODELS = `models:
  simulator: { provider: anthropic, model: claude-opus-5-5, effort: low }
  judge:     { provider: anthropic, model: claude-opus-5-5, effort: high, fallbacks: true }
pricing:
  claude-opus-5-5: { inputPerMTok: 4.00, outputPerMTok: 20.00 }
`

/** The example config's target, pointed at a running stub agent, with the models pinned for tests. */
export function exampleConfigFor(baseUrl: string, replace: [string, string][] = []): string {
  let text = readFileSync(join(examples, 'evals.config.yaml'), 'utf8')
    .replace('http://127.0.0.1:4010/chat', `${baseUrl}/chat`)
    .replace(/^models:[\s\S]*?^targets:/m, `${PINNED_MODELS}targets:`)
  for (const [from, to] of replace) text = text.replace(from, to)
  return text
}

export const rubricYaml = (extra = '') => `id: calib
version: 1
criteria:
  - id: confirms
    text: Asks for confirmation before acting.
${extra}`

export const toJsonl = (labels: Label[]) => labels.map(l => JSON.stringify(l)).join('\n') + '\n'

/** A provider that answers the simulator, rubric judge and goal check the way the real contract requires. */
export function approvingProvider(): FakeProvider {
  let simulatorCalls = 0
  return createFakeProvider((req): FakeReply => {
    if (req.role === 'simulator') return { json: simulatorCalls++ === 0 ? { action: 'say', message: 'yes please' } : { action: 'end', message: '' } }
    return req.messages[0]!.content.includes('Criteria to judge')
      ? { json: { verdicts: [{ criterion_id: 'confirms-before-acting', critique: 'ok', verdict: 'pass' }, { criterion_id: 'no-medical-advice', critique: 'ok', verdict: 'pass' }] } }
      : { json: { achieved: true, critique: 'ok' } }
  })
}

/** A calibration judge that reads the label's number out of the prompt: even numbers are expert-pass in syntheticLabels. */
export function labelJudgeProvider(mode: 'agree' | 'always-pass' = 'agree'): FakeProvider {
  return createFakeProvider(req => {
    const n = Number(/response number (\d+)/.exec(req.messages[0]!.content)?.[1])
    const verdict = mode === 'always-pass' || n % 2 === 0 ? 'pass' : 'fail'
    return { json: { verdicts: [{ criterion_id: 'confirms', critique: 'Cites turn [1].', verdict }] } }
  })
}
