import type { GraderResult, RunResult } from '../core/interfaces.js'
import type {
  CriterionTally, FailingCheck, FailingCriterion, OverviewResponse, RunEndSummary, RunListItem, SuiteListItem, SuiteState, TagFailures, TrendPoint,
} from '../ui/api-types.js'
import type { SuiteHeader, SuiteRecord } from '../store/suites.js'

// Shapes the stored records into what the API returns: list rows, the overview.
// Pure functions of their inputs, so they are tested without a server.

const decided = (g: GraderResult) => g.status === 'pass' || g.status === 'fail'

export function failedCriteria(result: RunResult): string[] {
  return result.graders.filter(decided).flatMap(g => (g.criteria ?? []).filter(c => c.verdict === 'fail').map(c => c.id))
}

/** Ids of criteria the judge found not applicable in this run. They are reported, never graded. */
export function notApplicableCriteria(result: RunResult): string[] {
  return result.graders.filter(decided).flatMap(g => (g.criteria ?? []).filter(c => c.verdict === 'not_applicable').map(c => c.id))
}

export function failedChecks(result: RunResult): string[] {
  return result.graders.filter(g => g.status === 'fail' && !(g.criteria && g.criteria.length > 0)).map(g => g.grader)
}

export function runListItem(suiteId: string, result: RunResult): RunListItem {
  const { models } = result.trace.metadata
  return {
    runId: result.trace.runId,
    suiteId,
    scenarioId: result.trace.scenario.id,
    scenarioVersion: result.trace.scenario.version,
    status: result.status,
    score: result.score,
    goalAchieved: result.goalAchieved,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    startedAt: result.trace.startedAt,
    turns: result.trace.turns.length,
    tags: result.trace.metadata.tags ?? [],
    models: {
      ...(models.simulator ? { simulator: models.simulator.servedBy ?? models.simulator.model } : {}),
      ...(models.judge ? { judge: models.judge.servedBy ?? models.judge.model } : {}),
    },
    failedCriteria: failedCriteria(result),
    notApplicableCriteria: notApplicableCriteria(result),
    failedChecks: failedChecks(result),
    ...(result.error ? { error: result.error } : {}),
    warnings: result.warnings.length,
  }
}

export function runEndSummary(result: RunResult): RunEndSummary {
  return {
    runId: result.trace.runId,
    scenarioId: result.trace.scenario.id,
    scenarioVersion: result.trace.scenario.version,
    status: result.status,
    score: result.score,
    goalAchieved: result.goalAchieved,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    turns: result.trace.turns.length,
    failedCriteria: failedCriteria(result),
    ...(result.error ? { error: result.error } : {}),
    warnings: result.warnings.length,
  }
}

export function suiteListItem(header: SuiteHeader, activeSuiteId: string | undefined): SuiteListItem {
  const state: SuiteState = header.status === 'running' && header.suiteId !== activeSuiteId ? 'interrupted' : header.status
  return {
    suiteId: header.suiteId,
    startedAt: header.startedAt,
    endedAt: header.endedAt,
    state,
    command: header.command,
    configFile: header.configFile,
    scenarioPath: header.scenarioPath,
    summary: header.summary,
  }
}

const rate = (n: number, d: number) => (d === 0 ? null : n / d)

/**
 * Aggregates suites (any order) into the dashboard's numbers. Cost sums are
 * null-safe: one run with an unknown cost makes the total unknown instead of
 * letting a partial sum pass as a total.
 */
