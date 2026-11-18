import { z } from 'zod'
import type { Grader, GraderResult, ModelProvider } from '../core/interfaces.js'
import type { Effort } from '../core/trace.js'
import { conversationDateLine, INJECTION_NOTICE, renderTranscript } from './transcript.js'

// Did the agent reach the scenario's stated goal? Kept as a separate, much
// smaller call than the rubric judge: goal achievement should stay gradable
// for a scenario with no rubric, and re-grading it never means re-sending the
// whole rubric. Skipped when the scenario has no goal.
//
// Like the rubric judge, it sees tool results and the date the conversation
// took place: a goal such as "booked for next Tuesday" depends on both.

const GoalSchema = z.object({ achieved: z.boolean(), critique: z.string() })

const SYSTEM =
  'You decide whether an AI assistant achieved a stated goal by the end of a conversation. ' +
  'Judge by what actually happened in the transcript, including tool calls, not by what the assistant claims. ' +
  INJECTION_NOTICE

export interface GoalCheckOptions {
  provider: ModelProvider
  timeoutMs?: number
  effort?: Effort
  /** IANA timezone for the conversation date line. Default: the machine's. */
  timeZone?: string
}

export function createGoalCheck(options: GoalCheckOptions): Grader {
  const { provider, timeoutMs = 60_000, effort = 'high', timeZone } = options
  const name = 'goal-check'

  return {
    name,
    kind: 'llm',

    async grade(trace, scenario): Promise<GraderResult> {
      if (!scenario.goal) return { grader: name, status: 'skipped', reason: 'The scenario has no goal to check.' }

      const dateLine = conversationDateLine(trace.startedAt, timeZone)
      const date = dateLine ? `${dateLine}\n` : ''
      const fail = (reason: string, extra: Partial<GraderResult> = {}): GraderResult => ({ grader: name, status: 'error', reason, ...extra })
      let res
      try {
        res = await provider.complete({
          role: 'judge',
          system: SYSTEM,
          messages: [
            {
              role: 'user',
              content: `Goal:\n${scenario.goal}\n\n${date}<transcript>\n${renderTranscript(trace.turns)}\n</transcript>\n\nWas the goal achieved by the end of the conversation?`,
            },
          ],
          schema: GoalSchema,
          effort,
          timeoutMs,
        })
      } catch (e) {
        return fail(`Goal check call failed: ${e instanceof Error ? e.message : String(e)}`)
      }

      const base = { usage: res.usage, model: res.model }
      if (res.stopReason === 'refusal') return fail('The model declined to grade this transcript (safety refusal). This is not a verdict on the agent.', base)
      const parsed = GoalSchema.safeParse(res.parsed)
      if (!parsed.success) return fail(`The goal check did not return the required structure: ${res.text.slice(0, 300)}`, base)

      return {
        grader: name,
        status: parsed.data.achieved ? 'pass' : 'fail',
        reason: parsed.data.critique,
        ...base,
      }
    },
  }
}
