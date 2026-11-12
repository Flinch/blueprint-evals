// The single record of what happened in one run. Every grader reads it, every
// reporter writes it, and it carries everything needed to reproduce or
// re-grade the run. See docs/design/0001-m0-core-interfaces.md.

export interface ToolCall {
  id?: string
  name: string
  arguments: Record<string, unknown>
  result?: unknown
  error?: string
}

export interface Turn {
  index: number
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  /** The target's raw response, kept so checks can assert on real fields. */
  raw?: unknown
  latencyMs?: number
  /** ISO 8601 */
  at: string
}

/**
 * How far the framework can trust a target's tool calls.
 *  - none: the target cannot report them. Tool-call graders are skipped.
 *  - reported: the target returns them, but the response shape has not been
 *    confirmed against a live account. Graders run and the result warns.
 *  - verified: a contract test has confirmed the shape.
 */
export type ToolCallSupport = 'none' | 'reported' | 'verified'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ModelRef {
  provider: string
  /** The model that was requested. */
  model: string
  effort?: Effort
  /** The model that actually answered, if a fallback ran. */
  servedBy?: string
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  /** null when no price is configured for the model. */
  costUsd: number | null
}

export interface RunMetadata {
  frameworkVersion: string
  models: { simulator?: ModelRef; judge?: ModelRef }
  /** The agent's own prompt version, supplied by the caller. */
  promptVersion?: string
  targetVersion?: string
  tags?: string[]
}

export interface Trace {
  schemaVersion: 1
  runId: string
  scenario: { id: string; version: string }
  /** toolCalls records what the target declared, so graders stay pure functions of the trace. */
  target: { name: string; kind: string; toolCalls: ToolCallSupport; version?: string }
  turns: Turn[]
  startedAt: string
  endedAt: string
  /** Summed across simulator and judge calls. */
  usage: Usage
  metadata: RunMetadata
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 }

/** Sum two usages. Cost is null if either side's cost is unknown. */
export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd === null || b.costUsd === null ? null : a.costUsd + b.costUsd,
  }
}
