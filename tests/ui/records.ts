import { join } from 'node:path'
import { createSuiteWriter, storePaths, type SuiteRecord } from '../../src/store/index.js'
import type { CriterionResult, CriterionVerdict, GraderResult, RunResult, RunStatus } from '../../src/index.js'
import { makeTrace } from '../helpers.js'

export interface RunSpec {
  runId: string
  scenario?: string
  status?: RunStatus
  /** Criterion verdicts the judge gave, by criterion id. */
  criteria?: Record<string, CriterionVerdict>
  tags?: string[]
  costUsd?: number | null
  goalAchieved?: boolean | null
  /** Overrides the default one-exchange conversation. */
  turns?: { role: 'user' | 'assistant'; content: string }[]
  error?: string
}

export const critiqueOf = (runId: string, criterion: string) => `JUDGE-CRITIQUE[${runId}/${criterion}]`

export function runResult(spec: RunSpec): RunResult {
  const turns = spec.turns ?? [
    { role: 'user' as const, content: `Question for ${spec.runId}` },
    { role: 'assistant' as const, content: `Answer for ${spec.runId}` },
  ]
  const trace = makeTrace(turns.map(t => ({ role: t.role, content: t.content })))
  trace.runId = spec.runId
  trace.scenario = { id: spec.scenario ?? 'scenario-a', version: '1' }
  trace.metadata = { frameworkVersion: 'test', models: { judge: { provider: 'fake', model: 'judge-model' } }, ...(spec.tags ? { tags: spec.tags } : {}) }
  const criteria: CriterionResult[] = Object.entries(spec.criteria ?? {}).map(([id, verdict]) => ({
    id,
    verdict,
    critique: critiqueOf(spec.runId, id),
    weight: 1,
    critical: id === 'critical-one',
  }))
  const applicable = criteria.filter(c => c.verdict !== 'not_applicable')
  const graders: GraderResult[] =
    criteria.length > 0
      ? [{ grader: 'rubric-judge(r@1)', status: criteria.some(c => c.verdict === 'fail') ? 'fail' : 'pass', criteria, reason: 'judged' }]
      : []
  const failing = criteria.some(c => c.verdict === 'fail')
  return {
    trace,
    graders,
    status: spec.status ?? (failing ? 'fail' : 'pass'),
    // Not-applicable criteria are left out of both sides of the share.
    score: applicable.length === 0 ? null : applicable.filter(c => c.verdict === 'pass').length / applicable.length,
    goalAchieved: spec.goalAchieved ?? null,
    costUsd: spec.costUsd === undefined ? 0.01 : spec.costUsd,
    durationMs: 100,
    ...(spec.error ? { error: spec.error } : {}),
    warnings: [],
  }
}

/** Writes a finished suite record straight into <workdir>/.evals/runs, the way the CLI would have. */
export function saveSuite(workdir: string, runs: RunSpec[], opts: { startedAt?: string; suiteId?: string } = {}): SuiteRecord {
  const writer = createSuiteWriter({
    dir: storePaths(workdir).runs,
    command: 'test',
    configFile: join(workdir, 'evals.config.yaml'),
    scenarioPath: join(workdir, 'scenarios'),
    startedAt: new Date(opts.startedAt ?? '2026-11-12T10:00:00.000Z'),
    suiteId: opts.suiteId,
  })
  writer.start()
  for (const r of runs) {
    const result = runResult(r)
    writer.onEvent({ type: 'run:end', runId: result.trace.runId, result })
  }
  return writer.finish({ endedAt: new Date(opts.startedAt ?? '2026-11-12T10:00:00.000Z') })
}
