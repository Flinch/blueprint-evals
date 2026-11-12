// The contracts everything else is built against. See
// docs/design/0001-m0-core-interfaces.md for the reasoning behind each one.

import type { ZodType } from 'zod'
import type { Scenario } from './scenario.js'
import type { Effort, ModelRef, ToolCall, Trace, Turn, Usage } from './trace.js'

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

/**
 * How far the framework can trust the target's tool calls.
 *  - none: the target cannot report them. Tool-call graders are skipped.
 *  - reported: the target returns them, but the response shape has not been
 *    confirmed against a live account. Graders run and the report warns.
 *  - verified: a contract test has confirmed the shape.
 */
export type ToolCallSupport = 'none' | 'reported' | 'verified'

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
  next(ctx: { scenario: Scenario; turns: Turn[] }): Promise<{ message: string | null; usage: Usage }>
}

// --------------------------------------------------------- ModelProvider

export interface CompleteRequest {
  role: 'simulator' | 'judge'
  system?: string
  messages: { role: 'user' | 'assistant'; content: string }[]
  /** Structured output. The response is validated against this schema. */
  schema?: ZodType
  effort?: Effort
  timeoutMs: number
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
 *  - pass / fail: the grader ran and reached a verdict.
 *  - uncertain: the grader ran and the verdict is too close to call.
 *    Blueprint displays this as "borderline".
 *  - error: the grader could not produce a verdict (timeout, refusal,
 *    invalid output, network). Describes the test infrastructure, not the agent.
 *  - skipped: a requirement was unmet. Always carries a reason. A skipped
 *    check never counts as a pass.
 */
export type GraderStatus = 'pass' | 'fail' | 'uncertain' | 'error' | 'skipped'

export type CriterionBand = 'confident_pass' | 'confident_fail' | 'uncertain'

export interface CriterionResult {
  id: string
  score: number
  threshold: number
  weight: number
  critical: boolean
  band: CriterionBand
  rationale: string
}

export interface GraderResult {
  grader: string
  status: GraderStatus
  /** 0..1 */
  score?: number
  criteria?: CriterionResult[]
  reason: string
  evidence?: { turnIndex?: number; toolCallIndex?: number }[]
  usage?: Usage
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

export type RunStatus = 'pass' | 'fail' | 'uncertain' | 'error'

export interface RunResult {
  trace: Trace
  graders: GraderResult[]
  status: RunStatus
  /** Weighted mean of criterion scores, or null if nothing produced one. */
  score: number | null
  costUsd: number | null
  durationMs: number
}
