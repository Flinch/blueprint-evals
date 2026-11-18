import {
  contaminationProblem, createRubricLabelJudge, evaluateJudge, type CalibrationReport,
} from '../calibration/evaluate.js'
import { resolveLabels, splitOf, type Label } from '../calibration/labels.js'
import type { Config } from '../core/config.js'
import type { ModelProvider } from '../core/interfaces.js'
import type { Rubric } from '../core/scenario.js'
import { findRun, isSafeId } from '../store/index.js'
import { buildCalibratePreview, type Preview } from './plan.js'

// The cores of `evals calibrate`, shared by the command line and the local server.
// Both take every line of the label file. Revisions are resolved here and in
// evaluateJudge, so a changed label is measured once, with its current verdict.

export type CalibrationSplit = 'dev' | 'test'
export type CalibrationSelection = 'random' | 'all'

/** How many labels evaluateJudge will judge. The same selection it makes, so the preview's count is the real one. Takes current labels. */
export function countJudgements(labels: Label[], split: CalibrationSplit, selection: CalibrationSelection): number {
  const inSplit = labels.filter(l => splitOf(l) === split)
  return selection === 'random' ? inSplit.filter(l => l.sampled_by === 'random').length : inSplit.length
}

export interface CalibrationPlan {
  judgements: number
  preview: Preview
  /** Set when the judge's few-shot examples include dev or test labels. A contaminated judge must not be run. */
  contamination: string | null
}

/** Throws LabelChainError for a broken replace chain. */
export function planCalibration(input: {
  config: Config
  /** Every line of the label file. */
  labels: Label[]
  rubric: Rubric
  split: CalibrationSplit
  selection: CalibrationSelection
}): CalibrationPlan {
  const { config, rubric, split, selection } = input
  const labels = resolveLabels(input.labels).current
  const judgements = countJudgements(labels, split, selection)
  return {
    judgements,
    preview: buildCalibratePreview(config, judgements, split, selection),
    contamination: contaminationProblem(labels, rubric.anchors),
  }
}

/** Throws ContaminationError or SplitViolationError (from evaluateJudge) for a contaminated judge. */
export async function executeCalibration(input: {
  config: Config
  labels: Label[]
  rubric: Rubric
  provider: ModelProvider
  split: CalibrationSplit
  selection: CalibrationSelection
  /** When a label's conversation started, if known (see RubricLabelJudgeOptions). Without it the judge is shown no date. */
  conversationStartedAt?: (label: Label) => string | undefined
}): Promise<CalibrationReport> {
  const { config, labels, rubric, provider, split, selection, conversationStartedAt } = input
  const judge = createRubricLabelJudge({
    rubric,
    provider,
    effort: config.models.judge.effort,
    timeoutMs: config.timeouts.judgeMs,
    timeZone: config.timezone,
    conversationStartedAt,
  })
  return evaluateJudge(labels, judge, { split, selection })
}

/**
 * Looks up when a label's conversation started from the saved runs in
 * `runsDir`. A label made from a run has that run's id as its `group`. A label
 * with no group, or whose run is not saved here, gets undefined, and its judge
 * is shown no date. Each run is looked up once.
 */
export function runStartLookup(runsDir: string): (label: Label) => string | undefined {
  const cache = new Map<string, string | undefined>()
  return label => {
    const runId = label.group
    if (runId === undefined || !isSafeId(runId)) return undefined
    if (!cache.has(runId)) {
      let startedAt: string | undefined
      try {
        startedAt = findRun(runsDir, runId)?.result.trace.startedAt
      } catch {
        startedAt = undefined
      }
      cache.set(runId, startedAt)
    }
    return cache.get(runId)
  }
}
