import type { CriterionResult, GraderResult, RunStatus } from './interfaces.js'

// Verdict aggregation. This replaces the old rule, "any criterion near its
// threshold makes the whole run borderline", which hid confident failures:
// on one real project every one of 52 runs landed in "borderline" and the
// pass rate read 0% while the average score was 57%.
//
// Principle: a run is `uncertain` only when the uncertain criteria could
// change the outcome. Resolve every uncertain criterion as a pass, then as a
// fail. If both give the same verdict, that is the verdict. Today's pass
// condition is "every criterion clears its threshold", which reduces to the
// ordered rules below. The principle is what stays correct if that changes.

export function aggregateStatus(results: GraderResult[]): RunStatus {
  // 1. An infrastructure error means there is no trustworthy verdict.
  if (results.some(r => r.status === 'error')) return 'error'

  // 2. A deterministic failure is a failure, whatever else is uncertain.
  const failed = results.filter(r => r.status === 'fail')
  if (failed.length > 0) return 'fail'

  const criteria = results.flatMap(r => r.criteria ?? [])

  // 3. A confident failure on any criterion fails the run.
  if (criteria.some(c => c.band === 'confident_fail')) return 'fail'

  // 4. Otherwise uncertainty can still change the outcome.
  if (criteria.some(c => c.band === 'uncertain') || results.some(r => r.status === 'uncertain')) {
    return 'uncertain'
  }

  // 5. Nothing failed and nothing is uncertain. Skipped graders do not count
  //    as passes, but they do not fail the run either: they are reported.
  return 'pass'
}

/** Weighted mean of criterion scores across all graders, or null if none. */
export function aggregateScore(results: GraderResult[]): number | null {
  const criteria: CriterionResult[] = results.flatMap(r => r.criteria ?? [])
  if (criteria.length === 0) return null
  const totalWeight = criteria.reduce((sum, c) => sum + c.weight, 0)
  if (totalWeight === 0) return null
  return criteria.reduce((sum, c) => sum + c.score * c.weight, 0) / totalWeight
}

/**
 * Half-width of the uncertain band around a threshold. Scaled to the distance
 * to the nearer bound (0 or 1), capped at 0.1, so thresholds near an edge keep
 * real headroom for a confident verdict on either side.
 */
export function bandHalfWidth(threshold: number): number {
  return Math.min(0.1, Math.min(threshold, 1 - threshold) / 2)
}

export function bandFor(score: number, threshold: number): CriterionResult['band'] {
  if (Math.abs(score - threshold) <= bandHalfWidth(threshold)) return 'uncertain'
  return score >= threshold ? 'confident_pass' : 'confident_fail'
}
