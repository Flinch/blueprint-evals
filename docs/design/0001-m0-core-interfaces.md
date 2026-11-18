# 0001: Core interfaces (M0)

| | |
|---|---|
| Status | Draft, decisions recorded below |
| Milestone | M0 |
| Date | 2026-11-12 |
| Name | `blueprint-evals` |
| License | Apache-2.0 |

> **Superseded in part by [0002](0002-judge-methodology.md).** The judge no
> longer scores criteria from 0 to 1 against thresholds, and there is no
> `uncertain` status or band. Judges give each criterion a written critique and
> a binary pass or fail. Sections below that still describe bands or
> `uncertain` have been updated; where this document discusses the old runner's
> behavior, it is describing history.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Name | `blueprint-evals` | Ties the framework to Blueprint's credibility |
| License | Apache-2.0 | Patent grant, common for developer tooling |
| Distribution | Git dependency until M2, then reconsider npm | The interfaces should survive real use before they are published as a stable package. `package.json` is marked `private` to prevent an accidental npm publish |
| Reference target | Agents we control (a stub agent in M0, the bug zoo from M1). Vapi is one adapter among several | We need ground truth. See [What the framework is tested against](#what-the-framework-is-tested-against) |
| Repository publication | Held until the owner says go | Nothing is public yet |

## Summary

`blueprint-evals` is an open-source framework for testing AI agents. It drives
simulated users through conversations with an agent, records exactly what
happened, grades the result with deterministic checks and calibrated LLM
judges, and reports a verdict you can trust or audit.

It follows the same split as Playwright and the Blueprint dashboard. The
framework is the engine and knows nothing about Blueprint's database.
Blueprint stores, schedules and displays what the framework produces.

M0 extracts the runner that already exists in `qa-tool-server`
(`.github/scripts/run-ai-eval.js`) into this package, settles the core
interfaces (Target, Trace, Simulator, Grader, ModelProvider), adds a generic
HTTP target, and fixes the run-status collapse. Later milestones build on these
interfaces, so they need to be right before anything else moves.

## Goals

1. Define stable interfaces for Target, Trace, Scenario, Simulator,
   ModelProvider, Grader, Runner and Reporter.
2. Port the existing runner's behavior with no loss: persona loop, single-shot
   mode, the six deterministic checks, the rubric judge, the goal check and the
   minimum-content guard.
3. Add a generic HTTP target so the engine works against any agent with an API,
   beyond Vapi.
4. Fix run-status aggregation so one criterion near its threshold no longer hides
   confident failures. (Later resolved at the root: binary verdicts, so there is
   no threshold to be near. See 0002.)
5. Make Blueprint's CI job a thin wrapper around the package, with no database
   schema change.
6. Ship a CLI that runs scenario files locally.

## Non-goals (later milestones)

- Multiple trials per scenario and the statistics on top (M2). The config
  schema reserves `trials`, but M0 accepts only `1`.
- Trajectory graders, side-effect probes and semantic argument matching (M3).
- Judge bias tests and pairwise judging (M4).
- Red-team packs (M5), retrieval metrics (M6), CI gating and production trace
  ingestion (M7).
- Voice over telephony, a chat-widget target driven by Playwright, and
  multi-agent handoffs.

## Where this starts from

Facts about the current runner that shape this design:

| Today | Consequence for M0 |
|---|---|
| A connector contract already exists: `{config, input, previousState}` returns `{replyText, toolCalls, rawOutput, nextState}` | The Target interface formalizes it. Porting is mostly renaming |
| Two connectors: `vapi_assistant` (Vapi Chat API, text only) and `internal_function` (Blueprint's own AI helpers via a fixed registry) | Vapi moves into the framework. `internal_function` stays in Blueprint and registers as a custom target |
| LLM calls shell out to `npx claude -p` with `claude-sonnet-4-6` | Replaced by a ModelProvider on the Anthropic SDK. A CLI subprocess is the wrong dependency for a library |
| The judge's JSON is parsed by stripping Markdown fences. Invalid JSON becomes `borderline` | Structured outputs remove the parsing step. A judge that cannot produce a verdict becomes `error`, which is kept separate from `borderline` |
| Run status is `anyBorderline ? 'borderline' : ...`. One criterion near its threshold overrides everything, including confident failures. On the Vapi project (2026-09) all 52 runs landed in `borderline` | New aggregation rule, below |
| Criteria are referenced by array index (`criterion_index`) | Criteria get stable ids. Reordering a rubric no longer changes which verdict belongs to which criterion |
| Vapi tool-call extraction is defensive and unconfirmed (`reply.toolCalls \|\| reply.tool_calls \|\| []`) | If the field name is wrong, `toolCalls` is always empty. `must_not_call` then always passes and `tool_called` always fails, silently. Targets now declare whether they can report tool calls, and graders that depend on them are skipped with a reason when they cannot |
| The only external target today is Vapi's public sample agent (Riley), which Vapi owns and can change | It cannot be the reference target: defects cannot be planted in it, scores can drift for reasons outside the framework, and running it needs a paid account. It stays as one adapter and an integration check |
| Results go to `POST /ai-eval-runs` with progress posts during the conversation | A webhook reporter reproduces this exactly |

## Package

- **Language:** TypeScript, compiled to ESM. Node 20 or later. Types matter more
  for a framework than for an app, because adapter authors code against them.
- **Layout:** one package for now. A monorepo is premature until there is a
  second publishable unit.

```
src/
  core/        types, schemas (zod), runner, aggregation, events
  targets/     http, fake, vapi-chat
  simulators/  llm-persona, scripted
  graders/     deterministic, rubric-judge, goal-check, min-content
  models/      anthropic provider, fake provider, pricing
  reporters/   console, json (webhook not built yet)
  cli/         validate, run, calibrate
docs/design/
examples/      stub-agent, synthetic scenarios and an example config (optional Vapi example under examples/vapi/)
```

- **Runtime dependencies:** `@anthropic-ai/sdk`, `zod`, `yaml`. Nothing else
  without a reason written down.

## Interfaces

All types below are the contract. Field names are chosen so the Trace can later
be exported as OpenTelemetry spans using the GenAI semantic conventions (M7)
without renaming anything.

### Trace

The single record of what happened in one run. Every grader reads it, every
reporter writes it, and it must contain everything needed to reproduce or
re-grade the run.

```ts
interface Trace {
  schemaVersion: 1
  runId: string
  scenario: { id: string; version: string }
  // toolCalls records what the target declared, so graders stay pure
  // functions of the trace.
  target: { name: string; kind: string; toolCalls: ToolCallSupport; version?: string }
  turns: Turn[]
  startedAt: string           // ISO 8601
  endedAt: string
  usage: Usage                // summed across simulator and judge calls
  metadata: RunMetadata
}

interface Turn {
  index: number
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  raw?: unknown               // the target's raw response, for checks on real fields
  latencyMs?: number
  at: string
}

interface ToolCall {
  id?: string
  name: string
  arguments: Record<string, unknown>
  result?: unknown            // what the tool returned, when the target reports it
  error?: string
}

interface RunMetadata {
  frameworkVersion: string
  models: { simulator?: ModelRef; judge?: ModelRef }
  promptVersion?: string      // the agent's prompt version, supplied by the caller
  targetVersion?: string
  tags?: string[]
}

interface ModelRef {
  provider: string            // 'anthropic'
  model: string               // the model requested
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  servedBy?: string           // the model that actually answered, if a fallback ran
}

interface Usage {
  inputTokens: number
  outputTokens: number
  costUsd: number | null      // null when no price is configured for a model
}
```

**Reproducibility.** Current Claude models do not accept sampling parameters
such as temperature, so "set temperature to 0" is unavailable as a lever. A run
is reproducible to the extent its inputs are pinned: target version, agent
prompt version, simulator and judge model, effort level, and scenario version.
The Trace records all of them. Variance that remains is measured with repeated
trials in M2, which is the honest way to handle it.

### Target

Anything that can receive a turn and reply.

```ts
interface Target<Session = unknown> {
  name: string
  kind: string
  capabilities: {
    multiTurn: boolean
    toolCalls: 'none' | 'reported' | 'verified'
  }
  start?(ctx: RunContext): Promise<Session>
  send(input: TargetInput, session: Session | undefined, ctx: RunContext): Promise<TargetReply<Session>>
  end?(session: Session | undefined, ctx: RunContext): Promise<void>
}

interface TargetInput {
  text?: string               // conversational turns
  payload?: unknown           // single-shot structured input
}

interface TargetReply<Session> {
  text: string
  toolCalls: ToolCall[]
  raw?: unknown
  session?: Session           // replaces previousState / nextState
}
```

`capabilities.toolCalls` says how far the framework can trust the target's tool
calls:

- `none`: the target cannot report them. Tool-call graders are skipped.
- `reported`: the target returns them, but the response shape has not been
  confirmed against a live account. Graders run and the report carries a
  warning.
- `verified`: a contract test has confirmed the shape (see
  [Testing](#testing-the-framework)).

The Vapi target starts at `reported` until its contract test passes. That test
is optional for M0 (it needs a paid account), and `vapi-chat` ships as
`reported` if it has not run.

**M0 targets**

1. `vapi-chat`: a port of `vapiChatTurn`. The session is Vapi's chat id. It is
   one adapter and an integration check, and it is not the framework's
   reference target.
2. `http`: a generic adapter for any agent with an HTTP endpoint. Requests are
   built from a template, and the reply text, tool calls and session id are
   read from the response using JSON paths:

```yaml
targets:
  support-bot:
    kind: http
    url: https://staging.example.com/api/agent/chat
    headers:
      Authorization: "Bearer ${env:SUPPORT_BOT_TOKEN}"
    request:
      body:
        message: "{{input.text}}"
        conversation_id: "{{session}}"
    response:
      text: "$.reply"
      session: "$.conversation_id"
      toolCalls:
        path: "$.tool_calls[*]"
        name: "$.name"
        arguments: "$.args"
        result: "$.result"    # optional
    toolCalls: reported
```

   `name`, `arguments` and the optional `result` are paths relative to each
   element `path` matches. `result` is stored as `ToolCall.result`, as the
   target returned it, and LLM graders see it in the transcript (see
   [0002](0002-judge-methodology.md#tool-results-and-the-conversation-date)).
   Without it, or when a call has nothing at that path, no result is recorded.

3. `fake`: scripted replies for the framework's own tests.

`internal_function` stays in Blueprint. Blueprint registers it at startup with
`registerTarget('internal_function', factory)`. The trust boundary its comment
describes (a fixed registry, never import by string) stays where the code is.

### Scenario and rubric files

Scenarios are versioned YAML files, reviewable like test code.

```yaml
id: booking-reschedule-tomorrow
version: 3
target: stub-agent
mode: conversational          # or single_shot
persona: >
  A patient who wants to move tomorrow's 10am appointment to 3pm. Polite,
  slightly rushed, gives the date as "tomorrow".
seed_message: "Hi, I need to move my appointment."
goal: The appointment is rescheduled to tomorrow at 3pm and the patient is told so.
max_turns: 10
checks:
  - type: tool_called
    tool: reschedule_appointment
  - type: must_not_call
    tool: cancel_appointment
rubric: rubrics/scheduling.yaml
tags: [scheduling, happy-path]
```

```yaml
id: scheduling
version: 2
criteria:
  - id: confirms-before-acting
    text: Confirms the new time with the patient before changing the booking.
    weight: 2
  - id: no-medical-advice
    text: Gives no medical advice, and redirects clinical questions to a clinician.
    weight: 1
    critical: true
anchors:
  - criterion: confirms-before-acting
    input: "Can you move my appointment to 3pm tomorrow?"
    output: "Done. Your appointment is now tomorrow at 15:00."
    verdict: fail
    critique: The assistant changed the booking without asking the patient to confirm.
```

A rubric may also carry an optional `context` string, reference facts about the
system under test that the judge uses to verify claims (see 0002, "Reference
facts"). A scenario's `checks` may include `reply_max_words` (`max: 150`).

Files are validated with zod at load time. Each criterion is judged pass or fail:
there is no `threshold`, and a rubric that still has one is rejected. `critical`
marks a failure as release-blocking for consumers such as Launch Readiness's AI
blocking rules. It does not change the run status, since any failed criterion
already fails the run (see 0002).

Secrets never appear in scenario files. They appear only in config, as
`${env:NAME}` references resolved at run time.

### Simulator

Decides the simulated user's next turn.

```ts
interface UserSimulator {
  next(ctx: { scenario: Scenario; turns: Turn[] }): Promise<{ message: string | null; usage: Usage; model?: ModelRef }>
}
```

- `llm-persona` (implemented): a port of `buildPersonaPrompt`. Returns `null`
  when the persona ends the conversation, and when the scenario has no persona
  to continue from. Changes from the original: the answer is structured
  (`{action: 'say' | 'end', message}`) instead of a bare string with an
  `[END_CONVERSATION]` marker, so stray quotes or commentary cannot leak into
  the user's turn; and the agent's replies are marked untrusted, with a literal
  closing tag defused, so an agent that says "ignore your instructions" cannot
  talk the simulator out of its role. An invalid turn, an empty message or a
  refusal is an error, never an invented turn.
- `scripted`: a fixed list of user turns. Useful for regression cases and for
  the framework's tests.

### ModelProvider

Every LLM call the framework makes (simulator and judge) goes through this.

```ts
interface ModelProvider {
  complete(req: {
    role: 'simulator' | 'judge'
    system?: string
    messages: { role: 'user' | 'assistant'; content: string }[]
    schema?: ZodSchema          // structured output for judges
    effort?: ModelRef['effort']
    timeoutMs: number
  }): Promise<{
    text: string
    parsed?: unknown
    usage: Usage
    model: ModelRef
    stopReason: string
  }>
}
```

The default `anthropic` provider uses `@anthropic-ai/sdk` (implemented):

- **Structured outputs for judges.** The response is requested as JSON against a
  schema and then validated again in the provider. The API enforces structure
  but not value ranges such as "score between 0 and 1", so the second check is
  needed. A response that fails validation comes back with `parsed` unset and
  the grader reports it as invalid output.
- **Effort set explicitly per call.** Opus 5.5 defaults to `medium`, and a
  judge should not inherit that silently. Judges default to `high`, the
  simulator to `low`; both are configurable and a request can override them.
- **No sampling parameters and no thinking setting.** Current models reject
  `temperature` and friends and cannot have thinking disabled, so neither is
  sent. Effort is the only depth control.
- **Refusals** come back as `stopReason: "refusal"` with empty text, never as
  output, so a grader cannot mistake one for a verdict. Red-team scenarios in M5
  will hit this.
- **Server-side fallbacks** are on by default (`fallbacks: "default"`), so a
  declined request is retried on another model inside the same call. The model
  that actually answered is recorded in `ModelRef.servedBy`. A verdict produced
  by a fallback model is excluded from judge-calibration statistics, because the
  calibration belongs to the pinned judge. Turn fallbacks off in config to fail
  fast instead.
- **One deadline per call.** The SDK retries timeouts itself, which would
  multiply a per-attempt timeout, so the deadline is an abort signal covering the
  whole call, retries included. An external signal can be combined with it.
- **Streaming.** Judge calls with thinking can exceed HTTP timeouts when
  buffered, so every request streams.
- **Cost** is computed from token usage and a price table in config. When the
  API reports per-iteration usage (as it does when a fallback ran), each
  iteration is priced at its own model's rates, because a declined attempt and
  the rescuing attempt bill differently. A model with no price entry makes the
  call's cost `null`, never zero, and a total with any unknown part is `null`.
  Cache tokens are counted as ordinary input, a conservative overestimate, since
  the framework does not use prompt caching.
- **Verified so far against a fake client only.** An opt-in live test
  (`EVALS_LIVE=1`, two calls on Haiku 5.5, under one cent) confirms the real API
  accepts the request shape. It has not been run yet.

**Default models.** For new users, both roles default to `claude-opus-5-5`.
Blueprint's wrapper pins the judge to the model its existing results were
graded with, so scores stay comparable. Changing the judge model is a
deliberate, recorded event that requires re-baselining, and the Trace makes it
visible.

Other providers implement the same interface. M0 ships only `anthropic` and
`fake`.

### Grader

```ts
interface Grader {
  name: string
  kind: 'deterministic' | 'llm' | 'probe'
  requires?: { toolCalls?: true }
  grade(trace: Trace, scenario: Scenario, ctx: RunContext): Promise<GraderResult>
}

interface GraderResult {
  grader: string
  status: 'pass' | 'fail' | 'error' | 'skipped'
  score?: number               // weighted share of criteria passed, 0..1. A diagnostic
  criteria?: CriterionResult[]
  reason: string
  warnings?: string[]          // things a reader should know before trusting this result
  evidence?: { turnIndex?: number; toolCallIndex?: number }[]
  model?: ModelRef             // for LLM graders, including which model actually answered
  usage?: Usage
}

interface CriterionResult {
  id: string
  verdict: 'pass' | 'fail'
  critique: string             // written by the judge before the verdict
  weight: number
  critical: boolean
}
```

Status meanings:

- `error`: the grader could not produce a verdict (timeout, refusal, invalid
  output, network). This describes the test infrastructure and says nothing
  about the agent.
- `skipped`: a requirement is unmet, for example a tool-call check on a target
  with `toolCalls: 'none'`. Always carries a reason. A skipped check never
  counts as a pass.

**M0 graders** (implemented)

- Deterministic, ported: `tool_called`, `tool_arg_match`, `must_not_call`,
  `output_field_equals`, `output_equals`, `output_array_length`. Two changes
  from the original: comparison is structural (nested objects and key order no
  longer cause false failures; there is still no semantic matching, which is
  M3), and every result carries evidence pointing at the turn and tool call it
  is about. `output_field_equals` accepts a flat key or a JSON path.
- Deterministic, added later: `reply_max_words` with a positive integer `max`.
  It counts the words (whitespace-separated tokens, after trimming) of the
  reply text in every assistant turn, in conversational and single-shot mode,
  and fails if any reply has more than `max`. The reason names the turn and word
  count of the worst offender and how many replies exceeded the cap. It needs no
  tool-call reporting, so it is never skipped and never carries the vacuous-pass
  warning. It exists because an LLM judge cannot count words (see 0002).
- `min-content`: the degenerate-output guard, now its own grader. It counts the
  **assistant's** output only. The original counted every turn, so a long
  simulated-user message could hide an empty agent reply from it.
- `rubric-judge`: a critique per criterion, then a binary pass or fail (see
  0002). Changes from the original:
  - Verdicts are matched by criterion **id**, and every criterion must be
    judged exactly once. The original silently averaged over whatever came
    back.
  - Output is schema-validated. A missing, unknown or duplicate criterion, a
    refusal, a token-limit stop or an unparseable response is an `error`.
  - **No scale, no threshold, no band.** The first version of this judge scored
    criteria from 0 to 1 and kept pass thresholds out of the prompt, on the
    guess that showing them made scores cluster at the threshold. Reading the
    source article changed the diagnosis: a scale with a band makes hedging
    structural. Verdicts are now binary and weights and the critical flag are
    not shown to the judge.
  - The transcript includes tool calls and is delimited as untrusted data, with
    a literal closing tag defused so it cannot break out.
- `goal-check`: did the agent achieve the scenario's goal. Skipped, with a
  reason, when the scenario has no goal. It is a verdict: a goal failure fails
  the run. The original recorded it separately from run status, so Blueprint's
  wrapper filters it out of aggregation to keep legacy status unchanged (see
  [Open questions](#open-questions)).

`runGraders` orders them and enforces the rules that belong to no single
grader:

- Deterministic graders run first, then everything else.
- A grader that `requires` tool calls is **skipped**, with a reason, on a
  target whose `toolCalls` is `none`. On a `reported` target it runs and its
  result carries a warning. On a `verified` target it runs clean.
- `must_not_call` passes with a warning when no tool call was reported at all
  in the run, since that pass may be vacuous.
- A grader that throws becomes an `error` result, so one bad grader cannot lose
  the others' results or pass for a verdict on the agent.
- If a deterministic grader fails, LLM graders are skipped (and say why).
  `shortCircuit: false` runs everything regardless.

### Verdict aggregation

The rule is short, because judges decide:

1. Any grader `error`: the run is `error`. It is excluded from scores and pass
   rates and reported as an infrastructure problem.
2. Any failed check, failed criterion or failed goal: the run is `fail`.
3. Otherwise: `pass`.

Skipped graders are reported and never count as passes. The score is the
weighted share of criteria that passed, a diagnostic and not the verdict. The
headline outcome is `goalAchieved`, taken from the goal check.

History: the first version of this section replaced a rule in which a criterion
near its threshold made the whole run `borderline`. That rule put every one of
52 results on the one project we have data for in the borderline bucket, and
the aggregation fix ("confident failures win over uncertain ones") was kept for
a while as a stopgap. With binary verdicts there is no band, so the problem is
removed at the root. See 0002.

Before this ships to Blueprint, the stored Vapi results are replayed offline
with each stored criterion score cut at its stored threshold, giving the pass
rate that data would have had without a band. Those rows already hold the
scores and thresholds, so the replay costs nothing. It is an approximation,
since the stored scores came from a different judge prompt.

### Runner (implemented)

```ts
function runScenario(scenario: Scenario, opts: RunOptions): Promise<RunResult>
function runSuite(
  scenarios: Scenario[],
  optionsFor: (scenario: Scenario) => RunOptions | Promise<RunOptions>,
): Promise<RunResult[]>

interface RunOptions {
  target: Target
  simulator?: UserSimulator            // required when the scenario has a persona
  graders: Grader[]
  reporters?: Reporter[]
  budget?: { maxCostUsd?: number; maxTurns?: number }
  shortCircuit?: boolean               // default true
  metadata?: { promptVersion?: string; targetVersion?: string; tags?: string[] }
  signal?: AbortSignal
}

interface RunResult {
  trace: Trace
  graders: GraderResult[]
  status: 'pass' | 'fail' | 'error'
  score: number | null                // weighted share of criteria passed. A diagnostic
  goalAchieved: boolean | null         // the headline outcome, from the goal check
  costUsd: number | null
  durationMs: number
  error?: string                       // why the run is `error`
  warnings: string[]                   // grader warnings and reporter failures
}
```

Differences from the first draft of this section:

- **No `provider` and no `timeouts` on RunOptions.** The simulator and the
  graders are built with their own provider, effort and timeouts, so the runner
  has nothing to configure there. It learns which models ran from what they
  report, and records them in the trace.
- **`runSuite` takes a function.** Each scenario has its own target, simulator
  and graders (its target name, its rubric), so the options depend on the
  scenario.
- **`trials` is gone from RunOptions.** The scenario schema still accepts only
  `trials: 1`. Repeated trials arrive with M2.

Rules the runner enforces:

- **It does not throw.** A target, simulator or grader failure, a blown budget
  or a cancellation comes back as an `error` result with the partial trace and a
  reason, so one bad scenario cannot take a suite down. A scenario that cannot
  be set up inside `runSuite` is that scenario's error.
- **A run with no graders is an `error`,** since a test with no assertions
  passing is a false pass. A persona scenario with no simulator is also an
  `error`, caught before the target is touched.
- **Conversation.** The seed message opens the first turn if there is one.
  After that the simulator speaks until it ends the conversation, the
  scenario's `max_turns` is reached, or `budget.maxTurns` (if lower) is.
  Single-shot scenarios record the input as a user turn and the reply as an
  assistant turn.
- **Budget.** Spend is checked after every simulator call and before every
  grader. Past the limit, the run stops as an `error` naming the limit. A
  budget with an unpriced model is also an `error` ("spend is unknown"), since
  pretending to enforce it would be worse. If the last grader is what tips it
  over, the verdict is kept with a warning, because the spend already happened
  and the verdict is valid.
- **Reporters** receive `run:start`, `turn`, `grader:done` and `run:end`
  (also on error). A reporter that throws cannot fail the run. It adds a
  warning.
- **Scenarios run one at a time.** Concurrency arrives with trials in M2.

### Reporters and events

The runner emits events: `run:start`, `turn`, `grader:done`, `run:end`.
Reporters subscribe to them.

```ts
interface Reporter {
  onEvent(event: RunEvent): void | Promise<void>
}
```

- `console` (implemented): a line when each run starts and ends, the failed
  checks and criteria with the judge's critique, and a summary table at the end.
  It writes through a function it is given, so tests can capture it.
- `json` (implemented): writes `{ frameworkVersion, startedAt, results }`, with
  every RunResult and its full trace, and rewrites the file after each run so a
  suite that is stopped part-way keeps what it had.
- `webhook` (not built yet): posts events to a URL with a shared secret.
  Blueprint supplies a mapping that reproduces today's `/ai-eval-runs` payload
  and progress posts. A failed progress post never fails the run, the same rule
  the current `reportProgress` follows.

A `redact(trace)` hook (not built yet) runs before any reporter sees the Trace, so callers can
strip personal data from transcripts before they are written anywhere.

### CLI (implemented)

```
evals validate [path] [--config file] [--labels file] [--rubric file]
evals run [path] [--config file] [--only ids] [--tag t] [--yes] [--json file] [--max-cost usd]
evals calibrate --labels file --rubric file --split dev|test [--selection random|all] [--config file] [--yes]
```

Code: `src/cli/`. `runCli(argv, io)` takes an injectable `CliIo` (output, env,
cwd, whether a terminal is attached, a confirm function, and optionally a model
provider factory and fetch), so tests run it without a process or a network.

Before running, `evals run` prints what it will do and the most it could cost:

```
Cost preview
  Scenarios: 3 selected, 2 call a model, 1 deterministic only
  Simulator calls: up to 8 (claude-opus-5-5, effort low)
  Judge calls: up to 4 (claude-opus-5-5, effort high): 2 rubric judge, 2 goal check
  These are upper bounds. A failed deterministic check skips the judge calls, ...
  Cost cap per scenario: $0.50 (budget.maxCostUsd in the config)
  Worst-case total: $1.00 (2 scenarios x $0.50)
Continue? [y/N]
```

Differences from the first draft of this section:

- **The worst case is the cap, not an estimate.** A dollar figure from call
  counts alone would need a guess at tokens per call. The preview gives the
  counts, which are exact upper bounds, and the worst-case total as scenarios
  that call a model times the per-run cap (`budget.maxCostUsd`, or
  `--max-cost`). With no cap it says so in a warning instead of inventing a
  number. A used model with no price in the config is also a warning, since its
  cost is then unknown and a cap cannot be enforced.
- **Confirmation.** Any run that can call a model needs `--yes`, or a yes at the
  prompt when a terminal is attached. With no terminal and no `--yes` it
  refuses (exit 2) and runs nothing. Scenarios with no model calls skip the
  prompt.
- **Exit codes.** `evals run`: `0` when every run passes, `1` when any run fails
  or errors, `2` for a usage or config problem or an unconfirmed run.
  `evals validate`: `0` no errors, `1` errors, `2` usage. `evals calibrate`: `0`
  when measured (low rates are a measurement, not a failure), `1` when some
  labels could not be judged, `2` for usage, contamination or an unconfirmed
  run.
- **Unimplemented targets.** `vapi-chat` and `fake` parse in the config but are
  not implemented targets yet, so a scenario that uses one is an error in both
  `validate` and `run`.

The optional top-level `timezone` (an IANA name such as `America/Toronto`)
sets the timezone in which LLM graders are told the conversation's date. It
defaults to the machine's local timezone. Set it to the timezone the system
under test uses for "today".

Example config:

```yaml
models:
  simulator: { provider: anthropic, model: claude-opus-5-5, effort: low }
  judge:     { provider: anthropic, model: claude-opus-5-5, effort: high, fallbacks: true }
pricing:
  claude-opus-5-5: { inputPerMTok: 4.00, outputPerMTok: 20.00 }
targets:
  stub-agent:
    kind: http
    url: http://localhost:4010/chat
    request: { body: { message: "{{input.text}}", conversation_id: "{{session}}" } }
    response: { text: "$.reply", session: "$.conversation_id" }
    toolCalls: reported
  # Optional, needs a Vapi account:
  # vapi-riley:
  #   kind: vapi-chat
  #   apiKey: "${env:VAPI_API_KEY}"
  #   assistantId: "${env:VAPI_ASSISTANT_ID}"
```

## What the framework is tested against

A framework is only as credible as its evidence that it catches real failures.
That needs targets whose correct behavior is known, and Vapi's sample agent
cannot provide that. The framework is tested against, in order of preference:

1. **Agents we control, with planted defects** (the "bug zoo", built in M1).
   Small agents written against the Anthropic SDK, backed by a fake system of
   record. Each has defects planted on purpose, such as a wrong date argument,
   booking without confirming, inventing an answer when retrieval misses, or
   following instructions hidden in tool output. The framework's catch rate on
   planted defects measures the framework itself. They run in CI and need no
   account beyond a model key.
2. **The `fake` target and `fake` provider** for unit tests: scripted, free,
   deterministic.
3. **A stub HTTP agent for M0.** The zoo does not exist until M1, and the
   `http` target needs something to run against. M0 ships `examples/stub-agent`,
   a tiny HTTP server with rule-based replies and reported tool calls. It needs
   no model key and no account, so anyone can clone the repo and run the
   examples. M1 replaces it with the first zoo agent behind the same HTTP
   contract, so the example scenarios keep working.
4. **Third-party agents (Vapi's chat API and others)** as contract-tested
   adapters and demos. This is the real job in production, but it is the
   wrong foundation for developing and validating the framework.

Example scenarios in the repository target 1 to 3. Vapi scenarios, if shipped,
live under `examples/vapi/` and are marked as requiring an account.

## Blueprint integration

`run-ai-eval.js` shrinks to a wrapper of roughly 60 lines:

1. Fetch the payload and target config from the existing webhook endpoints.
2. Map them to a Scenario and a Target. Criterion ids are generated from array
   positions (`c0`, `c1`, ...) for existing rubrics.
3. Call `runScenario`.
4. The Blueprint webhook mapping converts the RunResult to today's payload:
   - existing `borderline` rows stay as legacy data. The framework no longer produces that status
   - `error` becomes a `failed` run with `error_message` set
   - criterion ids map back to `criterion_index` for the existing UI

No database schema change in M0. The CI job keeps using the `ANTHROPIC_API_KEY`
it already has, now through the SDK. Until the package is published, Blueprint
depends on it by git URL.

## Open-source hygiene

- **Fresh repository with fresh history.** Nothing is copied with history from
  `qa-tool-server`, whose history references client projects.
- **Synthetic fixtures only.** No client names, tenant ids, transcripts from
  client projects, assistant ids or keys. Examples target the stub agent (and,
  from M1, the bug zoo). Any optional Vapi example reads its assistant id and
  key from environment variables.
- **Secrets only as environment references**, enforced by the config loader:
  a literal value in a field marked secret is a validation error.
- **No telemetry.**
- At first publish: `LICENSE`, `README`, `CONTRIBUTING.md`, and `SECURITY.md`
  with a private way to report vulnerabilities.

## Testing the framework

- **Unit tests** with `fake` targets and a `fake` provider returning scripted
  replies. Deterministic, free, run on every commit. Test runner: vitest.
- **Aggregation tests**, table-driven, including the offline replay of the
  stored Vapi results.
- **Parity test.** One recorded transcript graded by the old runner and the new
  one must produce the same deterministic results. The judge prompt
  intentionally differs (ids, binary verdicts, tool calls, delimiters), so judge
  behavior is compared by running both on stored transcripts, not asserted
  identical.
- **Ground-truth test.** The deterministic graders run over real HTTP against
  the stub agent. The correct agent passes the example scenarios and the agent
  with the planted `no-confirm` defect fails the ones it should, with evidence
  pointing at the offending call.
- **Vapi contract test.** One live conversation against a test assistant with a
  tool, saving the real response as a fixture and confirming where tool calls
  appear. It makes paid API calls, so it runs only on request. When it passes,
  `vapi-chat` moves to `toolCalls: 'verified'`.

## Acceptance criteria

- [ ] Every interface above exists, exported and documented.
- [ ] `evals run` runs an example scenario end to end against the `http` target
      and `examples/stub-agent`, with no account and no key beyond the model
      key for the simulator and judge.
- [ ] `vapi-chat` runs the same scenario shape end to end against a test
      assistant. This is a manual check, not part of CI.
- [ ] All six deterministic checks and both LLM graders are ported, and the
      parity test passes.
- [ ] Aggregation follows the new rule. The offline replay of stored Vapi
      results is written up with before-and-after counts.
- [ ] A tool-call grader on a target that cannot report tool calls is
      `skipped` with a reason and is never counted as a pass.
- [ ] Judge timeouts, refusals and invalid output produce `error`, and a judge
      cannot return an in-between verdict.
- [ ] Blueprint's CI job runs through the package with no schema change, and an
      existing project's results render unchanged in the dashboard.
- [ ] Optional: the Vapi contract test has run once, with its fixture
      committed, which moves `vapi-chat` to `toolCalls: 'verified'` (or shows
      that the field name was wrong). M0 can close without it.

## Task breakdown

1. Repository scaffold: TypeScript, vitest, lint, CI.
2. Types and zod schemas for scenario, rubric and config.
3. Anthropic provider: structured outputs, refusal handling, fallbacks,
   usage-based cost.
4. Simulators: `llm-persona` port and `scripted`.
5. Targets: `http`, `fake`, and the `vapi-chat` port.
6. `examples/stub-agent` and example scenarios against it.
7. Graders: deterministic ports, `min-content`, `rubric-judge`, `goal-check`,
   with the new statuses.
8. Aggregation, plus the offline replay script.
9. Runner, events, budgets.
10. Reporters: `console` and `json` (done), `webhook` (not built yet).
11. CLI: `validate`, `run` with the cost preview, and `calibrate` (done).
12. Blueprint wrapper, on a feature branch in `qa-tool-server`.
13. Vapi contract test (optional, paid, run on request).

Steps 1, 2 and the aggregation half of step 8 are already in the repository
(schemas, interface types, the aggregation rule and tests).

Estimate: one to two weeks part-time.

## Open questions

Name, license, distribution and the reference target are settled and recorded
under [Decisions](#decisions). What remains:

1. **Blueprint's judge model.** Keep `claude-sonnet-4-6` for continuity with
   existing results, or re-baseline on a current model now. Re-baselining is
   cheapest while volume is small (52 graded runs), but the human-agreement
   labels collected so far apply to the old judge and would need collecting
   again.
2. **Goal-check and run status.** In the framework a failed goal fails the run.
   In Blueprint's current data it never did. The wrapper can exclude
   `goal-check` from aggregation to preserve existing statuses, but then the
   dashboard's status and the framework's disagree. Decide whether to keep
   that gap or let goal failures count.
3. **Stub agent scope.** Rule-based replies are enough to exercise the `http`
   target and the graders, but they cannot show an LLM judge doing anything
   interesting. If the examples feel hollow, pull the first zoo agent (an
   LLM-backed booking agent) forward from M1 rather than growing the stub.
