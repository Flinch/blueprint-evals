import { parseArgs } from 'node:util'
import { ContaminationError, formatReport } from '../calibration/evaluate.js'
import { loadLabels, resolveLabels, SplitViolationError } from '../calibration/labels.js'
import { loadConfig, loadRubric } from '../core/load.js'
import type { ModelProvider } from '../core/interfaces.js'
import { executeCalibration, planCalibration } from '../engine/calibrate.js'
import { providerErrors } from '../engine/plan.js'
import { formatUsd } from '../reporters/console.js'
import {
  confirmSpend, configPath, DEFAULT_CONFIG, defaultProvider, orUsage, parseOrUsage, print, requireFile, UsageError, type CliIo,
} from './common.js'

export const CALIBRATE_HELP = `Usage: evals calibrate --labels <file> --rubric <file> --split dev|test [options]

Measures a rubric judge against human labels: how often it agrees with the
expert on failures (true negative rate) and on passes (true positive rate).
This is a measurement, not a gate, so low rates do not change the exit code.

Options:
  --labels <file>      Label file, one JSON object per line. Required.
  --rubric <file>      Rubric file the judge uses. Required.
  --split dev|test     Which split to measure on. Required. The train split is
                       refused: its labels may appear in the judge's prompt.
  --selection <mode>   random (default) measures randomly sampled labels only.
                       all includes targeted labels and says so in the report.
  --config <file>      Config file, for the judge model, prices and timeout.
                       Default: ${DEFAULT_CONFIG} in the current directory.
  --yes                Skip the confirmation. Required when there is no terminal (CI).
  -h, --help           Show this help.

The command prints how many judge calls it will make before it makes any, and
asks you to confirm.

Exit codes: 0 measured (even if the rates are low), 1 some labels could not be
judged, 2 usage problem, contamination, or the run was not confirmed.
`

export async function calibrateCommand(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        labels: { type: 'string' },
        rubric: { type: 'string' },
        split: { type: 'string' },
        selection: { type: 'string' },
        config: { type: 'string' },
        yes: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }),
  )
  if (values.help) {
    io.stdout(CALIBRATE_HELP)
    return 0
  }
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"`)
  if (values.labels === undefined) throw new UsageError('--labels is required')
  if (values.rubric === undefined) throw new UsageError('--rubric is required')
  if (values.split === undefined) throw new UsageError('--split is required (dev or test)')

  if (values.split === 'train') {
    throw new UsageError('cannot calibrate on the train split: those labels may appear in the judge\'s prompt, so the judge would be graded on examples it was shown. Use --split dev or --split test.')
  }
  if (values.split !== 'dev' && values.split !== 'test') throw new UsageError(`--split must be dev or test, got "${values.split}"`)
  const split = values.split
  const selection = values.selection ?? 'random'
  if (selection !== 'random' && selection !== 'all') throw new UsageError(`--selection must be random or all, got "${selection}"`)

  const config = orUsage(() => loadConfig(configPath(io, values.config)))
  // Every line of the file, revisions included. A broken replace chain is a usage problem, like a line that does not parse.
  const labels = orUsage(() => {
    const all = loadLabels(requireFile(io, values.labels!, 'labels file'))
    resolveLabels(all)
    return all
  })
  const rubric = orUsage(() => loadRubric(requireFile(io, values.rubric!, 'rubric file')))
  const problems = providerErrors(config, false, true)
  if (problems.length > 0) throw new UsageError(problems.join('\n'))

  // Refuse a contaminated judge before anyone is asked to approve a spend.
  const plan = planCalibration({ config, labels, rubric, split, selection })
  if (plan.contamination) {
    print(io.stderr, `${plan.contamination}\nNothing was run and nothing was spent.`)
    return 2
  }

  const out = (text = '') => print(io.stdout, text)
  const preview = plan.preview
  for (const line of preview.lines) out(line)
  out()

  if (preview.anyModelCalls) {
    if ((await confirmSpend(io, Boolean(values.yes), 'Calibration')) === 'declined') {
      out('Not confirmed. Nothing was run and nothing was spent.')
      return 2
    }
  }

  let provider: ModelProvider
  try {
    provider = (io.createProvider ?? defaultProvider)(config)
  } catch (e) {
    throw new UsageError(`cannot create the model provider: ${e instanceof Error ? e.message : String(e)}`)
  }

  let report
  try {
    report = await executeCalibration({ config, labels, rubric, provider, split, selection })
  } catch (e) {
    if (e instanceof ContaminationError || e instanceof SplitViolationError) {
      print(io.stderr, e.message)
      return 2
    }
    throw e
  }

  out(formatReport(report))
  out()
  out(`Spend: ${formatUsd(report.usage.costUsd)}${report.usage.costUsd === null ? ' (the judge model has no price in the config)' : ''}`)
  if (report.metrics.insufficient) {
    out()
    out('INSUFFICIENT SAMPLE: do not rely on these rates.')
    for (const w of report.metrics.warnings) out(`  - ${w}`)
  }
  return report.errors.length > 0 ? 1 : 0
}
