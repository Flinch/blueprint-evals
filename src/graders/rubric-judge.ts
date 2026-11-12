import { z } from 'zod'
import { aggregateScore, bandFor } from '../core/aggregate.js'
import type { CriterionResult, Grader, GraderResult, ModelProvider } from '../core/interfaces.js'
import type { Rubric } from '../core/scenario.js'
import type { Effort } from '../core/trace.js'
import { INJECTION_NOTICE, renderTranscript } from './transcript.js'

// G-Eval style LLM judge: it writes its reasoning for each criterion before
// scoring it, so a failure is auditable instead of a bare number.
//
// What changed from the original runner, and why:
//  - Criteria are matched by stable id, not array position. Reordering a rubric
//    can no longer attach a verdict to the wrong criterion.
//  - Every criterion must be scored exactly once. The original silently
//    averaged over whatever the judge happened to return.
//  - The response is schema-validated. An unusable response is an `error`
//    (infrastructure), not `borderline` (a statement about the agent).
//  - Pass thresholds and weights are NOT shown to the judge by default. Telling
//    a judge "pass mark 0.7" invites it to anchor on 0.7, which clusters scores
//    right at the threshold and produces uncertain verdicts. Thresholds are
//    applied in code. Set showThresholds to compare the two.
//  - The transcript includes tool calls and is delimited as untrusted data.

export interface RubricJudgeOptions {
  rubric: Rubric
  provider: ModelProvider
  timeoutMs?: number
  effort?: Effort
  showThresholds?: boolean
}

const VerdictSchema = z.object({
  verdicts: z.array(
    z.object({
      criterion_id: z.string(),
      rationale: z.string(),
      score: z.number().min(0).max(1),
    }),
  ),
})

const SYSTEM =
  "You are a strict, impartial grader of an AI assistant's conversation against a rubric. " +
  'For EACH criterion, first write your reasoning (what the assistant did, citing turn numbers like [3], and whether it satisfies the criterion), ' +
  'then give a score from 0 to 1, where 1 means the criterion is fully met and 0 means it is not met at all. ' +
  'Use the whole range and base each score on the evidence. Do not skip the reasoning for any criterion. ' +
  INJECTION_NOTICE

export function buildJudgePrompt(rubric: Rubric, transcript: string, showThresholds: boolean): string {
  const criteria = rubric.criteria
    .map(c => `- id: ${c.id}\n  criterion: ${c.text}${showThresholds ? `\n  (weight ${c.weight}, pass threshold ${c.threshold})` : ''}`)
    .join('\n')
  const anchors = rubric.anchors.length
    ? '\n\nCalibration examples (how a human labelled similar output, and why):\n' +
      rubric.anchors.map(a => `- Excerpt: "${a.excerpt}"\n  Label: ${a.label}\n  Rationale: ${a.rationale}`).join('\n')
    : ''
  return `Criteria to grade (use these exact ids):\n${criteria}${anchors}\n\n<transcript>\n${transcript}\n</transcript>\n\nScore every criterion exactly once.`
}

export function createRubricJudge(options: RubricJudgeOptions): Grader {
  const { rubric, provider, timeoutMs = 180_000, effort = 'high', showThresholds = false } = options
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
          messages: [{ role: 'user', content: buildJudgePrompt(rubric, renderTranscript(trace.turns), showThresholds) }],
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
        if (!wanted.has(v.criterion_id)) return err(`The judge scored an unknown criterion "${v.criterion_id}".`, base)
        if (seen.has(v.criterion_id)) return err(`The judge scored criterion "${v.criterion_id}" more than once.`, base)
        seen.set(v.criterion_id, v)
      }
      const missing = rubric.criteria.filter(c => !seen.has(c.id)).map(c => c.id)
      if (missing.length > 0) return err(`The judge did not score: ${missing.join(', ')}.`, base)

      const criteria: CriterionResult[] = rubric.criteria.map(c => {
        const v = seen.get(c.id)!
        return {
          id: c.id,
          score: v.score,
          threshold: c.threshold,
          weight: c.weight,
          critical: c.critical,
          band: bandFor(v.score, c.threshold),
          rationale: v.rationale,
        }
      })

      const failed = criteria.filter(c => c.band === 'confident_fail')
      const uncertain = criteria.filter(c => c.band === 'uncertain')
      const fmt = (c: CriterionResult) => `${c.critical ? 'critical ' : ''}${c.id} (${c.score.toFixed(2)} vs ${c.threshold})`
      const status = failed.length > 0 ? 'fail' : uncertain.length > 0 ? 'uncertain' : 'pass'
      const reason =
        status === 'fail'
          ? `Failed: ${failed.map(fmt).join(', ')}` + (uncertain.length ? `. Also too close to call: ${uncertain.map(fmt).join(', ')}` : '')
          : status === 'uncertain'
            ? `Too close to call: ${uncertain.map(fmt).join(', ')}`
            : `All ${criteria.length} criteria met`

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
