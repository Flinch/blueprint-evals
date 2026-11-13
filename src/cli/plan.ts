import type { Config } from '../core/config.js'
import type { LoadedScenario } from '../core/load.js'
import type { Scenario } from '../core/scenario.js'
import type { Effort } from '../core/trace.js'
import { formatUsd } from '../reporters/console.js'

// What a set of scenarios will do before anything runs: which of them need a
// model, how many calls that can be at most, what could go wrong with the
// config, and the cost preview the CLI shows before it spends anything.

/** Defaults the simulator and the judges use when the config gives no effort. */
export const DEFAULT_EFFORT = { simulator: 'low', judge: 'high' } as const satisfies Record<string, Effort>

export interface ModelNeeds {
  /** Upper bound: the persona simulator is asked for at most max_turns turns. */
  simulatorCalls: number
  rubricCalls: number
  goalCalls: number
}

/** The model calls one scenario can make, at most. */
export function modelNeeds(scenario: Scenario): ModelNeeds {
  const persona = scenario.mode === 'conversational' && Boolean(scenario.persona)
  return {
    simulatorCalls: persona ? scenario.max_turns : 0,
    rubricCalls: scenario.rubric ? 1 : 0,
    goalCalls: scenario.goal ? 1 : 0,
  }
}

export const needsModel = (n: ModelNeeds) => n.simulatorCalls + n.rubricCalls + n.goalCalls > 0
export const scenarioNeedsModel = (s: Scenario) => needsModel(modelNeeds(s))

// ------------------------------------------------------- config cross-checks

export interface EnvRef {
  name: string
  targets: string[]
  isSet: boolean
}

export interface CrossCheck {
  errors: string[]
  warnings: string[]
  envRefs: EnvRef[]
}

const ENV_REFS = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g

function envNamesIn(text: string): string[] {
  return [...text.matchAll(ENV_REFS)].map(m => m[1]!)
}

/**
 * Problems between the scenarios and the config that would otherwise surface
 * mid-run. Only targets that the given scenarios use are looked at. Environment
 * variable names are listed and never their values.
 */
export function crossCheck(config: Config, scenarios: LoadedScenario[], env: NodeJS.ProcessEnv, display: (file: string) => string): CrossCheck {
  const errors: string[] = []
  const warnings: string[] = []
  const used = new Map<string, string[]>() // target name -> scenario ids

  for (const { scenario, file } of scenarios) {
    if (!(scenario.target in config.targets)) {
      const known = Object.keys(config.targets)
      errors.push(
        `Scenario "${scenario.id}" (${display(file)}) uses the target "${scenario.target}", which is not in the config. ` +
          (known.length > 0 ? `Targets in the config: ${known.join(', ')}.` : 'The config defines no targets.'),
      )
      continue
    }
    used.set(scenario.target, [...(used.get(scenario.target) ?? []), scenario.id])
  }

  const refs = new Map<string, Set<string>>()
  for (const name of used.keys()) {
    const target = config.targets[name]!
    if (target.kind !== 'http') {
      errors.push(`Target "${name}" has kind "${target.kind}", which is not implemented yet. Only "http" targets can run.`)
    } else if (target.toolCalls !== undefined && target.toolCalls !== 'none' && !target.response.toolCalls) {
      errors.push(`Target "${name}" declares toolCalls: ${target.toolCalls} but has no response.toolCalls mapping.`)
    }

    // Only the places the framework resolves references: http headers and the vapi key.
    const texts = target.kind === 'http' ? Object.values(target.headers) : target.kind === 'vapi-chat' ? [target.apiKey] : []
    for (const text of texts) {
      for (const ref of envNamesIn(text)) refs.set(ref, (refs.get(ref) ?? new Set()).add(name))
    }
  }

  const envRefs: EnvRef[] = [...refs].map(([name, targets]) => ({
    name,
    targets: [...targets],
    isSet: env[name] !== undefined && env[name] !== '',
  }))
  for (const r of envRefs) {
    if (!r.isSet) warnings.push(`Environment variable ${r.name} is not set (used by target ${r.targets.map(t => `"${t}"`).join(', ')}).`)
  }

  errors.push(...providerErrors(config, scenarios.some(l => modelNeeds(l.scenario).simulatorCalls > 0), scenarios.some(l => modelNeeds(l.scenario).rubricCalls + modelNeeds(l.scenario).goalCalls > 0)))
  return { errors, warnings, envRefs }
}

