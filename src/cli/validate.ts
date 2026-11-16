import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { checkLabels, LabelChainError, loadLabels, resolveLabels, type ResolvedLabels } from '../calibration/labels.js'
import type { Config } from '../core/config.js'
import { loadConfig, loadRubric, loadScenarios, type LoadedScenario } from '../core/load.js'
import type { Rubric } from '../core/scenario.js'
import { configPath, DEFAULT_CONFIG, parseOrUsage, print, requireFile, scenariosPath, shown, UsageError, type CliIo } from './common.js'
import { crossCheck, scenarioNeedsModel } from './plan.js'

export const VALIDATE_HELP = `Usage: evals validate [path] [options]

Checks the config, the scenarios and (optionally) a label file, without
calling any model or agent, and without spending anything.

Arguments:
  path              A scenario file or a directory searched recursively.
                    Default: ./scenarios, if it exists.

Options:
  --config <file>   Config file. Default: ${DEFAULT_CONFIG} in the current directory.
  --labels <file>   Also check a label file (one JSON object per line).
  --rubric <file>   Also check a rubric file. With --labels, every label's
                    criterion must exist in the rubric.
  -h, --help        Show this help.

Checks: every scenario's target exists in the config and is a kind that can
run, and the environment variables the targets refer to are listed (a missing
one is a warning, and values are never printed).

Exit codes: 0 no errors, 1 errors found, 2 usage problem or a file not found.
`

export async function validateCommand(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        labels: { type: 'string' },
        rubric: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }),
  )
  if (values.help) {
    io.stdout(VALIDATE_HELP)
    return 0
  }
  if (positionals.length > 1) throw new UsageError(`expected at most one path, got ${positionals.length}`)

  // Files that were named but are not there are a usage problem. Files that are
  // there but wrong are the errors this command exists to report.
  const configFile = configPath(io, values.config)
  const scenariosDir = scenariosPath(io, positionals[0])
  const labelsFile = values.labels === undefined ? undefined : requireFile(io, values.labels, 'labels file')
  const rubricFile = values.rubric === undefined ? undefined : requireFile(io, values.rubric, 'rubric file')

  const errors: string[] = []
  const warnings: string[] = []
  const out = (text = '') => print(io.stdout, text)

  let config: Config | undefined
  try {
    config = loadConfig(configFile)
  } catch (e) {
    errors.push(message(e))
  }

  let scenarios: LoadedScenario[] = []
  try {
    scenarios = loadScenarios(scenariosDir)
  } catch (e) {
    errors.push(message(e))
  }

  let rubric: Rubric | undefined
  if (rubricFile) {
    try {
      rubric = loadRubric(rubricFile)
    } catch (e) {
      errors.push(message(e))
    }
  }

  const labels = labelsFile ? tryLoadLabels(labelsFile, errors) : undefined
  let resolved: ResolvedLabels | undefined
  if (labels) {
    // A broken replace chain is an error: calibrate refuses the file.
    try {
      resolved = resolveLabels(labels)
      warnings.push(...checkLabels(labels))
    } catch (e) {
      if (!(e instanceof LabelChainError)) throw e
      errors.push(`${labelsFile}: ${e.message}`)
    }
    if (rubric) {
      const known = new Set(rubric.criteria.map(c => c.id))
      const unknown = [...new Set(labels.filter(l => !known.has(l.criterion)).map(l => l.criterion))]
      if (unknown.length > 0) {
        errors.push(`The labels are about criteria that rubric "${rubric.id}" does not have: ${unknown.join(', ')}.`)
      }
    }
  }

  const rubricFiles = new Set(
    scenarios.filter(l => l.scenario.rubric).map(l => resolve(dirname(l.file), l.scenario.rubric!)),
  )
  const withModel = scenarios.filter(l => scenarioNeedsModel(l.scenario)).length

  out(`Config: ${shown(io, configFile)}${config ? ` (${Object.keys(config.targets).length} targets)` : ''}`)
  out(`Scenarios: ${scenarios.length} in ${shown(io, scenariosDir)}`)
  if (scenarios.length > 0) out(`  ${withModel} need a model (persona, rubric or goal), ${scenarios.length - withModel} deterministic only`)
  out(`Rubrics: ${rubricFiles.size} used by scenarios${rubric ? `, plus ${shown(io, rubricFile!)}` : ''}`)
  if (labels) {
    const revised = resolved && resolved.revised.size > 0 ? `, ${resolved.revised.size} of them revised after the first label (${labels.length} lines)` : ''
    out(`Labels: ${resolved ? resolved.current.length : labels.length} in ${shown(io, labelsFile!)}${revised}`)
  }

  if (config) {
    const check = crossCheck(config, scenarios, io.env, f => shown(io, f))
    errors.push(...check.errors)
    warnings.push(...check.warnings)
    if (check.envRefs.length > 0) {
      out('Environment variables referenced by targets:')
      for (const r of check.envRefs) out(`  ${r.name} (${r.isSet ? 'set' : 'NOT SET'}) used by ${r.targets.join(', ')}`)
    }
  }

  if (warnings.length > 0) {
    out()
    out(`Warnings (${warnings.length}):`)
    for (const w of warnings) out(`  - ${w}`)
  }
  if (errors.length > 0) {
    out()
    out(`Errors (${errors.length}):`)
    for (const e of errors) out(`  - ${e.replace(/\n/g, '\n    ')}`)
    out()
    out('Validation failed.')
    return 1
  }
  out()
  out(warnings.length > 0 ? 'Valid, with warnings.' : 'Valid.')
  return 0
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

function tryLoadLabels(file: string, errors: string[]) {
  try {
    return loadLabels(file)
  } catch (e) {
    errors.push(message(e))
    return undefined
  }
}
