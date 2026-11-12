import { z } from 'zod'

// Scenario and rubric files are versioned YAML, reviewable like test code.
// Validated with zod at load time.

const id = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'use lowercase letters, digits, dot, dash or underscore')

// Deterministic checks. The first three need a target that reports tool calls;
// the output_* checks assert on the target's raw output (single-shot mode).
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
])
export type Check = z.infer<typeof CheckSchema>

export const CriterionSchema = z.object({
  id,
  text: z.string().min(1),
  weight: z.number().positive().default(1),
  threshold: z.number().min(0).max(1).default(0.7),
  /** A confident failure on a critical criterion fails the run on its own. */
  critical: z.boolean().default(false),
})
export type Criterion = z.infer<typeof CriterionSchema>

export const AnchorSchema = z.object({
  excerpt: z.string(),
  label: z.enum(['pass', 'fail']),
  rationale: z.string(),
})
export type Anchor = z.infer<typeof AnchorSchema>

export const RubricSchema = z
  .object({
    id,
    version: z.union([z.string(), z.number()]).transform(String),
    criteria: z.array(CriterionSchema).min(1),
    anchors: z.array(AnchorSchema).default([]),
  })
  .superRefine((rubric, ctx) => {
    const seen = new Set<string>()
    rubric.criteria.forEach((c, i) => {
      if (seen.has(c.id)) {
        ctx.addIssue({ code: 'custom', path: ['criteria', i, 'id'], message: `duplicate criterion id "${c.id}"` })
      }
      seen.add(c.id)
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
