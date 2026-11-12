import type { Grader, ModelProvider } from '../core/interfaces.js'
import type { Rubric, Scenario } from '../core/scenario.js'
import type { Effort } from '../core/trace.js'
import { createDeterministicGraders, createMinContentGrader } from './deterministic.js'
import { createGoalCheck } from './goal-check.js'
import { createRubricJudge } from './rubric-judge.js'

export interface ScenarioGraderOptions {
  /** The scenario's rubric, already loaded. Required when the scenario names one. */
  rubric?: Rubric
  /** Required when the scenario has a rubric or a goal. */
  provider?: ModelProvider
  judgeEffort?: Effort
  judgeTimeoutMs?: number
  showThresholds?: boolean
}

/**
 * The graders a scenario implies: its deterministic checks, a rubric judge if
 * it names a rubric, and a goal check if it states a goal.
 *
 * The degenerate-output guard is added only when an LLM grader is present. Its
 * job is to keep near-empty output away from a judge. A deterministic-only
 * scenario may legitimately get a terse reply ("OK") and must not fail it.
 */
export function gradersForScenario(scenario: Scenario, options: ScenarioGraderOptions = {}): Grader[] {
  const { rubric, provider } = options
  const needsLlm = Boolean(scenario.rubric || scenario.goal)

  if (scenario.rubric && !rubric) {
    throw new Error(`Scenario "${scenario.id}" names the rubric "${scenario.rubric}" but none was provided.`)
  }
  if (needsLlm && !provider) {
    throw new Error(`Scenario "${scenario.id}" has a rubric or goal, which need a model provider to grade.`)
  }

  const graders: Grader[] = []
  if (needsLlm) graders.push(createMinContentGrader())
  graders.push(...createDeterministicGraders(scenario.checks))
  if (rubric && provider) {
    graders.push(
      createRubricJudge({
        rubric,
        provider,
        effort: options.judgeEffort,
        timeoutMs: options.judgeTimeoutMs,
        showThresholds: options.showThresholds,
      }),
    )
  }
  if (scenario.goal && provider) {
    graders.push(createGoalCheck({ provider, effort: options.judgeEffort, timeoutMs: options.judgeTimeoutMs }))
  }
  return graders
}
