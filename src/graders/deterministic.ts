import type { Check } from '../core/scenario.js'
import { deepEqual } from '../core/equal.js'
import { queryOne } from '../core/jsonpath.js'
import type { Grader, GraderResult } from '../core/interfaces.js'
import type { ToolCall, Trace } from '../core/trace.js'

// Zero LLM calls. These run first and, by default, stop the LLM graders on a
// failure: a broken tool call makes free-text grading moot, and it is the
// cheaper thing to check.
//
// Ported from the original runner. Two deliberate differences: argument and
// output comparison is structural (nested objects and key order no longer
// cause false failures), and every result carries evidence pointing at the
// turn and tool call it is about.

interface IndexedCall {
  call: ToolCall
  turnIndex: number
  toolCallIndex: number
}

function allCalls(trace: Trace): IndexedCall[] {
  return trace.turns.flatMap(turn =>
    (turn.toolCalls ?? []).map((call, toolCallIndex) => ({ call, turnIndex: turn.index, toolCallIndex })),
  )
}

/** The raw output of the last assistant turn, which is what single-shot checks assert on. */
function lastRaw(trace: Trace): { found: boolean; raw: unknown; turnIndex?: number } {
  for (let i = trace.turns.length - 1; i >= 0; i--) {
    const turn = trace.turns[i]!
    if (turn.role === 'assistant') return { found: turn.raw !== undefined, raw: turn.raw, turnIndex: turn.index }
  }
  return { found: false, raw: undefined }
}

const NO_CALLS_HINT =
  'The target reported no tool calls at all in this run. If the agent does call tools, check the target\'s toolCalls mapping.'

function describe(check: Check): string {
  switch (check.type) {
    case 'tool_called':
    case 'tool_arg_match':
    case 'must_not_call':
      return `${check.type}(${check.tool})`
    case 'output_field_equals':
      return `output_field_equals(${check.field})`
    default:
      return check.type
  }
}

function needsToolCalls(check: Check): boolean {
  return check.type === 'tool_called' || check.type === 'tool_arg_match' || check.type === 'must_not_call'
}

