import {
  contaminationProblem, createRubricLabelJudge, evaluateJudge, type CalibrationReport,
} from '../calibration/evaluate.js'
import { splitOf, type Label } from '../calibration/labels.js'
import type { Config } from '../core/config.js'
import type { ModelProvider } from '../core/interfaces.js'
import type { Rubric } from '../core/scenario.js'
import { buildCalibratePreview, type Preview } from './plan.js'

// The cores of `evals calibrate`, shared by the command line and the local server.

export type CalibrationSplit = 'dev' | 'test'
export type CalibrationSelection = 'random' | 'all'

/** How many labels evaluateJudge will judge. The same selection it makes, so the preview's count is the real one. */
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

export function planCalibration(input: {
  config: Config
  labels: Label[]
  rubric: Rubric
  split: CalibrationSplit
  selection: CalibrationSelection
}): CalibrationPlan {
  const { config, labels, rubric, split, selection } = input
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
}): Promise<CalibrationReport> {
  const { config, labels, rubric, provider, split, selection } = input
  const judge = createRubricLabelJudge({ rubric, provider, effort: config.models.judge.effort, timeoutMs: config.timeouts.judgeMs })
  return evaluateJudge(labels, judge, { split, selection })
}
