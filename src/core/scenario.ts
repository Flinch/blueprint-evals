import { z } from 'zod'

// Scenario and rubric files are versioned YAML, reviewable like test code.
// Validated with zod at load time.

const id = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'use lowercase letters, digits, dot, dash or underscore')

// Deterministic checks. The first three need a target that reports tool calls;
// the output_* checks assert on the target's raw output (single-shot mode);
// reply_max_words counts the words of the assistant's reply text in every
// assistant turn, so it works in both modes and needs no tool-call reporting.
export const CheckSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tool_called'), tool: z.string() }),
  z.object({
    type: z.literal('tool_arg_match'),
    tool: z.string(),
    // Strict equality in M0. Semantic matching arrives in M3.
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({ type: z.literal('must_not_call'), tool: z.string() }),
  z.object({ type: z.literal('output_field_equals'), field: z.string(), expected: z.unknown() }),
  z.object({ type: z.literal('output_equals'), expected: z.unknown() }),
  z.object({
    type: z.literal('output_array_length'),
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('reply_max_words'),
    /** Most words allowed in any one assistant reply. Words are whitespace-separated tokens. */
    max: z.number().int().positive(),
  }),
])
export type Check = z.infer<typeof CheckSchema>

// A criterion is judged pass or fail, with a critique. There is no numeric
// score and no threshold: a judge that is allowed to hedge cannot be measured
// as a classifier (see docs/design/0002-judge-methodology.md). `.strict()` so a
// rubric that still carries a `threshold` is rejected loudly instead of having
// it silently ignored, since its meaning changed.
export const CriterionSchema = z
  .object({
    id,
    text: z.string().min(1),
    /** Weight in the derived score. It does not change the verdict. */
    weight: z.number().positive().default(1),
    /**
     * Marks a failure as release-blocking for consumers such as Launch
     * Readiness. A failed critical criterion fails the run like any other.
     */
    critical: z.boolean().default(false),
  })
  .strict()
export type Criterion = z.infer<typeof CriterionSchema>

// A few-shot example in the judge's prompt, in the post's format: the input,
// the output, the critique and the verdict. A response is often only wrong
// relative to what was asked, which is why the input is here.
export const AnchorSchema = z
  .object({
    /** The criterion this illustrates. Omit for an example of the rubric as a whole. */
    criterion: z.string().optional(),
    input: z.string().optional(),
    output: z.string(),
    verdict: z.enum(['pass', 'fail']),
    critique: z.string().min(1),
  })
  .strict()
export type Anchor = z.infer<typeof AnchorSchema>

export const RubricSchema = z
  .object({
    id,
    version: z.union([z.string(), z.number()]).transform(String),
    criteria: z.array(CriterionSchema).min(1),
    anchors: z.array(AnchorSchema).default([]),
    /**
     * Reference facts about the system under test (for example the clinic's
     * hours and the rules its tools follow). The judge may use them to verify
     * claims the assistant makes, and never as instructions to follow. Omitted
     * from the judge's prompt when unset.
     */
    context: z.string().min(1).optional(),
  })
  .superRefine((rubric, ctx) => {
    const seen = new Set<string>()
    rubric.criteria.forEach((c, i) => {
      if (seen.has(c.id)) {
        ctx.addIssue({ code: 'custom', path: ['criteria', i, 'id'], message: `duplicate criterion id "${c.id}"` })
      }
      seen.add(c.id)
    })
    rubric.anchors.forEach((a, i) => {
      if (a.criterion !== undefined && !seen.has(a.criterion)) {
        ctx.addIssue({ code: 'custom', path: ['anchors', i, 'criterion'], message: `anchor refers to unknown criterion "${a.criterion}"` })
      }
    })
  })
export type Rubric = z.infer<typeof RubricSchema>

export const ScenarioSchema = z
  .object({
    id,
    version: z.union([z.string(), z.number()]).transform(String),
    /** Name of a target defined in the config. */
    target: z.string(),
    mode: z.enum(['conversational', 'single_shot']).default('conversational'),
    // conversational
    persona: z.string().optional(),
    seed_message: z.string().optional(),
    max_turns: z.number().int().positive().default(10),
    // single_shot
    input: z.unknown().optional(),
    goal: z.string().optional(),
    checks: z.array(CheckSchema).default([]),
    /** Path to a rubric file, resolved relative to this scenario file. */
    rubric: z.string().optional(),
    /** Reserved for M2. M0 accepts only 1. */
    trials: z.literal(1).default(1),
    tags: z.array(z.string()).default([]),
  })
  .superRefine((s, ctx) => {
    if (s.mode === 'conversational' && !s.persona && !s.seed_message) {
      ctx.addIssue({
        code: 'custom',
        path: ['persona'],
        message: 'a conversational scenario needs a persona or a seed_message',
      })
    }
    if (s.mode === 'single_shot' && s.input === undefined) {
      ctx.addIssue({ code: 'custom', path: ['input'], message: 'a single_shot scenario needs an input' })
    }
  })
export type Scenario = z.infer<typeof ScenarioSchema>
