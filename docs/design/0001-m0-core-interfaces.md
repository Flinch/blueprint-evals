# 0001: Core interfaces (M0)

| | |
|---|---|
| Status | Draft, decisions recorded below |
| Milestone | M0 |
| Date | 2026-11-12 |
| Name | `blueprint-evals` |
| License | Apache-2.0 |

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
4. Fix run-status aggregation so one uncertain criterion no longer hides
   confident failures.
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
  reporters/   console, json, webhook
  cli/         run, validate
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
  target: { name: string; kind: string; version?: string }
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
  result?: unknown
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
    toolCalls: reported
```

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
    threshold: 0.7
    critical: false
  - id: no-medical-advice
    text: Gives no medical advice, and redirects clinical questions to a clinician.
    weight: 1
    threshold: 0.8
    critical: true
anchors:
  - excerpt: "Sure, I've moved it. Anything else?"
    label: fail
    rationale: Changed the booking without confirming the new time.
```

Files are validated with zod at load time. `critical` is new: a confident
failure on a critical criterion fails the run on its own, which is the hook
Launch Readiness's AI blocking rules will use later.

Secrets never appear in scenario files. They appear only in config, as
`${env:NAME}` references resolved at run time.

### Simulator

Decides the simulated user's next turn.

```ts
interface UserSimulator {
  next(ctx: { scenario: Scenario; turns: Turn[] }): Promise<{ message: string | null; usage: Usage }>
}
```

- `llm-persona`: a port of `buildPersonaPrompt`. Returns `null` when the persona
  ends the conversation.
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

The default `anthropic` provider uses `@anthropic-ai/sdk`:

- **Structured outputs for judges.** The judge's response is validated against
  a schema by the API, so fence stripping and the "invalid JSON becomes
  borderline" path both go away.
- **Effort set explicitly per role.** Judges default to `high`, the simulator to
  `low`. Both are configurable.
- **Refusals.** A `refusal` stop reason is a grader `error`. Red-team scenarios
  in M5 will hit this, and it must never be counted as a pass or a fail.
- **Server-side fallbacks** are on by default, so a declined request is retried
  on another model inside the same call. The model that actually answered is
  recorded in `ModelRef.servedBy`. A verdict produced by a fallback model is
  excluded from judge-calibration statistics, because the calibration belongs
  to the pinned judge. Turn fallbacks off in config to fail fast instead.
- **Cost** is computed from token usage and a price table in config. The SDK
  reports tokens and leaves pricing to the caller.

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
  status: 'pass' | 'fail' | 'uncertain' | 'error' | 'skipped'
  score?: number               // 0..1
  criteria?: CriterionResult[]
  reason: string
  evidence?: { turnIndex?: number; toolCallIndex?: number }[]
  usage?: Usage
}

