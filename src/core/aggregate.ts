import type { CriterionResult, GraderResult, RunStatus } from './interfaces.js'

// Verdict aggregation. Judges decide pass or fail, so the rule is short:
//
//   any grader error                       -> error  (no trustworthy verdict)
//   any failed check, criterion or goal    -> fail
//   otherwise                              -> pass
//
// Skipped graders are reported and never count as passes, but they do not fail
// the run either.
//
// This replaces a banded rule in which a criterion near its threshold made the
// whole run "borderline". On the one real project we have data for, that put
// every one of 52 runs in the borderline bucket. The band existed because
// judges scored from 0 to 1; with binary verdicts it has nothing to act on and
// is gone (see docs/design/0002-judge-methodology.md).

export function aggregateStatus(results: GraderResult[]): RunStatus {
  if (results.some(r => r.status === 'error')) return 'error'
  if (results.some(r => r.status === 'fail')) return 'fail'
  // A grader whose own status says pass while one of its criteria failed is a
  // bug in that grader. The criteria are the evidence, so they win.
  if (results.flatMap(r => r.criteria ?? []).some(c => c.verdict === 'fail')) return 'fail'
  return 'pass'
}

/**
 * Weighted share of judged criteria that passed, or null if none were judged.
 * A diagnostic that says how much went right. It is not the verdict, and it is
 * derived: no judge ever produces a number.
 */
export function aggregateScore(results: GraderResult[]): number | null {
  const criteria: CriterionResult[] = results.flatMap(r => r.criteria ?? [])
  if (criteria.length === 0) return null
  const totalWeight = criteria.reduce((sum, c) => sum + c.weight, 0)
  if (totalWeight === 0) return null
  return criteria.reduce((sum, c) => sum + (c.verdict === 'pass' ? c.weight : 0), 0) / totalWeight
}

/**
 * The headline outcome: did the agent achieve the scenario's goal. Null when
 * there is no goal, or the goal check was skipped or could not run.
 */
export function goalAchievedFrom(results: GraderResult[]): boolean | null {
  const goal = results.find(r => r.grader === 'goal-check')
  if (!goal) return null
  if (goal.status === 'pass') return true
  if (goal.status === 'fail') return false
  return null
}
