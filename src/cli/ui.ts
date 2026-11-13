import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { startUiServer, type UiServer } from '../server/index.js'
import { abs, DEFAULT_CONFIG, parseOrUsage, print, requireFile, scenariosPath, shown, UsageError, type CliIo } from './common.js'

export const DEFAULT_UI_PORT = 4747

export const UI_HELP = `Usage: evals ui [path] [options]

Starts the local web UI: charts and a run list for saved runs, a button to run
scenarios and calibration, and a review queue for labelling outputs. It reads
and writes the same files the command line does (.evals/ and the label file).

The server listens on 127.0.0.1 only and requires a random access token, which
is printed in the URL it shows at startup. Open that URL, not the bare address.
It can call a model only after a cost preview has been confirmed in the page.

Arguments:
  path              The scenarios file or directory the page lists and runs.
                    Default: ./scenarios, if it exists.

Options:
  --port <n>        Port to listen on. Default: ${DEFAULT_UI_PORT}. Use 0 for any free port.
  --config <file>   Config file. Default: ${DEFAULT_CONFIG} in the current directory, if present.
  --labels <file>   Label file the review queue writes. Default: .evals/labels.jsonl.
  --no-open         Do not open a browser.
  -h, --help        Show this help.

Model calls use the key in this process's environment (ANTHROPIC_API_KEY). The
page never asks for one and the API does not accept one.

Exit codes: 0 stopped cleanly, 2 usage problem or the port is in use.
`

function defaultOpen(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  // No shell, so nothing in the URL is interpreted. A missing opener is not an error.
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
  child.on('error', () => {})
  child.unref()
}

export async function uiCommand(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        port: { type: 'string' },
        config: { type: 'string' },
        labels: { type: 'string' },
        'no-open': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }),
  )
  if (values.help) {
    io.stdout(UI_HELP)
    return 0
  }
  if (positionals.length > 1) throw new UsageError(`expected at most one path, got ${positionals.length}`)

  let port = DEFAULT_UI_PORT
  if (values.port !== undefined) {
    port = Number(values.port)
    if (!/^\d+$/.test(values.port) || port > 65535) throw new UsageError(`--port must be a number from 0 to 65535, got "${values.port}"`)
  }

  const workdir = io.workdir ?? io.cwd
  // The config and the scenarios are optional for looking at saved runs. A path
  // that was named and is not there is still a usage problem.
  const configFile =
    values.config !== undefined ? requireFile(io, values.config, 'config file') : existsSync(abs(io, DEFAULT_CONFIG)) ? abs(io, DEFAULT_CONFIG) : null
  let scenarioPath: string | null = null
  if (positionals[0] !== undefined) scenarioPath = scenariosPath(io, positionals[0])
  else if (existsSync(abs(io, 'scenarios')) && statSync(abs(io, 'scenarios')).isDirectory()) scenarioPath = abs(io, 'scenarios')

  let labelsFile: string | undefined
  if (values.labels !== undefined) {
    labelsFile = abs(io, values.labels)
    if (existsSync(labelsFile) && !statSync(labelsFile).isFile()) throw new UsageError(`labels file is not a file: ${shown(io, labelsFile)}`)
  }

  let ui: UiServer
  try {
    ui = await startUiServer({ workdir: resolve(workdir), configFile, scenarioPath, labelsFile, port, env: io.env, fetch: io.fetch, createProvider: io.createProvider })
  } catch (e) {
    if ((e as { code?: string }).code === 'EADDRINUSE') {
      throw new UsageError(`port ${port} is already in use. Pass --port <n>, or --port 0 for any free port.`)
    }
    throw e
  }

  const out = (text = '') => print(io.stdout, text)
  out(`evals ui is running at ${ui.url}`)
  out()
  out('Local only: it listens on 127.0.0.1 and needs the token in that link. Press Ctrl+C to stop.')
  out(`Data: ${shown(io, resolve(workdir, '.evals'))}`)
  out(`Config: ${configFile ? shown(io, configFile) : 'none found (pass --config to run scenarios)'}`)
  out(`Scenarios: ${scenarioPath ? shown(io, scenarioPath) : 'none found (pass a path)'}`)

  if (!values['no-open']) (io.openUrl ?? defaultOpen)(ui.url)

  await new Promise<void>(done => {
    if (!io.signal) return // no way to stop: run until the process ends
    if (io.signal.aborted) return done()
    io.signal.addEventListener('abort', () => done(), { once: true })
  })
  await ui.close()
  return 0
}
