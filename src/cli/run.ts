import { parseArgs } from 'node:util'
import type { ModelProvider } from '../core/interfaces.js'
import { loadConfig, loadScenarios } from '../core/load.js'
import { executeRun, planRun } from '../engine/run.js'
import { createConsoleReporter } from '../reporters/console.js'
import { createJsonReporter } from '../reporters/json.js'
import { createSuiteWriter, storePaths, type SuiteWriter } from '../store/index.js'
import {
  abs, confirmSpend, configPath, DEFAULT_CONFIG, defaultProvider, orUsage, parseMaxCost, parseOrUsage, print, scenariosPath, shown, UsageError, type CliIo,
} from './common.js'

export const RUN_HELP = `Usage: evals run [path] [options]

Runs scenarios against their targets and grades them. Before anything that
could cost money, it prints a cost preview and asks you to confirm.

Arguments:
  path                A scenario file or a directory searched recursively.
                      Default: ./scenarios, if it exists.

Options:
  --config <file>     Config file. Default: ${DEFAULT_CONFIG} in the current directory.
  --only <ids>        Run only these scenario ids, comma separated.
  --tag <tag>         Run only scenarios with this tag. Repeat for several (any match).
  --yes               Skip the confirmation. Required when there is no terminal (CI).
  --json <file>       Write every result, with full traces, to this file.
  --max-cost <usd>    Per-scenario cost cap in US dollars. Overrides budget.maxCostUsd.
  --no-save           Do not save the run to .evals/runs/ (the local web UI reads it from there).
  -h, --help          Show this help.

Scenarios with no model calls (checks only, with a seed message and no persona,
rubric or goal) run without a confirmation.

Exit codes: 0 every run passed, 1 a run failed or errored, 2 usage or config
problem, or the run was not confirmed.
`

export async function runCommand(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        only: { type: 'string' },
        tag: { type: 'string', multiple: true },
        yes: { type: 'boolean' },
        json: { type: 'string' },
        'max-cost': { type: 'string' },
        'no-save': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }),
  )
  if (values.help) {
    io.stdout(RUN_HELP)
    return 0
  }
  if (positionals.length > 1) throw new UsageError(`expected at most one path, got ${positionals.length}`)
  const maxCostFlag = parseMaxCost(values['max-cost'])

  const configFile = configPath(io, values.config)
  const config = orUsage(() => loadConfig(configFile))
  const scenarioPath = scenariosPath(io, positionals[0])
  const all = orUsage(() => loadScenarios(scenarioPath))

  // Anything that would only fail halfway through is reported now, before money is spent.
  const { selected, capUsd, check, preview } = planRun({
    config,
    all,
    only: values.only?.split(','),
    tags: values.tag,
    maxCost: maxCostFlag === undefined ? undefined : { usd: maxCostFlag, source: '--max-cost' },
    env: io.env,
    display: f => shown(io, f),
  })

  const out = (text = '') => print(io.stdout, text)
  for (const w of check.warnings) out(`Warning: ${w}`)
  for (const line of preview.lines) out(line)
  out()

  if (preview.anyModelCalls) {
    const decision = await confirmSpend(io, Boolean(values.yes), 'This run')
    if (decision === 'declined') {
      out('Not confirmed. Nothing was run and nothing was spent.')
      return 2
    }
  }

  const consoleReporter = createConsoleReporter(io.stdout)
  const jsonReporter = values.json ? createJsonReporter(abs(io, values.json)) : undefined
  if (jsonReporter) {
    try {
      jsonReporter.flush()
    } catch (e) {
      throw new UsageError(`cannot write ${values.json}: ${e instanceof Error ? e.message : String(e)}. Nothing was run.`)
    }
  }

  let provider: ModelProvider | undefined
  if (preview.anyModelCalls) {
    try {
      provider = (io.createProvider ?? defaultProvider)(config)
    } catch (e) {
      throw new UsageError(`cannot create the model provider: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Every run is saved to <workdir>/.evals/runs/ so the local web UI can show it.
  // A directory that cannot be written is a warning: the run itself still matters.
  let writer: SuiteWriter | undefined
  if (!values['no-save']) {
    const dir = storePaths(io.workdir ?? io.cwd).runs
    const candidate = createSuiteWriter({ dir, command: `evals run ${argv.join(' ')}`.trim(), configFile, scenarioPath })
    try {
      candidate.start()
      writer = candidate
    } catch (e) {
      print(io.stderr, `Warning: could not save this run under ${shown(io, dir)}: ${e instanceof Error ? e.message : String(e)}. The run continues unsaved.`)
    }
  }

  const results = await executeRun({
    config,
    selected,
    capUsd,
    env: io.env,
    fetch: io.fetch,
    provider,
    reporters: [consoleReporter, ...(jsonReporter ? [jsonReporter] : []), ...(writer ? [writer] : [])],
  })

  consoleReporter.printSummary()
  if (values.json) out(`\nResults written to ${values.json}`)
  if (writer) {
    writer.finish()
    for (const w of writer.warnings) print(io.stderr, `Warning: ${w}`)
  }

  return results.every(r => r.status === 'pass') ? 0 : 1
}
