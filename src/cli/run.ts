import { parseArgs } from 'node:util'
import type { ModelProvider, Reporter, RunResult } from '../core/interfaces.js'
import { loadConfig, loadScenarios, type LoadedScenario } from '../core/load.js'
import { runSuite } from '../core/runner.js'
import { gradersForScenario } from '../graders/for-scenario.js'
import { createConsoleReporter } from '../reporters/console.js'
import { createJsonReporter } from '../reporters/json.js'
import { createPersonaSimulator } from '../simulators/persona.js'
import { createHttpTarget, type HttpTargetConfig } from '../targets/http.js'
import {
  abs, confirmSpend, configPath, DEFAULT_CONFIG, defaultProvider, orUsage, parseMaxCost, parseOrUsage, print, scenariosPath, shown, UsageError, type CliIo,
} from './common.js'
import { buildRunPreview, crossCheck } from './plan.js'

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
  const all = orUsage(() => loadScenarios(scenariosPath(io, positionals[0])))
  const selected = select(all, values.only, values.tag)

  // Anything that would only fail halfway through is reported now, before money is spent.
  const check = crossCheck(config, selected, io.env, f => shown(io, f))
  if (check.errors.length > 0) {
    throw new UsageError(`${check.errors.length} problem(s) in the config or scenarios. Nothing was run.\n${check.errors.map(e => `  - ${e}`).join('\n')}`)
  }

  const out = (text = '') => print(io.stdout, text)
  for (const w of check.warnings) out(`Warning: ${w}`)

  const capUsd = maxCostFlag ?? config.budget.maxCostUsd
  const preview = buildRunPreview(config, selected.map(l => l.scenario), {
    cap: capUsd === undefined ? undefined : { usd: capUsd, source: maxCostFlag !== undefined ? '--max-cost' : 'budget.maxCostUsd in the config' },
  })
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
  // Results the runner never announced (a scenario that could not be set up) are replayed afterwards.
  const announced = new Set<string>()
  const tracker: Reporter = { onEvent: e => void (e.type === 'run:end' && announced.add(e.runId)) }
  const reporters = [consoleReporter, ...(jsonReporter ? [jsonReporter] : []), tracker]

  let provider: ModelProvider | undefined
  if (preview.anyModelCalls) {
    try {
      provider = (io.createProvider ?? defaultProvider)(config)
    } catch (e) {
      throw new UsageError(`cannot create the model provider: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const results = await runSuite(
    selected.map(l => l.scenario),
    scenario => {
      const loaded = selected.find(l => l.scenario === scenario)!
      const target = createHttpTarget(scenario.target, config.targets[scenario.target] as HttpTargetConfig, { env: io.env, fetch: io.fetch })
      const simulator =
        provider && scenario.mode === 'conversational' && scenario.persona
          ? createPersonaSimulator({ provider, timeoutMs: config.timeouts.simulatorMs, effort: config.models.simulator.effort })
          : undefined
      return {
        target,
        simulator,
        graders: gradersForScenario(scenario, {
          rubric: loaded.rubric,
          provider,
          judgeEffort: config.models.judge.effort,
          judgeTimeoutMs: config.timeouts.judgeMs,
        }),
        reporters,
        budget: capUsd === undefined ? undefined : { maxCostUsd: capUsd },
        shortCircuit: config.shortCircuit,
        metadata: { tags: scenario.tags },
      }
    },
  )

  for (const result of results) await replayIfUnannounced(result, announced, [consoleReporter, ...(jsonReporter ? [jsonReporter] : [])])
  consoleReporter.printSummary()
  if (values.json) out(`\nResults written to ${values.json}`)

  return results.every(r => r.status === 'pass') ? 0 : 1
}

function select(all: LoadedScenario[], only: string | undefined, tags: string[] | undefined): LoadedScenario[] {
  let selected = all
  if (only !== undefined) {
    const ids = only.split(',').map(s => s.trim()).filter(Boolean)
    if (ids.length === 0) throw new UsageError('--only needs at least one scenario id')
    const unknown = ids.filter(id => !all.some(l => l.scenario.id === id))
    if (unknown.length > 0) {
      throw new UsageError(`--only names scenarios that were not found: ${unknown.join(', ')}. Found: ${all.map(l => l.scenario.id).join(', ') || '(none)'}`)
    }
    selected = selected.filter(l => ids.includes(l.scenario.id))
  }
  if (tags && tags.length > 0) selected = selected.filter(l => l.scenario.tags.some(t => tags.includes(t)))
  if (selected.length === 0) {
    throw new UsageError(all.length === 0 ? 'no scenarios were found at that path' : 'no scenarios matched --only and --tag')
  }
  return selected
}

async function replayIfUnannounced(result: RunResult, announced: Set<string>, reporters: Reporter[]) {
  if (announced.has(result.trace.runId)) return
  for (const r of reporters) await r.onEvent({ type: 'run:end', runId: result.trace.runId, result })
}
