import type { Grader, GraderResult, RunContext } from '../core/interfaces.js'
import type { Scenario } from '../core/scenario.js'
import type { Trace } from '../core/trace.js'

export interface RunGradersOptions {
  /** Skip LLM graders when a deterministic grader fails. Default true. */
  shortCircuit?: boolean
  /** Called as each result lands, for live reporting. */
  onResult?: (result: GraderResult) => void | Promise<void>
  /**
   * Checked before each grader. A returned string stops that grader from
   * running and becomes its `error` reason (used to enforce a cost budget).
   */
  guard?: () => string | undefined
}

const UNVERIFIED_WARNING =
  "This target's tool-call reporting is unverified. An empty or incomplete list may mean the response shape was not recognised."

/**
 * Runs graders in a fixed order: deterministic first, then everything else.
 *
 *  - A grader that needs tool calls is skipped, with a reason, on a target that
 *    cannot report them. A skipped check never counts as a pass.
 *  - On a target whose tool-call reporting is unverified, those graders run
 *    and carry a warning.
 *  - A grader that throws becomes an `error` result, so one bad grader cannot
 *    lose the others' results or masquerade as a verdict on the agent.
 *  - With shortCircuit (the default), a deterministic failure skips the LLM
 *    graders, which saves their cost and matches the original runner.
 */
export async function runGraders(
  graders: Grader[],
  trace: Trace,
  scenario: Scenario,
  ctx: RunContext,
  options: RunGradersOptions = {},
): Promise<GraderResult[]> {
  const { shortCircuit = true, onResult, guard } = options
  const deterministic = graders.filter(g => g.kind === 'deterministic')
  const rest = graders.filter(g => g.kind !== 'deterministic')
  const results: GraderResult[] = []

  const record = async (r: GraderResult) => {
    results.push(r)
    await onResult?.(r)
  }

  async function runOne(g: Grader): Promise<GraderResult> {
    const stop = guard?.()
    if (stop) return { grader: g.name, status: 'error', reason: stop }
    if (g.requires?.toolCalls && trace.target.toolCalls === 'none') {
      return {
        grader: g.name,
        status: 'skipped',
        reason: `Target "${trace.target.name}" cannot report tool calls, so this check could not run.`,
      }
    }
    try {
      const r = await g.grade(trace, scenario, ctx)
      if (g.requires?.toolCalls && trace.target.toolCalls === 'reported') {
        return { ...r, warnings: [...(r.warnings ?? []), UNVERIFIED_WARNING] }
      }
      return r
    } catch (e) {
      return { grader: g.name, status: 'error', reason: `Grader threw: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  for (const g of deterministic) await record(await runOne(g))

  const blocked = shortCircuit && results.some(r => r.status === 'fail')
  for (const g of rest) {
    if (blocked) {
      await record({ grader: g.name, status: 'skipped', reason: 'A deterministic check failed, so this grader was not run (shortCircuit).' })
    } else {
      await record(await runOne(g))
    }
  }
  return results
}