export function createDeterministicGrader(check: Check): Grader {
  const name = describe(check)
  const result = (r: Omit<GraderResult, 'grader'>): GraderResult => ({ grader: name, ...r })

  return {
    name,
    kind: 'deterministic',
    requires: needsToolCalls(check) ? { toolCalls: true } : undefined,

    async grade(trace): Promise<GraderResult> {
      switch (check.type) {
        case 'tool_called': {
          const matches = allCalls(trace).filter(c => c.call.name === check.tool)
          if (matches.length > 0) {
            const first = matches[0]!
            return result({
              status: 'pass',
              reason: `Tool "${check.tool}" was called`,
              evidence: [{ turnIndex: first.turnIndex, toolCallIndex: first.toolCallIndex }],
            })
          }
          const none = allCalls(trace).length === 0
          return result({
            status: 'fail',
            reason: `Tool "${check.tool}" was never called` + (none ? `. ${NO_CALLS_HINT}` : ''),
          })
        }

        case 'tool_arg_match': {
          const calls = allCalls(trace).filter(c => c.call.name === check.tool)
          const match = calls.find(c => Object.entries(check.args).every(([k, v]) => deepEqual(c.call.arguments[k], v)))
          if (match) {
            return result({
              status: 'pass',
              reason: `A call to "${check.tool}" matched the expected arguments`,
              evidence: [{ turnIndex: match.turnIndex, toolCallIndex: match.toolCallIndex }],
            })
          }
          if (calls.length === 0) {
            return result({ status: 'fail', reason: `Tool "${check.tool}" was never called, so no arguments could match` })
          }
          const seen = calls.map(c => JSON.stringify(c.call.arguments)).join('; ')
          return result({
            status: 'fail',
            reason: `No call to "${check.tool}" matched ${JSON.stringify(check.args)}. Calls seen: ${seen}`,
            evidence: calls.map(c => ({ turnIndex: c.turnIndex, toolCallIndex: c.toolCallIndex })),
          })
        }

        case 'must_not_call': {
          const offenders = allCalls(trace).filter(c => c.call.name === check.tool)
          if (offenders.length > 0) {
            return result({
              status: 'fail',
              reason: `Tool "${check.tool}" was called ${offenders.length} time(s) but must not be`,
              evidence: offenders.map(c => ({ turnIndex: c.turnIndex, toolCallIndex: c.toolCallIndex })),
            })
          }
          // A pass here is only meaningful if tool calls could have been seen.
          const vacuous = allCalls(trace).length === 0 && trace.target.toolCalls !== 'verified'
          return result({
            status: 'pass',
            reason: `Tool "${check.tool}" was not called`,
            warnings: vacuous ? [`This pass may be vacuous. ${NO_CALLS_HINT}`] : undefined,
          })
        }

        case 'output_field_equals': {
          const out = lastRaw(trace)
          if (!out.found) return noRaw(name)
          const actual = check.field.startsWith('$') ? queryOne(out.raw, check.field) : (out.raw as Record<string, unknown> | null)?.[check.field]
          return deepEqual(actual, check.expected)
            ? result({ status: 'pass', reason: `output.${check.field} equals the expected value`, evidence: [{ turnIndex: out.turnIndex }] })
            : result({
                status: 'fail',
                reason: `Expected output.${check.field} to be ${JSON.stringify(check.expected)}, got ${JSON.stringify(actual)}`,
                evidence: [{ turnIndex: out.turnIndex }],
              })
        }

        case 'output_equals': {
          const out = lastRaw(trace)
          if (!out.found) return noRaw(name)
          return deepEqual(out.raw, check.expected)
            ? result({ status: 'pass', reason: 'Output matched the expected value', evidence: [{ turnIndex: out.turnIndex }] })
            : result({ status: 'fail', reason: 'Output did not match the expected value', evidence: [{ turnIndex: out.turnIndex }] })
        }

        case 'output_array_length': {
          const out = lastRaw(trace)
          if (!out.found) return noRaw(name)
          const ev = [{ turnIndex: out.turnIndex }]
          if (!Array.isArray(out.raw)) {
            return result({ status: 'fail', reason: `Expected the output to be an array, got ${out.raw === null ? 'null' : typeof out.raw}`, evidence: ev })
          }
          if (check.min != null && out.raw.length < check.min) {
            return result({ status: 'fail', reason: `Expected at least ${check.min} items, got ${out.raw.length}`, evidence: ev })
          }
          if (check.max != null && out.raw.length > check.max) {
            return result({ status: 'fail', reason: `Expected at most ${check.max} items, got ${out.raw.length}`, evidence: ev })
          }
          return result({ status: 'pass', reason: `Output has ${out.raw.length} items, within bounds`, evidence: ev })
        }
      }
    },
  }

  // A missing raw output is a setup problem, not agent behavior, so it is an
  // error rather than a fail.
  function noRaw(grader: string): GraderResult {
    return {
      grader,
      status: 'error',
      reason: 'The target recorded no raw output, which this check needs. Use a target that returns one.',
    }
  }
}

export function createDeterministicGraders(checks: Check[]): Grader[] {
  return checks.map(createDeterministicGrader)
}

// ---------------------------------------------------------------------------
// Degenerate-output guard. Near-empty agent output can trick an LLM judge into
// a false pass ("One Token to Fool LLM-as-a-Judge", arXiv 2507.08794), so it
// is failed here and never sent to a judge.
//
// Counts the assistant's output only. The original runner counted every turn,
// so a long simulated-user message could hide an empty agent reply from it.
// ---------------------------------------------------------------------------

export const MIN_CONTENT_CHARS = 15

export function createMinContentGrader(minChars = MIN_CONTENT_CHARS): Grader {
  return {
    name: 'min-content',
    kind: 'deterministic',
    async grade(trace): Promise<GraderResult> {
      const text = trace.turns
        .filter(t => t.role === 'assistant')
        .map(t => t.content)
        .join(' ')
        .trim()
      if (text.length >= minChars) {
        return { grader: 'min-content', status: 'pass', reason: `Assistant output is ${text.length} characters` }
      }
      return {
        grader: 'min-content',
        status: 'fail',
        reason: `Assistant output is ${text.length} characters, under the ${minChars} needed to grade meaningfully. Failed without calling a judge (degenerate-output guard).`,
      }
    },
  }
}
