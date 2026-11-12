// The contracts everything else is built against. See
// docs/design/0001-m0-core-interfaces.md for the reasoning behind each one.

import type { ZodType } from 'zod'
import type { Scenario } from './scenario.js'
import type { Effort, ModelRef, ToolCall, ToolCallSupport, Trace, Turn, Usage } from './trace.js'

export interface RunContext {
  runId: string
  signal?: AbortSignal
}

// ---------------------------------------------------------------- Target

export interface TargetInput {
  /** Conversational turns. */
  text?: string
  /** Single-shot structured input. */
  payload?: unknown
}

export interface TargetReply<Session> {
  text: string
  toolCalls: ToolCall[]
  raw?: unknown
  /** Replaces the old previousState / nextState pair. */
  session?: Session
}

export interface Target<Session = unknown> {
  name: string
  kind: string
  capabilities: { multiTurn: boolean; toolCalls: ToolCallSupport }
  start?(ctx: RunContext): Promise<Session>
  send(input: TargetInput, session: Session | undefined, ctx: RunContext): Promise<TargetReply<Session>>
  end?(session: Session | undefined, ctx: RunContext): Promise<void>
}

// ------------------------------------------------------------- Simulator

export interface UserSimulator {
  /** message is null when the simulated user ends the conversation. */
  next(ctx: { scenario: Scenario; turns: Turn[] }): Promise<{ message: string | null; usage: Usage; model?: ModelRef }>
}

// --------------------------------------------------------- ModelProvider

export interface CompleteRequest {
  role: 'simulator' | 'judge'
  system?: string
  messages: { role: 'user' | 'assistant'; content: string }[]
  /** Structured output. The response is validated against this schema. */
  schema?: ZodType
  effort?: Effort
  /** Output cap. Provider defaults depend on the role. */
  maxTokens?: number
  /** Overall deadline for the call, retries included. */
  timeoutMs: number
  signal?: AbortSignal
}

export interface CompleteResponse {
  text: string
  /** Present when a schema was given and the output validated. */
  parsed?: unknown
  usage: Usage
  model: ModelRef
  stopReason: string
}

export interface ModelProvider {
  complete(req: CompleteRequest): Promise<CompleteResponse>
}

// ----------------------------------------------------------------- Grader

/**
 *  - pass / fail: the grader ran and reached a verdict. A judge must decide:
 *    there is no "uncertain" (see docs/design/0002-judge-methodology.md).
 *  - error: the grader could not produce a verdict (timeout, refusal,
 *    invalid output, network). Describes the test infrastructure, not the agent.
 *  - skipped: a requirement was unmet. Always carries a reason. A skipped
 *    check never counts as a pass.
 */
export type GraderStatus = 'pass' | 'fail' | 'error' | 'skipped'

export interface CriterionResult {
  id: string
  verdict: 'pass' | 'fail'
  /** The judge's written reasoning, produced before the verdict. */
  critique: string
  weight: number
  critical: boolean
}

export interface GraderResult {
  grader: string
  status: GraderStatus
  /** Weighted share of criteria passed, 0..1. A diagnostic, not the verdict. */
  score?: number
  criteria?: CriterionResult[]
  reason: string
  /** Things a reader should know before trusting this result. */
  warnings?: string[]
  evidence?: { turnIndex?: number; toolCallIndex?: number }[]
  usage?: Usage
  /** The model behind an LLM grader, including which one actually answered. */
  model?: ModelRef
}

export interface Grader {
  name: string
  kind: 'deterministic' | 'llm' | 'probe'
  requires?: { toolCalls?: true }
  grade(trace: Trace, scenario: Scenario, ctx: RunContext): Promise<GraderResult>
}

// --------------------------------------------------------------- Reporter

export type RunEvent =
  | { type: 'run:start'; runId: string; scenarioId: string }
  | { type: 'turn'; runId: string; turn: Turn }
  | { type: 'grader:done'; runId: string; result: GraderResult }
  | { type: 'run:end'; runId: string; result: RunResult }

export interface Reporter {
  onEvent(event: RunEvent): void | Promise<void>
}

// ----------------------------------------------------------------- Runner

export type RunStatus = 'pass' | 'fail' | 'error'

export interface RunResult {
  trace: Trace
  graders: GraderResult[]
  status: RunStatus
  /** Weighted share of criteria passed, or null if no criteria were judged. A diagnostic. */
  score: number | null
  /** The headline outcome, from the goal check. Null when there is no goal or the check could not run. */
  goalAchieved: boolean | null
  costUsd: number | null
  durationMs: number
  /** Why the run is `error`: a target, simulator or grader failure, or a blown budget. */
  error?: string
  /** Grader warnings and reporter failures, de-duplicated. */
  warnings: string[]
}
