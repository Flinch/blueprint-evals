import { createRubricJudge } from '../graders/rubric-judge.js'
import type { ModelProvider } from '../core/interfaces.js'
import { ScenarioSchema, type Anchor, type Rubric } from '../core/scenario.js'
import { addUsage, ZERO_USAGE, type Effort, type Trace, type Turn, type Usage } from '../core/trace.js'
import { FRAMEWORK_VERSION } from '../core/version.js'
import { checkLabels, contentKey, splitOf, type Label, type Split } from './labels.js'
import { computeMetrics, type Metrics, type Verdict } from './metrics.js'

// Measures a judge against expert labels. The judge declares the few-shot
// examples in its prompt, and evaluation refuses to run if any of them is a dev
// or test label: contamination is made impossible instead of merely discouraged.
// See docs/design/0002-judge-methodology.md, Part B.

export interface LabelJudgement {
  verdict: Verdict
  critique?: string
  usage?: Usage
}

export interface LabelJudge {
  name: string
  /** The few-shot examples in this judge's prompt. Checked against everything it is evaluated on. */
  anchors: Anchor[]
  /** Judges one label's response. Throws on failure, which is reported and kept out of the metrics. */
  judge(label: Label): Promise<LabelJudgement>
}

export class ContaminationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContaminationError'
  }
}

export interface EvaluateOptions {
  /** The split to measure on. Train is never allowed: those labels may be in the prompt. */
  split: Exclude<Split, 'train'>
  /**
   * `random` (the default) measures random-sampled labels only. Targeted labels
   * were chosen because they looked like trouble, so they cannot estimate how
   * accurate the judge is. `all` includes them and says so.
   */
  selection?: 'random' | 'all'
}

export interface EvaluatedItem {
  id: string
  criterion: string
  expert: Verdict
  judge: Verdict
  agree: boolean
  expertCritique: string
  judgeCritique?: string
}

export interface CalibrationReport {
  judge: string
  split: Exclude<Split, 'train'>
  selection: 'random' | 'all'
  /** Labels in the split, before selection. */
  inSplit: number
  /** Labels left out because they were targeted and selection is `random`. */
  excludedTargeted: number
  metrics: Metrics
  items: EvaluatedItem[]
  /** Items where the judge disagreed with the expert, for reading. */
  disagreements: EvaluatedItem[]
  /** Items the judge could not judge. Kept out of the metrics, never silently dropped. */
  errors: { id: string; reason: string }[]
  /** Spend on the judge calls. null if any price was unknown. */
  usage: Usage
  warnings: string[]
}

/**
 * A few-shot example that matches any non-train label contaminates the
 * evaluation, whichever split is being measured: dev and test examples must
 * never be in the prompt. Returns the problem as a message, or null when clean.
 * Exported so a caller can check before asking anyone to approve a spend.
 */
export function contaminationProblem(labels: Label[], anchors: Anchor[]): string | null {
  const anchorKeys = new Set(anchors.map(contentKey))
  const contaminated = labels.filter(l => splitOf(l) !== 'train' && anchorKeys.has(contentKey(l)))
  if (contaminated.length === 0) return null
  return `The judge's few-shot examples include labels from the dev or test split, so it would be graded on examples it was shown: ${contaminated.map(l => `${l.id} (${splitOf(l)})`).join(', ')}. Build examples from train labels only.`
}

export async function evaluateJudge(labels: Label[], judge: LabelJudge, options: EvaluateOptions): Promise<CalibrationReport> {
  const selection = options.selection ?? 'random'
  if ((options.split as string) === 'train') {
    throw new ContaminationError('Cannot evaluate on the train split: those labels may appear in the judge prompt.')
  }

  const contamination = contaminationProblem(labels, judge.anchors)
  if (contamination) throw new ContaminationError(contamination)

  const inSplit = labels.filter(l => splitOf(l) === options.split)
  const eligible = selection === 'random' ? inSplit.filter(l => l.sampled_by === 'random') : inSplit
  const excludedTargeted = inSplit.length - eligible.length

  const items: EvaluatedItem[] = []
  const errors: { id: string; reason: string }[] = []
  let usage: Usage = ZERO_USAGE
  for (const label of eligible) {
    try {
      const j = await judge.judge(label)
      if (j.usage) usage = addUsage(usage, j.usage)
      items.push({
        id: label.id,
        criterion: label.criterion,
        expert: label.verdict,
        judge: j.verdict,
        agree: j.verdict === label.verdict,
        expertCritique: label.critique,
        ...(j.critique !== undefined ? { judgeCritique: j.critique } : {}),
      })
    } catch (e) {
      errors.push({ id: label.id, reason: e instanceof Error ? e.message : String(e) })
    }
  }

  const metrics = computeMetrics(items.map(i => ({ expert: i.expert, judge: i.judge })))

  const warnings = [...checkLabels(labels)]
  if (inSplit.length === 0) warnings.push(`There are no labels in the ${options.split} split.`)
  else if (eligible.length === 0) warnings.push(`None of the ${inSplit.length} ${options.split} labels were randomly sampled, so nothing could be measured.`)
  if (excludedTargeted > 0) {
    warnings.push(`${excludedTargeted} targeted ${options.split} label(s) were left out: they were chosen because they looked like trouble, so they would bias the rates.`)
  }
  if (selection === 'all' && eligible.some(l => l.sampled_by === 'targeted')) {
    warnings.push('Targeted labels are included, so these rates describe the sample reviewed, not the judge in general.')
  }
  if (errors.length > 0) {
    warnings.push(`${errors.length} of ${eligible.length} items could not be judged and are not in the rates. Fix the cause before trusting them.`)
  }
  warnings.push(...metrics.warnings)

  return {
    judge: judge.name,
    split: options.split,
    selection,
    inSplit: inSplit.length,
    excludedTargeted,
    metrics,
    items,
    disagreements: items.filter(i => !i.agree),
    errors,
    usage,
    warnings,
  }
}

