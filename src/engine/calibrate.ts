import {
  contaminationProblem, countEvidence, createRubricLabelJudge, evaluateJudge, labelEvidence, type CalibrationReport, type EvidenceCounts, type LabelEvidence,
  type SavedConversation, type SavedRunLookup,
} from '../calibration/evaluate.js'
import { isGraded, itemIdOfLabel, resolveLabels, splitOf, type GradedLabel, type Label } from '../calibration/labels.js'
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

/** The labels evaluateJudge will judge: the same selection it makes. Takes current labels. */
export function selectLabels(labels: Label[], split: CalibrationSplit, selection: CalibrationSelection): GradedLabel[] {
  // "Does not apply" labels are counted in the report, never judged.
  const inSplit = labels.filter(isGraded).filter(l => splitOf(l) === split)
  return selection === 'random' ? inSplit.filter(l => l.sampled_by === 'random') : inSplit
}

/** How many labels evaluateJudge will judge, so the preview's count is the real one. Takes current labels. */
export function countJudgements(labels: Label[], split: CalibrationSplit, selection: CalibrationSelection): number {
  return selectLabels(labels, split, selection).length
}

export interface CalibrationPlan {
  judgements: number
  preview: Preview
  /** Set when the judge's few-shot examples include dev or test labels. A contaminated judge must not be run. */
  contamination: string | null
  /** How many of the selected items the judge will see the whole saved run for, and how many only the label's text. */
  evidence: EvidenceCounts
  /** The evidence for each selected item, by item id, in label order. A caller can fingerprint it, so a run that disappears changes the plan. */
  evidenceByItem: { itemId: string; evidence: LabelEvidence }[]
}

/** Throws LabelChainError for a broken replace chain. */
export function planCalibration(input: {
  config: Config
  /** Every line of the label file. */
  labels: Label[]
  rubric: Rubric
  split: CalibrationSplit
  selection: CalibrationSelection
  /** The saved runs, as executeCalibration will be given them. Pass the same lookup to both, so what is previewed is what is measured. */
  runLookup?: SavedRunLookup
}): CalibrationPlan {
  const { config, rubric, split, selection, runLookup } = input
  const labels = resolveLabels(input.labels).current
  const selected = selectLabels(labels, split, selection)
  const evidenceByItem = selected.map(l => ({ itemId: itemIdOfLabel(l), evidence: labelEvidence(l, runLookup) }))
  const kinds = new Map(evidenceByItem.map(e => [e.itemId, e.evidence.kind]))
  const evidence = countEvidence(selected, l => kinds.get(itemIdOfLabel(l))!)
  return {
    judgements: selected.length,
    preview: buildCalibratePreview(config, selected.length, split, selection, evidence),
    contamination: contaminationProblem(labels, rubric.anchors),
    evidence,
    evidenceByItem,
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
  /**
   * The saved runs (see savedRunLookup). A label made from one is judged on
   * that whole run, with its date. Without it every label is judged on its own
   * text, with no date.
   */
  runLookup?: SavedRunLookup
}): Promise<CalibrationReport> {
  const { config, labels, rubric, provider, split, selection, runLookup } = input
  const judge = createRubricLabelJudge({
    rubric,
    provider,
    effort: config.models.judge.effort,
    timeoutMs: config.timeouts.judgeMs,
    timeZone: config.timezone,
    runLookup,
  })
  return evaluateJudge(labels, judge, { split, selection })
}

/**
 * Finds saved runs in `runsDir` by id, for calibration: each run's turns and
 * start time, as production grading saw them. An unsafe id, or a run that is
 * not saved there or cannot be read, gives undefined. Each run is read once
 * and kept, so one lookup answers the same way for its whole life: make one
 * per calibration and pass it to both planCalibration and executeCalibration.
 */
export function savedRunLookup(runsDir: string): SavedRunLookup {
  const cache = new Map<string, SavedConversation | undefined>()
  return runId => {
    if (!isSafeId(runId)) return undefined
    if (!cache.has(runId)) {
      let run: SavedConversation | undefined
      try {
        const trace = findRun(runsDir, runId)?.result.trace
        run = trace ? { startedAt: trace.startedAt, turns: trace.turns } : undefined
      } catch {
        run = undefined
      }
      cache.set(runId, run)
    }
    return cache.get(runId)
  }
}
