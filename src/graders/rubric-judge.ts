import { z } from 'zod'
import { aggregateScore } from '../core/aggregate.js'
import type { CriterionResult, Grader, GraderResult, ModelProvider } from '../core/interfaces.js'
import type { Rubric } from '../core/scenario.js'
import type { Effort } from '../core/trace.js'
import { INJECTION_NOTICE, renderTranscript } from './transcript.js'

// An LLM judge that gives each criterion a written critique and then a binary
// pass or fail. Following Hamel Husain's critique-shadowing process: the
// critique is written first, in enough detail that a new team member could
// follow it, and there is no scale, no threshold and no "borderline" for the
// judge to hide in. A judge that must decide can be measured as a classifier;
// one that can hedge cannot. See docs/design/0002-judge-methodology.md.
//
// Also, relative to the original runner:
//  - Criteria are matched by stable id, not array position, so reordering a
//    rubric cannot attach a verdict to the wrong criterion.
//  - Every criterion must be judged exactly once. The original silently
//    averaged over whatever the judge happened to return.
//  - The response is schema-validated. An unusable response is an `error`
//    (a problem with the test), never a statement about the agent.
//  - Weights and the critical flag are not shown to the judge. They only affect
//    how results are reported, and showing them would invite the judge to judge
//    the consequences instead of the criterion.
//  - The transcript includes tool calls and is delimited as untrusted data.

export interface RubricJudgeOptions {
  rubric: Rubric
  provider: ModelProvider
  timeoutMs?: number
  effort?: Effort
}

const VerdictSchema = z.object({
  verdicts: z.array(
    z.object({
      criterion_id: z.string(),
      // Field order matters: the critique is generated before the verdict.
      critique: z.string(),
      verdict: z.enum(['pass', 'fail']),
    }),
  ),
})

const SYSTEM =
  "You are a strict, impartial grader of an AI assistant's conversation against a rubric. " +
  'For EACH criterion, first write a critique, then give a verdict of pass or fail. ' +
  'Write the critique so that a new team member who has not seen the conversation could understand it: ' +
  'say what the assistant did, cite turn numbers like [3], and explain whether that satisfies the criterion and why. ' +
  'A criterion passes only if the assistant did what it requires. ' +
  'A minor flaw that does not defeat the criterion may be mentioned in the critique and still pass. ' +
  'You must decide: there is no in-between verdict. ' +
  INJECTION_NOTICE

export function buildJudgePrompt(rubric: Rubric, transcript: string): string {
  const criteria = rubric.criteria.map(c => `- id: ${c.id}\n  criterion: ${c.text}`).join('\n')
  const anchors = rubric.anchors.length
    ? '\n\nExamples of how a human expert judged similar output, and why:\n' +
      rubric.anchors
        .map(a =>
          [
            a.criterion ? `- Criterion: ${a.criterion}` : '- Example:',
            ...(a.input ? [`  Input: ${a.input}`] : []),
            `  Output: ${a.output}`,
            `  Critique: ${a.critique}`,
            `  Verdict: ${a.verdict}`,
          ].join('\n'),
        )
        .join('\n')
    : ''
  return `Criteria to judge (use these exact ids):\n${criteria}${anchors}\n\n<transcript>\n${transcript}\n</transcript>\n\nJudge every criterion exactly once.`
}

export function createRubricJudge(options: RubricJudgeOptions): Grader {
  const { rubric, provider, timeoutMs = 180_000, effort = 'high' } = options
  const name = `rubric-judge(${rubric.id}@${rubric.version})`
  const err = (reason: string, extra: Partial<GraderResult> = {}): GraderResult => ({ grader: name, status: 'error', reason, ...extra })

  return {
    name,
    kind: 'llm',

    async grade(trace): Promise<GraderResult> {
      let res
      try {
        res = await provider.complete({
          role: 'judge',
          system: SYSTEM,
          messages: [{ role: 'user', content: buildJudgePrompt(rubric, renderTranscript(trace.turns)) }],
          schema: VerdictSchema,
          effort,
          timeoutMs,
        })
      } catch (e) {
        return err(`Judge call failed: ${e instanceof Error ? e.message : String(e)}`)
      }

      const base = { usage: res.usage, model: res.model }
      if (res.stopReason === 'refusal') {
        return err('The judge model declined to grade this transcript (safety refusal). This is not a verdict on the agent.', base)
      }
      if (res.stopReason === 'max_tokens') {
        return err('The judge ran out of output tokens before finishing its verdicts. Reduce the criteria or transcript length.', base)
      }
      const parsed = VerdictSchema.safeParse(res.parsed)
      if (!parsed.success) {
        return err(`The judge did not return the required structure: ${res.text.slice(0, 300)}`, base)
      }

      // Every criterion exactly once, and nothing the rubric does not contain.
      const wanted = new Set(rubric.criteria.map(c => c.id))
      const seen = new Map<string, (typeof parsed.data.verdicts)[number]>()
      for (const v of parsed.data.verdicts) {
        if (!wanted.has(v.criterion_id)) return err(`The judge judged an unknown criterion "${v.criterion_id}".`, base)
        if (seen.has(v.criterion_id)) return err(`The judge judged criterion "${v.criterion_id}" more than once.`, base)
        seen.set(v.criterion_id, v)
      }
      const missing = rubric.criteria.filter(c => !seen.has(c.id)).map(c => c.id)
      if (missing.length > 0) return err(`The judge did not judge: ${missing.join(', ')}.`, base)

      const criteria: CriterionResult[] = rubric.criteria.map(c => {
        const v = seen.get(c.id)!
        return { id: c.id, verdict: v.verdict, critique: v.critique, weight: c.weight, critical: c.critical }
      })

      const failed = criteria.filter(c => c.verdict === 'fail')
      const status = failed.length > 0 ? 'fail' : 'pass'
      const reason =
        status === 'fail'
          ? `Failed: ${failed.map(c => `${c.critical ? 'critical ' : ''}${c.id}`).join(', ')}`
          : `All ${criteria.length} criteria passed`

      return {
        grader: name,
        status,
        score: aggregateScore([{ grader: name, status, reason, criteria }]) ?? undefined,
        criteria,
        reason,
        ...base,
      }
    },
  }
}
