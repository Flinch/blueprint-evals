import { randomUUID } from 'node:crypto'
import { aggregateScore, aggregateStatus, goalAchievedFrom } from './aggregate.js'
import type {
  Grader, GraderResult, Reporter, RunContext, RunEvent, RunResult, RunStatus, Target, UserSimulator,
} from './interfaces.js'
import type { Scenario } from './scenario.js'
import { addUsage, ZERO_USAGE, type ModelRef, type Trace, type Turn, type Usage } from './trace.js'
import { FRAMEWORK_VERSION } from './version.js'
import { runGraders } from '../graders/run.js'

export interface RunOptions {
  target: Target
  /** Required for scenarios with a persona. Optional for seed-only and single-shot scenarios. */
  simulator?: UserSimulator
  graders: Grader[]
  reporters?: Reporter[]
  budget?: {
    /** Stops the run, as an error, once spend passes this. Needs a price for every model called. */
    maxCostUsd?: number
    /** Caps conversation turns below the scenario's own max_turns. */
    maxTurns?: number
  }
  /** Skip LLM graders after a deterministic failure. Default true. */
  shortCircuit?: boolean
  /** Recorded in the trace so a result can be reproduced and compared across versions. */
  metadata?: { promptVersion?: string; targetVersion?: string; tags?: string[] }
  signal?: AbortSignal
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Runs one scenario: plays the conversation, grades the trace, aggregates a
 * verdict. It does not throw. A target, simulator or grader failure, a blown
 * budget or a cancellation comes back as an `error` result with whatever trace
 * was recorded, so one bad scenario cannot take a suite down with it.
 */
export async function runScenario(scenario: Scenario, options: RunOptions): Promise<RunResult> {
  const { target, simulator, reporters = [] } = options
  const runId = randomUUID()
  const startedAt = new Date()
  const ctx: RunContext = { runId, signal: options.signal }

  const turns: Turn[] = []
  let usage: Usage = ZERO_USAGE
  let simulatorModel: ModelRef | undefined
  let judgeModel: ModelRef | undefined
  const warnings = new Set<string>()

  const emit = async (event: RunEvent) => {
    for (const r of reporters) {
      try {
        await r.onEvent(event)
      } catch (e) {
        // A reporter must never be able to fail the run it is narrating.
        warnings.add(`A reporter failed on "${event.type}": ${message(e)}`)
      }
    }
  }

  const trace = (): Trace => ({
    schemaVersion: 1,
    runId,
    scenario: { id: scenario.id, version: scenario.version },
    target: {
      name: target.name,
      kind: target.kind,
      toolCalls: target.capabilities.toolCalls,
      ...(options.metadata?.targetVersion ? { version: options.metadata.targetVersion } : {}),
    },
    turns,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    usage,
    metadata: {
      frameworkVersion: FRAMEWORK_VERSION,
      models: { ...(simulatorModel ? { simulator: simulatorModel } : {}), ...(judgeModel ? { judge: judgeModel } : {}) },
      ...(options.metadata?.promptVersion ? { promptVersion: options.metadata.promptVersion } : {}),
      ...(options.metadata?.tags ? { tags: options.metadata.tags } : {}),
    },
  })

  const finish = async (status: RunStatus, graders: GraderResult[], error?: string): Promise<RunResult> => {
    for (const g of graders) for (const w of g.warnings ?? []) warnings.add(w)
    const result: RunResult = {
      trace: trace(),
      graders,
      status,
      score: aggregateScore(graders),
      goalAchieved: goalAchievedFrom(graders),
      costUsd: usage.costUsd,
      durationMs: Date.now() - startedAt.getTime(),
      ...(error ? { error } : {}),
      warnings: [...warnings],
    }
    await emit({ type: 'run:end', runId, result })
    return result
  }

  const budgetProblem = (): string | undefined => {
    const max = options.budget?.maxCostUsd
    if (max === undefined) return undefined
    if (usage.costUsd === null) {
      return 'A cost budget is set but spend is unknown: a model that was called has no price configured.'
    }
    if (usage.costUsd > max) return `Cost budget of $${max} exceeded ($${usage.costUsd.toFixed(4)} spent).`
    return undefined
  }

  const push = async (turn: Omit<Turn, 'index' | 'at'>) => {
    const t: Turn = { ...turn, index: turns.length, at: new Date().toISOString() }
    turns.push(t)
    await emit({ type: 'turn', runId, turn: t })
  }

  // Preflight: problems with how the run was set up, not with the agent.
  if (options.graders.length === 0) {
    return finish('error', [], 'No graders were configured, so this run could not produce a verdict.')
  }
  if (scenario.mode === 'conversational' && scenario.persona && !simulator) {
    return finish('error', [], `Scenario "${scenario.id}" has a persona but no simulator was provided.`)
  }

  await emit({ type: 'run:start', runId, scenarioId: scenario.id })

  let session: unknown
  let started = false
  try {
    if (target.start) session = await target.start(ctx)
    started = true

    if (scenario.mode === 'single_shot') {
      const input = scenario.input
      await push({ role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input, null, 2) })
      const t0 = performance.now()
      const reply = await target.send({ text: typeof input === 'string' ? input : undefined, payload: input }, session, ctx)
      await push({ role: 'assistant', content: reply.text, toolCalls: reply.toolCalls, raw: reply.raw, latencyMs: Math.round(performance.now() - t0) })
    } else {
      const maxTurns = Math.min(scenario.max_turns, options.budget?.maxTurns ?? Infinity)
      for (let i = 0; i < maxTurns; i++) {
        if (ctx.signal?.aborted) return await finish('error', [], 'The run was cancelled.')

        let userMessage: string | null
        if (i === 0 && scenario.seed_message) {
          userMessage = scenario.seed_message
        } else if (!simulator) {
          break
        } else {
          const next = await simulator.next({ scenario, turns })
          usage = addUsage(usage, next.usage)
          simulatorModel = next.model ?? simulatorModel
          const over = budgetProblem()
          if (over) return await finish('error', [], over)
          userMessage = next.message
        }
        if (userMessage === null) break // the persona decided the conversation is over

        await push({ role: 'user', content: userMessage })
        const t0 = performance.now()
        const reply = await target.send({ text: userMessage }, session, ctx)
        session = reply.session ?? session
        await push({ role: 'assistant', content: reply.text, toolCalls: reply.toolCalls, raw: reply.raw, latencyMs: Math.round(performance.now() - t0) })
      }
    }
  } catch (e) {
    return await finish('error', [], message(e))
  } finally {
    if (started && target.end) {
      try {
        await target.end(session, ctx)
      } catch (e) {
        warnings.add(`Target cleanup failed: ${message(e)}`)
      }
    }
  }