/** Only the Anthropic provider exists. A config naming another one fails here instead of silently using Anthropic. */
export function providerErrors(config: Config, simulator: boolean, judge: boolean): string[] {
  const errors: string[] = []
  if (simulator && config.models.simulator.provider !== 'anthropic') {
    errors.push(`models.simulator.provider is "${config.models.simulator.provider}", which is not supported. Only "anthropic" is.`)
  }
  if (judge && config.models.judge.provider !== 'anthropic') {
    errors.push(`models.judge.provider is "${config.models.judge.provider}", which is not supported. Only "anthropic" is.`)
  }
  return errors
}

// ------------------------------------------------------------ cost preview

export interface Preview {
  lines: string[]
  /** True when at least one model call is possible. Gates the confirmation. */
  anyModelCalls: boolean
}

export interface PreviewOptions {
  /** USD per run, and where it came from. */
  cap?: { usd: number; source: string }
}

const effortText = (effort: Effort | undefined, fallback: Effort) => (effort ? `effort ${effort}` : `effort ${fallback}, the default`)

/** Models used in a run, and a warning for each one the pricing table does not cover. */
function unpricedWarnings(config: Config, roles: ('simulator' | 'judge')[], consequence: string): string[] {
  const models = [...new Set(roles.map(r => config.models[r].model))]
  return models
    .filter(m => !(m in config.pricing))
    .map(m => `WARNING: no price for model "${m}" in the config's pricing table. ${consequence}`)
}

const RUN_UNPRICED = 'Its cost will be reported as unknown, and a cost cap cannot be enforced: a run with a cap stops with an error at its first model call.'

/** What `evals run` is about to do, and the most it could cost. */
export function buildRunPreview(config: Config, scenarios: Scenario[], options: PreviewOptions = {}): Preview {
  const needs = scenarios.map(modelNeeds)
  const withModel = needs.filter(needsModel).length
  const sum = (pick: (n: ModelNeeds) => number) => needs.reduce((total, n) => total + pick(n), 0)
  const simulatorCalls = sum(n => n.simulatorCalls)
  const rubricCalls = sum(n => n.rubricCalls)
  const goalCalls = sum(n => n.goalCalls)
  const judgeCalls = rubricCalls + goalCalls

  const lines = ['Cost preview', `  Scenarios: ${scenarios.length} selected, ${withModel} call a model, ${scenarios.length - withModel} deterministic only`]
  if (withModel === 0) {
    lines.push('  No model calls will be made, so this run costs nothing.')
    return { lines, anyModelCalls: false }
  }

  const roles: ('simulator' | 'judge')[] = []
  if (simulatorCalls > 0) {
    roles.push('simulator')
    const m = config.models.simulator
    lines.push(`  Simulator calls: up to ${simulatorCalls} (${m.model}, ${effortText(m.effort, DEFAULT_EFFORT.simulator)})`)
  }
  if (judgeCalls > 0) {
    roles.push('judge')
    const m = config.models.judge
    lines.push(
      `  Judge calls: up to ${judgeCalls} (${m.model}, ${effortText(m.effort, DEFAULT_EFFORT.judge)}): ${rubricCalls} rubric judge, ${goalCalls} goal check`,
    )
  }
  lines.push('  These are upper bounds. A failed deterministic check skips the judge calls, and a simulated user can end a conversation early.')

  const { cap } = options
  if (cap) {
    lines.push(`  Cost cap per scenario: ${formatUsd(cap.usd)} (${cap.source})`)
    lines.push(`  Worst-case total: ${formatUsd(cap.usd * withModel)} (${withModel} scenarios x ${formatUsd(cap.usd)})`)
    lines.push('  The cap is checked between model calls, so one call can run past it.')
  } else {
    lines.push('  WARNING: no cost cap is set, so spend is not limited. Set budget.maxCostUsd in the config or pass --max-cost.')
  }
  lines.push(...unpricedWarnings(config, roles, RUN_UNPRICED).map(w => `  ${w}`))
  return { lines, anyModelCalls: true }
}

/** What `evals calibrate` is about to do. One judge call per label, so the call count is exact. */
export function buildCalibratePreview(config: Config, judgements: number, split: string, selection: string): Preview {
  const m = config.models.judge
  const lines = [
    'Cost preview',
    `  Judgements: ${judgements} (${selection} labels in the ${split} split), one judge call each`,
  ]
  if (judgements === 0) {
    lines.push('  No model calls will be made, so this costs nothing.')
    return { lines, anyModelCalls: false }
  }
  lines.push(`  Judge: ${m.model}, ${effortText(m.effort, DEFAULT_EFFORT.judge)}`)
  lines.push('  There is no cost cap on calibration: the number of calls is fixed, but their size depends on the label text.')
  lines.push(...unpricedWarnings(config, ['judge'], 'Its cost will be reported as unknown.').map(w => `  ${w}`))
  return { lines, anyModelCalls: true }
}