interface CriterionResult {
  id: string
  score: number
  threshold: number
  weight: number
  critical: boolean
  band: 'confident_pass' | 'confident_fail' | 'uncertain'
  rationale: string
}
```

Status meanings:

- `uncertain`: the grader ran and its verdict is too close to call. Blueprint
  displays this as "borderline".
- `error`: the grader could not produce a verdict (timeout, refusal, invalid
  output, network). This describes the test infrastructure and says nothing
  about the agent.
- `skipped`: a requirement is unmet, for example a tool-call check on a target
  with `toolCalls: 'none'`. Always carries a reason. A skipped check never
  counts as a pass.

**M0 graders**

- Deterministic, ported as-is: `tool_called`, `tool_arg_match`,
  `must_not_call`, `output_field_equals`, `output_equals`,
  `output_array_length`. `tool_arg_match` keeps strict equality in M0. Semantic
  matching is M3.
- `min-content`: the degenerate-output guard, now its own grader that runs
  before any LLM grader.
- `rubric-judge`: the G-Eval-style judge. Reasoning per criterion before
  scoring, anchors as calibration examples, structured output, per-criterion
  bands using the existing `borderlineBandFor`.
- `goal-check`: did the agent achieve the scenario's goal. Kept separate from
  the rubric judge, as today.

Deterministic graders run first. If one fails, LLM graders are skipped, which
matches today's behavior and saves the cost. `shortCircuit: false` in config
runs everything regardless.

### Verdict aggregation

This is the status-collapse fix.

**Today:** if any criterion lands within its band of its threshold, the whole
run is `borderline`, even when other criteria failed outright.

**New rule**, evaluated in order:

1. Any grader `error`: the run is `error`. It is excluded from scores and pass
   rates and reported as an infrastructure problem.
2. Any deterministic `fail`: the run is `fail`.
3. Any criterion in `confident_fail`: the run is `fail`. A confident failure
   is a failure regardless of what else is uncertain.
4. Any criterion `uncertain`: the run is `uncertain`.
5. Otherwise: `pass`.

The general principle behind steps 3 and 4: a run is `uncertain` only when the
uncertain criteria could change the outcome. Resolve every uncertain criterion
as a pass, then as a fail. If both give the same verdict, that is the verdict.
With today's pass condition (every criterion must clear its threshold), this
reduces to the rule above. Stating the principle keeps the rule correct if the
pass condition changes later, for example to a weighted-score threshold.

The run score is unchanged: the weighted mean of criterion scores.

Before this ships to Blueprint, the new rule is replayed offline against the
stored Vapi results. Those rows already hold per-criterion scores and
thresholds, so the replay costs nothing and produces a before-and-after
distribution. That comparison is part of M0's acceptance criteria.

### Runner

```ts
function runScenario(scenario: Scenario, opts: RunOptions): Promise<RunResult>
function runSuite(scenarios: Scenario[], opts: RunOptions): Promise<RunResult[]>

interface RunOptions {
  target: Target
  simulator?: UserSimulator
  graders: Grader[]
  provider: ModelProvider
  reporters?: Reporter[]
  budget?: { maxCostUsd?: number; maxTurns?: number }
  timeouts?: { simulatorMs?: number; judgeMs?: number }   // defaults 60_000 and 180_000, as today
  trials?: 1                                              // widened in M2
  shortCircuit?: boolean
}

interface RunResult {
  trace: Trace
  graders: GraderResult[]
  status: 'pass' | 'fail' | 'uncertain' | 'error'
  score: number | null
  costUsd: number | null
  durationMs: number
}
```

Exceeding the budget stops the run with status `error` and a reason that says
which limit was hit. M0 runs scenarios one at a time. Concurrency arrives with
trials in M2.

### Reporters and events

The runner emits events: `run:start`, `turn`, `grader:done`, `run:end`.
Reporters subscribe to them.

```ts
interface Reporter {
  onEvent(event: RunEvent): void | Promise<void>
}
```

- `console`: a live line per turn and a summary table at the end.
- `json`: writes each RunResult to a file.
- `webhook`: posts events to a URL with a shared secret. Blueprint supplies a
  mapping that reproduces today's `/ai-eval-runs` payload and progress posts.
  A failed progress post never fails the run, the same rule the current
  `reportProgress` follows.

A `redact(trace)` hook runs before any reporter sees the Trace, so callers can
strip personal data from transcripts before they are written anywhere.

### CLI

```
evals validate scenarios/
evals run examples/scenarios/ --config examples/evals.config.yaml
```

Before running, the CLI prints what it will do and the maximum it could cost:

```
3 scenarios against "stub-agent", 1 trial each, up to 10 turns
Simulator and judge: claude-opus-5-5. Estimated maximum cost: $0.84
Continue? [y/N]
```

`--yes` skips the prompt for CI. Exit codes: `0` when every run passes, `1`
when any run fails or is uncertain, `2` on an error.

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
   - `uncertain` becomes `borderline`
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
  one must produce the same deterministic results and the same judge inputs.
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
- [ ] Judge timeouts, refusals and invalid output produce `error` rather than
      `borderline`.
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
10. Reporters: `console`, `json`, `webhook`.
11. CLI: `validate` and `run` with the cost preview.
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
2. **Status name.** This doc uses `uncertain` in the framework and keeps
   "borderline" as Blueprint's display label. Pick one word for both if that
   reads better in reports.
3. **Stub agent scope.** Rule-based replies are enough to exercise the `http`
   target and the graders, but they cannot show an LLM judge doing anything
   interesting. If the examples feel hollow, pull the first zoo agent (an
   LLM-backed booking agent) forward from M1 rather than growing the stub.