  const results = await runGraders(options.graders, trace(), scenario, ctx, {
    shortCircuit: options.shortCircuit,
    guard: budgetProblem,
    onResult: async r => {
      usage = addUsage(usage, r.usage ?? ZERO_USAGE)
      judgeModel ??= r.model
      await emit({ type: 'grader:done', runId, result: r })
    },
  })

  // Spend that landed on the last grader cannot be undone, so it is reported
  // rather than turned into an error that would discard a valid verdict.
  const over = budgetProblem()
  if (over && !results.some(r => r.status === 'error')) {
    warnings.add(`${over} The verdict is kept because the spend had already happened.`)
  }

  const status = aggregateStatus(results)
  const errors = results.filter(r => r.status === 'error').map(r => `${r.grader}: ${r.reason}`)
  return finish(status, results, errors.length > 0 ? errors.join('; ') : undefined)
}

/**
 * Runs scenarios one at a time. `optionsFor` supplies each scenario's target,
 * simulator and graders, since those depend on the scenario (its target name,
 * its rubric). Concurrency arrives with trials in M2.
 *
 * With a `signal`, no further scenario is started once it aborts, and the
 * results so far are returned.
 */
export async function runSuite(
  scenarios: Scenario[],
  optionsFor: (scenario: Scenario) => RunOptions | Promise<RunOptions>,
  suiteOptions: { signal?: AbortSignal } = {},
): Promise<RunResult[]> {
  const results: RunResult[] = []
  for (const scenario of scenarios) {
    // Once cancelled, no further scenario is started. The one in flight ends as an error result.
    if (suiteOptions.signal?.aborted) break
    let opts: RunOptions
    try {
      opts = await optionsFor(scenario)
    } catch (e) {
      // Failing to set a scenario up is that scenario's error, not the suite's.
      results.push(setupFailure(scenario, message(e)))
      continue
    }
    results.push(await runScenario(scenario, opts))
  }
  return results
}

function setupFailure(scenario: Scenario, error: string): RunResult {
  const now = new Date().toISOString()
  return {
    trace: {
      schemaVersion: 1,
      runId: randomUUID(),
      scenario: { id: scenario.id, version: scenario.version },
      target: { name: scenario.target, kind: 'unknown', toolCalls: 'none' },
      turns: [],
      startedAt: now,
      endedAt: now,
      usage: ZERO_USAGE,
      metadata: { frameworkVersion: FRAMEWORK_VERSION, models: {} },
    },
    graders: [],
    status: 'error',
    score: null,
    goalAchieved: null,
    costUsd: 0,
    durationMs: 0,
    error,
    warnings: [],
  }
}
