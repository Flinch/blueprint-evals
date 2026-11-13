import { createInterface } from 'node:readline/promises'
import { FRAMEWORK_VERSION } from '../core/version.js'
import { calibrateCommand } from './calibrate.js'
import { print, UsageError, type CliIo } from './common.js'
import { runCommand } from './run.js'
import { validateCommand } from './validate.js'

export type { CliIo } from './common.js'

const USAGE = `evals ${FRAMEWORK_VERSION}: test AI agents with simulated users and calibrated judges

Usage: evals <command> [options]

Commands:
  validate [path]    Check the config, scenarios and labels. Costs nothing.
  run [path]         Run scenarios and grade them. Shows a cost preview first.
  calibrate          Measure a rubric judge against human labels.

Run "evals <command> --help" for the options of a command.

Exit codes: 0 success, 1 a test or validation failure, 2 usage or config problem.
`

const COMMANDS: Record<string, (argv: string[], io: CliIo) => Promise<number>> = {
  validate: validateCommand,
  run: runCommand,
  calibrate: calibrateCommand,
}

/** Runs the CLI and returns the exit code. It never throws and never exits the process. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [name, ...rest] = argv

  if (name === undefined) {
    io.stderr(USAGE)
    return 2
  }
  if (name === '--help' || name === '-h' || name === 'help') {
    io.stdout(USAGE)
    return 0
  }
  if (name === '--version' || name === '-v') {
    print(io.stdout, FRAMEWORK_VERSION)
    return 0
  }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined
  if (!command) {
    print(io.stderr, `Unknown command "${name}".\n`)
    io.stderr(USAGE)
    return 2
  }

  try {
    return await command(rest, io)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (e instanceof UsageError) {
      print(io.stderr, `evals ${name}: ${message}`)
      print(io.stderr, `Run "evals ${name} --help" for usage.`)
    } else {
      print(io.stderr, `evals ${name}: unexpected error: ${message}`)
    }
    return 2
  }
}

/** The real entry point: wires the process streams and a readline prompt, then runs. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const io: CliIo = {
    stdout: text => void process.stdout.write(text),
    stderr: text => void process.stderr.write(text),
    env: process.env,
    cwd: process.cwd(),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    async confirm(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      try {
        return /^y(es)?$/i.test((await rl.question(`${question} `)).trim())
      } finally {
        rl.close()
      }
    },
  }
  return runCli(argv, io)
}