// ----------------------------------------------------- a rubric as a judge

export interface RubricLabelJudgeOptions {
  rubric: Rubric
  provider: ModelProvider
  effort?: Effort
  timeoutMs?: number
}

const STUB_SCENARIO = ScenarioSchema.parse({ id: 'calibration', version: 1, target: 'calibration', seed_message: 'calibration' })

/**
 * Evaluates a rubric judge against labels, one criterion at a time: a label
 * about one criterion is judged against that criterion alone, with only the
 * examples that illustrate it. That is how the post builds judges, and it keeps
 * a label from costing a judgement of every criterion. Calibration stays
 * binary: the judge here is not offered `not_applicable`.
 */
export function createRubricLabelJudge(options: RubricLabelJudgeOptions): LabelJudge {
  const { rubric, provider, effort, timeoutMs } = options
  return {
    name: `rubric-judge(${rubric.id}@${rubric.version})`,
    anchors: rubric.anchors,

    async judge(label: Label): Promise<LabelJudgement> {
      const criterion = rubric.criteria.find(c => c.id === label.criterion)
      if (!criterion) {
        throw new Error(`Label "${label.id}" is about the criterion "${label.criterion}", which rubric "${rubric.id}" does not have.`)
      }
      const single: Rubric = {
        ...rubric,
        criteria: [criterion],
        anchors: rubric.anchors.filter(a => a.criterion === undefined || a.criterion === criterion.id),
      }

      const now = new Date().toISOString()
      const turns: Turn[] = []
      if (label.input !== undefined) turns.push({ index: turns.length, role: 'user', content: label.input, at: now })
      turns.push({ index: turns.length, role: 'assistant', content: label.output, at: now })
      const trace: Trace = {
        schemaVersion: 1,
        runId: label.id,
        scenario: { id: 'calibration', version: '1' },
        target: { name: 'calibration', kind: 'label', toolCalls: 'none' },
        turns,
        startedAt: now,
        endedAt: now,
        usage: ZERO_USAGE,
        metadata: { frameworkVersion: FRAMEWORK_VERSION, models: {} },
      }

      // A labelled item is applicable by definition, so this judge cannot answer not_applicable.
      const result = await createRubricJudge({ rubric: single, provider, effort, timeoutMs, allowNotApplicable: false }).grade(trace, STUB_SCENARIO, { runId: label.id })
      if (result.status === 'error' || !result.criteria?.[0]) throw new Error(result.reason)
      const { verdict, critique } = result.criteria[0]
      // Unreachable while the schema forbids it. Kept so a future change cannot slip an n/a into the metrics.
      if (verdict === 'not_applicable') throw new Error(`The judge answered not_applicable for label "${label.id}", but a labelled item is always applicable.`)
      return { verdict, critique, usage: result.usage }
    },
  }
}

// ----------------------------------------------------------------- reporting

const pct = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`)
const rate = (name: string, r: Metrics['tpr']) =>
  r.rate === null || r.interval === null
    ? `${name}: n/a (no ${name === 'True negative rate' ? 'expert-fail' : 'expert-pass'} labels)`
    : `${name}: ${pct(r.rate)} [${pct(r.interval[0])} to ${pct(r.interval[1])}] (${r.successes} of ${r.n})`

/** A plain-text report for a terminal. The disagreements are listed because reading them is the point. */
export function formatReport(report: CalibrationReport): string {
  const { metrics: m } = report
  const lines = [
    `Judge: ${report.judge}`,
    `Split: ${report.split} (${report.selection} labels), ${m.n} measured of ${report.inSplit} in the split`,
    '',
    rate('True negative rate', m.tnr) + '   <- failures the judge caught',
    rate('True positive rate', m.tpr) + '   <- passes the judge confirmed',
    `Accuracy: ${pct(m.accuracy)} (${pct(m.prevalencePass)} of labels are expert-pass)`,
    `Cohen's kappa: ${m.kappa === null ? 'n/a' : m.kappa.toFixed(2)}`,
    m.insufficient ? 'Status: INSUFFICIENT SAMPLE, do not rely on these numbers.' : 'Status: sample size adequate',
  ]
  if (report.warnings.length > 0) lines.push('', 'Warnings:', ...report.warnings.map(w => `  - ${w}`))
  if (report.errors.length > 0) lines.push('', 'Could not be judged:', ...report.errors.map(e => `  - ${e.id}: ${e.reason}`))
  if (report.disagreements.length > 0) {
    lines.push('', `Disagreements (${report.disagreements.length}):`)
    for (const d of report.disagreements) {
      lines.push(
        `  ${d.id} [${d.criterion}]: expert ${d.expert}, judge ${d.judge}`,
        `    expert: ${d.expertCritique}`,
        ...(d.judgeCritique ? [`    judge:  ${d.judgeCritique}`] : []),
      )
    }
  }
  return lines.join('\n')
}