export function buildOverview(suites: SuiteRecord[], totalSuites: number, warnings: string[]): OverviewResponse {
  const results = suites.flatMap(s => s.results)
  const count = (status: RunResult['status']) => results.filter(r => r.status === status).length
  const withGoal = results.filter(r => r.goalAchieved !== null)
  const achieved = withGoal.filter(r => r.goalAchieved).length
  const unknownCost = results.filter(r => r.costUsd === null).length
  const knownUsd = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)

  const trend: TrendPoint[] = [...suites]
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.suiteId.localeCompare(b.suiteId))
    .map(s => ({
      suiteId: s.suiteId,
      startedAt: s.startedAt,
      status: s.status,
      runs: s.summary.runs,
      pass: s.summary.pass,
      fail: s.summary.fail,
      error: s.summary.error,
      passRate: rate(s.summary.pass, s.summary.runs),
      goalRate: rate(s.summary.goal.achieved, s.summary.goal.total),
      avgScore: s.summary.avgScore,
      costUsd: s.summary.costUsd,
    }))

  const tags = new Map<string, TagFailures>()
  for (const r of results) {
    for (const tag of r.trace.metadata.tags ?? []) {
      const t = tags.get(tag) ?? { tag, runs: 0, pass: 0, fail: 0, error: 0 }
      t.runs++
      t[r.status]++
      tags.set(tag, t)
    }
  }

  const criteria = new Map<string, FailingCriterion>()
  const tallies = new Map<string, CriterionTally>()
  const checks = new Map<string, FailingCheck & { _s: Set<string> }>()
  for (const r of results) {
    const scenario = r.trace.scenario.id
    for (const g of r.graders.filter(decided)) {
      for (const c of g.criteria ?? []) {
        const t = tallies.get(c.id) ?? { criterion: c.id, pass: 0, fail: 0, notApplicable: 0, critical: false }
        t.critical ||= c.critical
        tallies.set(c.id, t)
        const e = criteria.get(c.id) ?? { criterion: c.id, failures: 0, judged: 0, notApplicable: 0, failureRate: 0, scenarios: [], critical: false }
        e.critical ||= c.critical
        criteria.set(c.id, e)
        // A criterion the judge found not applicable was not graded, so it is not a judged criterion and never a failure.
        if (c.verdict === 'not_applicable') {
          t.notApplicable++
          e.notApplicable++
          continue
        }
        e.judged++
        if (c.verdict === 'fail') {
          t.fail++
          e.failures++
          if (!e.scenarios.includes(scenario)) e.scenarios.push(scenario)
        } else t.pass++
      }
      if (g.status === 'fail' && !(g.criteria && g.criteria.length > 0)) {
        const e = checks.get(g.grader) ?? { grader: g.grader, failures: 0, scenarios: [], _s: new Set<string>() }
        e.failures++
        if (!e._s.has(scenario)) {
          e._s.add(scenario)
          e.scenarios.push(scenario)
        }
        checks.set(g.grader, e)
      }
    }
  }

  return {
    suites: { considered: suites.length, total: totalSuites },
    runs: results.length,
    counts: { pass: count('pass'), fail: count('fail'), error: count('error') },
    goal: { achieved, total: withGoal.length, rate: rate(achieved, withGoal.length) },
    cost: {
      totalUsd: unknownCost > 0 ? null : knownUsd,
      knownUsd,
      runsWithUnknownCost: unknownCost,
      inputTokens: results.reduce((s, r) => s + r.trace.usage.inputTokens, 0),
      outputTokens: results.reduce((s, r) => s + r.trace.usage.outputTokens, 0),
    },
    trend,
    failuresByTag: [...tags.values()].sort((a, b) => b.fail + b.error - (a.fail + a.error) || a.tag.localeCompare(b.tag)),
    criteria: [...tallies.values()].sort((a, b) => a.criterion.localeCompare(b.criterion)),
    topFailingCriteria: [...criteria.values()]
      .filter(c => c.failures > 0)
      .map(c => ({ ...c, failureRate: c.failures / c.judged }))
      .sort((a, b) => b.failures - a.failures || a.criterion.localeCompare(b.criterion))
      .slice(0, 10),
    topFailingChecks: [...checks.values()]
      .map(({ _s, ...c }) => c)
      .sort((a, b) => b.failures - a.failures || a.grader.localeCompare(b.grader))
      .slice(0, 10),
    warnings,
  }
}
