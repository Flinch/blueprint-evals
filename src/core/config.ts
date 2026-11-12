import { z } from 'zod'

// Secrets never appear in scenario files, and never as literals in config.
// They are written as ${env:NAME} references and resolved at run time. A
// literal value in a field marked secret is a validation error.

const ENV_REF = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/

export const secret = z.string().regex(ENV_REF, 'secrets must be an environment reference like ${env:NAME}, never a literal value')

export function resolveSecret(ref: string, env: NodeJS.ProcessEnv = process.env): string {
  const match = ENV_REF.exec(ref)
  if (!match) throw new Error('not an environment reference')
  const name = match[1]!
  const value = env[name]
  if (value === undefined || value === '') throw new Error(`environment variable ${name} is not set`)
  return value
}

const ModelConfig = z.object({
  provider: z.string().default('anthropic'),
  model: z.string(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  /** Retry a declined request on another model inside the same call. */
  fallbacks: z.boolean().default(true),
})

const TargetBase = { toolCalls: z.enum(['none', 'reported', 'verified']).optional() }

export const TargetConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('vapi-chat'), apiKey: secret, assistantId: z.string(), ...TargetBase }),
  z.object({
    kind: z.literal('http'),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).default({}),
    request: z.object({ body: z.record(z.string(), z.unknown()) }),
    response: z.object({
      text: z.string(),
      session: z.string().optional(),
      toolCalls: z
        .object({ path: z.string(), name: z.string(), arguments: z.string() })
        .optional(),
    }),
    ...TargetBase,
  }),
  z.object({ kind: z.literal('fake'), ...TargetBase }),
])
export type TargetConfig = z.infer<typeof TargetConfigSchema>

export const ConfigSchema = z.object({
  models: z.object({ simulator: ModelConfig, judge: ModelConfig }),
  pricing: z
    .record(z.string(), z.object({ inputPerMTok: z.number().nonnegative(), outputPerMTok: z.number().nonnegative() }))
    .default({}),
  targets: z.record(z.string(), TargetConfigSchema),
  budget: z.object({ maxCostUsd: z.number().positive().optional() }).default({}),
  timeouts: z
    .object({ simulatorMs: z.number().int().positive().default(60_000), judgeMs: z.number().int().positive().default(180_000) })
    .default({ simulatorMs: 60_000, judgeMs: 180_000 }),
  shortCircuit: z.boolean().default(true),
})
export type Config = z.infer<typeof ConfigSchema>
