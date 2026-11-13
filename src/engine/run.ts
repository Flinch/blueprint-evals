import type { Config } from '../core/config.js'
import type { ModelProvider, Reporter, RunResult } from '../core/interfaces.js'
import type { LoadedScenario } from '../core/load.js'
import { runSuite } from '../core/runner.js'
import { gradersForScenario } from '../graders/for-scenario.js'
import { createPersonaSimulator } from '../simulators/persona.js'
import { createHttpTarget, type HttpTargetConfig } from '../targets/http.js'
import { UsageError } from './errors.js'
import { buildRunPreview, crossCheck, type CrossCheck, type Preview } from './plan.js'

// The cores of `evals run`, shared by the command line and the local server:
// choosing scenarios, planning (the cost preview and the pre-flight checks), and
// executing through runSuite. Neither caller duplicates any of this.

/** How the selection errors name the inputs, so a CLI user sees "--only" and an API caller sees "only". */
export interface SelectionNames {
  only: string
  tags: string
}
const CLI_NAMES: SelectionNames = { only: '--only', tags: '--tag' }

/** Scenarios named by `only` (ids) and carrying any of `tags`. Both narrow the set, and together they intersect. */
export function selectScenarios(
  all: LoadedScenario[],
  only: string[] | undefined,
  tags: string[] | undefined,
  names: SelectionNames = CLI_NAMES,
): LoadedScenario[] {
  let selected = all
  if (only !== undefined) {
    const ids = only.map(s => s.trim()).filter(Boolean)
    if (ids.length === 0) throw new UsageError(`${names.only} needs at least one scenario id`)
    const unknown = ids.filter(id => !all.some(l => l.scenario.id === id))
    if (unknown.length > 0) {
      throw new UsageError(`${names.only} names scenarios that were not found: ${unknown.join(', ')}. Found: ${all.map(l => l.scenario.id).join(', ') || '(none)'}`)
    }
    selected = selected.filter(l => ids.includes(l.scenario.id))
  }
  if (tags && tags.length > 0) selected = selected.filter(l => l.scenario.tags.some(t => tags.includes(t)))
  if (selected.length === 0) {
    throw new UsageError(all.length === 0 ? 'no scenarios were found at that path' : `no scenarios matched ${names.only} and ${names.tags}`)
  }
  return selected
}

/** The config or the scenarios cannot run as they are. `errors` is the list, for a caller that wants it structured. */
export class PlanProblemsError extends UsageError {
  constructor(readonly errors: string[]) {
    super(`${errors.length} problem(s) in the config or scenarios. Nothing was run.\n${errors.map(e => `  - ${e}`).join('\n')}`)
    this.name = 'PlanProblemsError'
  }
}

export interface RunPlanInput {
  config: Config
  /** Every scenario found at the path, before selection. */
  all: LoadedScenario[]
  only?: string[]
  tags?: string[]
  /** A cap given by the caller (a flag, a request). It overrides the config's budget. */
  maxCost?: { usd: number; source: string }
  env: NodeJS.ProcessEnv
  display: (file: string) => string
  names?: SelectionNames
}

export interface RunPlan {
  selected: LoadedScenario[]
  /** The per-scenario cost cap in force, if any. */
  capUsd?: number
  check: CrossCheck
  preview: Preview
}

/**
 * Chooses the scenarios, checks everything that would otherwise fail halfway
 * through, and builds the cost preview. Throws a UsageError for a selection that
 * matches nothing and a PlanProblemsError for config or scenario problems. It
 * calls no model and runs nothing.
 */
export function planRun(input: RunPlanInput): RunPlan {
  const { config } = input
  const selected = selectScenarios(input.all, input.only, input.tags, input.names)
  const check = crossCheck(config, selected, input.env, input.display)
  if (check.errors.length > 0) throw new PlanProblemsError(check.errors)

  const capUsd = input.maxCost?.usd ?? config.budget.maxCostUsd
  const cap =
    capUsd === undefined ? undefined : { usd: capUsd, source: input.maxCost ? input.maxCost.source : 'budget.maxCostUsd in the config' }
  const preview = buildRunPreview(config, selected.map(l => l.scenario), { cap })
  return { selected, capUsd, check, preview }
}

export interface ExecuteRunOptions {
  config: Config
  selected: LoadedScenario[]
  capUsd?: number
  env: NodeJS.ProcessEnv
  fetch?: typeof fetch
  /** Required when the plan's preview says a model can be called. */
  provider?: ModelProvider
  reporters: Reporter[]
  /** Stops the suite: the scenario in flight ends as an error and no further one starts. */
  signal?: AbortSignal
}

/** Runs the selected scenarios through runSuite with the real graders, simulators and budget enforcement. */
export async function executeRun(o: ExecuteRunOptions): Promise<RunResult[]> {
  const { config, selected, capUsd, provider } = o
  // Results the runner never announced (a scenario that could not be set up) are replayed afterwards.
  const announced = new Set<string>()
  const tracker: Reporter = { onEvent: e => void (e.type === 'run:end' && announced.add(e.runId)) }
  const reporters = [...o.reporters, tracker]

  const results = await runSuite(
    selected.map(l => l.scenario),
    scenario => {
      const loaded = selected.find(l => l.scenario === scenario)!
      const target = createHttpTarget(scenario.target, config.targets[scenario.target] as HttpTargetConfig, { env: o.env, fetch: o.fetch })
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
        signal: o.signal,
      }
    },
    { signal: o.signal },
  )

  for (const result of results) {
    if (announced.has(result.trace.runId)) continue
    for (const r of o.reporters) await r.onEvent({ type: 'run:end', runId: result.trace.runId, result })
  }
  return results
}
