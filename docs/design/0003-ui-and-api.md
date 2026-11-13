# 0003: The local web UI and its API

| | |
|---|---|
| Status | Phase 1 (backend) implemented. Phase 2 (front end) builds on this document |
| Date | 2026-11-13 |
| Code | `src/engine/`, `src/store/`, `src/server/`, `src/ui/api-types.ts`, `src/cli/ui.ts` |
| Builds on | [0001](0001-m0-core-interfaces.md) (runner, graders), [0002](0002-judge-methodology.md) (labels, calibration, the random quota) |

## Summary

`evals ui` starts a small web server on your own machine. The page it serves
shows saved runs (a dashboard, a run list, and per-run detail with transcripts,
tool calls, verdicts and critiques), starts runs and calibrations, and holds a
review queue where a person labels outputs pass or fail with a critique. It
reads and writes the same files the command line does, so the two stay in step.

The server is the only thing that touches files, the agent under test, or a
model. The page talks to it over a JSON API and one server-sent-events stream.
This document is the contract for that API. The TypeScript types in
[`src/ui/api-types.ts`](../../src/ui/api-types.ts) are the same contract in code,
and the appendix repeats them verbatim (a test fails if the two drift apart).

## Goals

1. See what happened: every saved run, with the trace and the judge's critiques.
2. Run scenarios and calibration from the browser, through the same code path as
   the command line: same graders, same budget enforcement, same cost preview.
3. Label data blind, producing the existing `labels.jsonl` format, with the
   random-sampling quota from 0002 enforced by the server.
4. Be safe to leave running: local only, authenticated, and unable to spend money
   without a confirmation tied to the exact plan.

## Non-goals

- Anything remote. The server binds `127.0.0.1` and there is no option to change it.
- Accounts, roles or multi-user editing. One person at a keyboard.
- Editing scenarios, rubrics or the config from the page. They are files in a
  repository, reviewed like code. The API reads them and reports problems.
- Accepting a model key. The key comes from the server's environment.

## How the pieces fit

```
browser  --JSON /api/*, SSE-->  src/server  --calls-->  src/engine  --uses-->  core, graders, targets
                                    |
                                    +--reads and writes-->  src/store  -->  <workdir>/.evals/
```

- `src/engine/` holds the cores that both the CLI and the server call: choosing
  scenarios (`selectScenarios`), planning and the cost preview (`planRun`,
  `buildRunPreview`, `planCalibration`), and executing (`executeRun`,
  `executeCalibration`). `evals run` and `evals calibrate` call these. Nothing
  about a run is implemented twice.
- `src/store/` holds the files: suite records, labels, the review queue, saved
  calibrations. Readers are tolerant (a corrupt file is skipped with a warning)
  and ids are validated against path traversal.
- `src/server/` is `node:http` only (no new dependencies): routing, security,
  static files, server-sent events.

## Data layout

Everything lives under `<workdir>/.evals/`, where the workdir is the directory
`evals` was started in. `.evals/` is in `.gitignore`.

```
.evals/
  runs/<suiteId>.json            one record per suite: every `evals run` and every UI run
  calibration/<calibrationId>.json   one record per calibration
  labels.jsonl                   human labels (the default; `evals ui --labels file` picks another)
```

**Suite record** (`SuiteRecord`):

```ts
{ schemaVersion: 1, suiteId, startedAt, endedAt: string | null, status: 'running' | 'complete' | 'cancelled' | 'failed',
  command, configFile, scenarioPath, results: RunResult[], summary: SuiteSummary }
```

- `suiteId` is `20261113T091500Z-1a2b3c4d`: sortable, safe as a file name. The
  readers accept only `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` with no `..`, and the
  file name must match the `suiteId` inside.
- The file is written when the suite starts and again after every finished run.
  Every write goes to a temporary file in the same directory, then is renamed
  over the target, so a reader never sees half a file and a crashed run leaves
  the results it had. `endedAt` is `null` and `status` is `running` until the
  suite ends. A suite that is still `running` on disk but is not the one running
  now is shown as `interrupted`.
- `status` is `cancelled` after a cancel and `failed` if the run machinery
  itself threw (a scenario failing is a result, never a `failed` suite).
- `summary` is derived from `results` and is recomputed on read.
- `command` is `evals run <args>` for the command line and `evals ui` for a run
  started from the page. `configFile` and `scenarioPath` are absolute.
- `evals run --no-save` skips the file. `--json` is unchanged and independent.

**Calibration record** (`CalibrationRecord`): `{ schemaVersion: 1, calibrationId, at,
rubricId, rubricVersion, labelsFile, split, selection, command, report }`, where
`report` is the `CalibrationReport` from `src/calibration/evaluate.ts`.

**Labels** are the format in 0002, one JSON object per line, append-only.

Stored traces hold whatever the agent said, which could include a secret the
agent echoed. The files on disk are not scrubbed. API responses are (see
[Security](#security-model)).

## Security model

The page can start runs that cost money and read transcripts that may be
sensitive, so the server defends itself even though it is local.

| Threat | Defence |
|---|---|
| Another machine reaches the server | Binds `127.0.0.1` only. There is no flag to widen it |
| Another local user, or a stray process, calls the API | A random 32-byte token, generated at startup, required on **every** request (see below) |
| A web page in your browser calls the API (CSRF) | Token required, `SameSite=Strict` cookie, `Origin` checked, `Sec-Fetch-Site` checked, `POST` bodies must be `application/json` (which forces a preflight cross-origin), and no CORS headers are ever sent |
| DNS rebinding (a hostile site re-points its name at 127.0.0.1 and reads the API) | The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`, on every request, or the answer is 403 |
| A secret value leaks in a response | Nothing in the API is built from the environment, and every outgoing body (JSON and event stream) is scrubbed of the values of secret-looking environment variables and of any variable the config refers to with `${env:NAME}` |
| A client supplies a model key | The API does not accept one. Bodies are strict: an unknown field (`apiKey`, `env`, `headers`) is a 400. The key is read from the server process's environment by the model provider |
| Spending without looking | The confirmation protocol below |
| Oversized or malformed requests | Bodies over 1 MiB are refused with 413 and the connection is dropped. Malformed JSON is a 400 |
| Path traversal | Static files: the URL path is decoded once, any `..`, `.`, dotfile segment, NUL or backslash is refused, and the real path (symlinks followed) must stay inside `dist/ui`. API ids: a strict alphabet, and a `path` in a request body must resolve inside the workdir, the config's directory or the configured scenarios path |
| Clickjacking, sniffing, caching | `X-Frame-Options: DENY`, a `Content-Security-Policy` that allows only this origin, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer` |

### The token

- `evals ui` prints a URL: `http://127.0.0.1:4747/?token=<token>`. That is the
  only place the token is shown. It is never logged elsewhere.
- Loading any page with the right `?token=` sets a cookie named `evals_ui_<port>`
  (`HttpOnly`, `SameSite=Strict`, `Path=/`) and redirects to the same path
  without the token, so it does not stay in the address bar or the history. The
  port is in the cookie name because browsers share cookies across ports on one
  host.
- An API call is authenticated by the cookie (what the page uses), or by
  `Authorization: Bearer <token>`, or by `X-Evals-Token: <token>` (for scripts).
  The token in a query string is **not** accepted on `/api/*`.
- A page request with no valid token gets a short 401 page that says to open the
  link from the terminal. An API request gets a 401 `unauthorized` error.
- Tokens are compared in constant time. A new token is generated every time the
  server starts.

### The cost confirmation protocol

Anything that could call a model (a run with a persona, a rubric or a goal, or a
calibration with labels to judge) must pass through two calls:

1. **Preview.** `POST /api/run/preview` (or `/api/calibrate/preview`) returns the
   same cost preview the CLI prints, as data, and a `previewToken`. The token is
   an HMAC-SHA256, under a key that exists only in this server process, of a
   canonical form of the exact plan: the scenarios selected (id, version and a
   hash of each scenario and rubric, in run order), the cost cap, both models
   with their efforts and prices, the timeouts, and a hash of each target's
   config. For a calibration: the rubric, the split, the selection, a hash of
   the label set, and the judge model. It also covers an expiry, 15 minutes out.
2. **Start.** `POST /api/run/start` (or `/api/calibrate/start`) takes the same
   body plus `previewToken` and `confirm: true`. The server rebuilds the plan from
   the files as they are **now**, recomputes the HMAC and compares. A plan that
   changed (a different selection, a higher cap, an edited scenario, a new price,
   new labels), an expired token and a token from another server all fail.

| Situation | Answer |
|---|---|
| The plan can call a model, and `confirm` is not `true` or `previewToken` is missing | 428 `confirmation_required` |
| The token does not match a fresh preview of this plan, or has expired | 412 `preview_token_invalid` |
| The plan cannot call a model (checks only) | Starts without a token, like the CLI |

The server decides "can call a model" itself, from the plan. The client's word is
not used. A refused call makes no provider, writes no file and spends nothing.

## Conventions

- Every success body is a JSON object. Every failure is `ApiErrorBody`.
- Timestamps are ISO 8601 strings. Costs are US dollars, or `null` when a model
  had no price in the config. A total with any unknown part is `null`, never a
  partial sum.
- Paths are absolute, as the server sees them.
- Responses are never cached.
- The server runs **one job at a time** (a run or a calibration). A second start
  while one is going is a 409 `run_in_progress`.

### Errors

```ts
interface ApiErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown }
}
```

`message` is written for a person and is safe to show. `code` is stable and is
what a front end should switch on. `details` is present for `plan_invalid`
(`{ errors: string[] }`) and `run_in_progress` (`{ activeJob }`).

| Status | `code` | Meaning |
|---|---|---|
| 400 | `bad_request` | Malformed JSON, an unknown or invalid field, a bad id, a bad query value |
| 401 | `unauthorized` | No valid token |
| 403 | `forbidden_host` | `Host` is not this server |
| 403 | `forbidden_origin` | A cross-origin request |
| 403 | `not_labelled` | Reveal before the item has a label |
| 404 | `not_found` | No such endpoint, suite or run |
| 404 | `item_not_found` | No unlabelled queue item with that id |
| 404 | `not_revealable` | The label is not for a queue item, or its run is gone |
| 405 | `method_not_allowed` | Wrong method for the endpoint |
| 409 | `run_in_progress` | A run or calibration is already going |
| 409 | `no_active_run` | Cancel with nothing running |
| 409 | `config_missing` | No config file was found or given |
| 409 | `contamination` | The judge's few-shot examples include dev or test labels |
| 409 | `duplicate_label` | The item already has a label |
| 412 | `preview_token_invalid` | See the confirmation protocol |
| 413 | `payload_too_large` | Body over 1 MiB |
| 415 | `unsupported_media_type` | A `POST` body that is not `application/json` |
| 422 | `config_invalid` | The config does not validate |
| 422 | `plan_invalid` | Scenarios or selection cannot run. `details.errors` lists them |
| 422 | `item_not_in_queue` | The item exists but is not up for review |
| 422 | `corrupt_record` | A saved file could not be read |
| 428 | `confirmation_required` | See the confirmation protocol |
| 500 | `store_unwritable` | `.evals/` could not be written |
| 500 | `internal` | A bug. The message says what |
| 503 | `provider_unavailable` | The model provider could not be created (a missing key, say) |

## Endpoints

All paths are under `/api`. Every request needs the token and a valid `Host`.
Type names refer to the appendix.

### Health and overview

**`GET /api/health`** returns `HealthResponse`: version, the workdir, the data
directory, the config file, scenarios path and label file in use (each may be
`null` except the label file), whether `dist/ui` is built, and the active job.
Poll it once at start to decide what the page can offer (no config means no
runs).

**`GET /api/overview?limit=100`** returns `OverviewResponse`, aggregated over the
newest `limit` suites (1 to 1000). It carries pass, fail and error counts, the
goal-achieved rate, cost totals (null-safe, with `runsWithUnknownCost`), a `trend`
with one point per suite (oldest first, for drawing left to right), failure
counts by scenario tag, the most common failing criteria, the most common failing
deterministic checks, and warnings (corrupt files that were skipped).

### Suites and runs

**`GET /api/suites?limit=200`** returns `SuitesResponse`: `SuiteListItem[]`
(newest first, no results) and warnings for files that were skipped. `state` is
the stored status, or `interrupted`.

**`GET /api/suites/:id`** returns `SuiteResponse`: the list item plus every
`RunResult` with its trace. 404 `not_found` when absent, 422 `corrupt_record`
when the file is unreadable, 400 for an unsafe id.

**`GET /api/runs?suite=&scenario=&tag=&status=&limit=200&offset=0`** returns
`RunsResponse`: compact `RunListItem[]` across the newest 200 suites, newest
first, with `total` before paging. `status` is `pass`, `fail` or `error`.

**`GET /api/runs/:runId`** returns `RunResponse`: `{ suiteId, result }` where
`result` is a full `RunResult` (trace with turns, tool calls and raw responses,
every grader result with criteria and critiques, cost, models, warnings).

### Scenarios and rubrics (read-only)

**`GET /api/scenarios`** returns `ScenariosResponse` for the configured path: the
parsed scenarios, the upper bound on model calls for each, and a
`ValidationReport` with the same checks as `evals validate` (parse errors,
duplicate ids, unknown targets, unimplemented target kinds, tool-call mappings,
the environment variables the targets refer to **by name and whether each is
set**, never values). Files that do not parse are reported and the rest are
still listed.

**`GET /api/rubrics`** returns `RubricsResponse`: each rubric with its criteria,
anchors and the scenarios that use it, plus problems.

### Running scenarios

**`POST /api/run/preview`** takes `RunRequest` and returns `RunPreviewResponse`.

```ts
interface RunRequest { path?: string; only?: string[]; tags?: string[]; maxCostUsd?: number }
```

- `path` is a scenario file or directory. Default: the server's configured path.
  It must be inside the workdir, the config's directory or the configured path.
- `only` is scenario ids, `tags` selects scenarios with any of those tags, and
  the two intersect, exactly as `--only` and `--tag` do. `maxCostUsd` overrides
  `budget.maxCostUsd`, as `--max-cost` does.
- `preview` is `PreviewData`: scenario counts, call counts (upper bounds), the
  models with their efforts and whether each is priced, the cap and worst-case
  total, `warnings` (no cap, no price, and so on), `notes` and `anyModelCalls`.
  `lines` is the CLI's text for the same preview.
- `warnings` on the response adds config warnings (an unset environment variable).
- Errors: 409 `config_missing`, 422 `config_invalid`, 422 `plan_invalid`, 400.

**`POST /api/run/start`** takes `RunStartRequest` (`RunRequest` plus
`previewToken` and `confirm`) and returns 202 `RunStartResponse`
(`{ suiteId, startedAt, preview }`). The run then proceeds in the background and
is reported on the event stream. Errors: everything above, plus 409
`run_in_progress`, 428 `confirmation_required`, 412 `preview_token_invalid`,
503 `provider_unavailable`, 500 `store_unwritable`. The run goes through
`executeRun`, the function `evals run` uses, so graders, simulators, the cost cap
and short-circuiting are identical.

**`GET /api/run/status`** returns `{ activeJob }` (`ActiveJob | null`). Use it to
restore the UI after a reload.

**`POST /api/run/cancel`** (no body) returns 202 `{ suiteId, cancelling: true }`.
It aborts the run through the `AbortSignal` the runner honors: the scenario in
flight ends as an `error` result (`The run was cancelled.`), no further scenario
starts, and the suite is saved with `status: 'cancelled'`. 409 `no_active_run`
if nothing is running (or only a calibration, which cannot be cancelled).

**`GET /api/run/events`** is a server-sent-events stream (`text/event-stream`).
Use `EventSource` (it sends the cookie). See the next section.

### Labelling

**`GET /api/queue?limit=25`** returns `QueueResponse` (`limit` 1 to 200). See
[Blind labelling](#blind-labelling-and-the-random-quota).

**`POST /api/labels`** takes `LabelRequest` and returns 201 `LabelResponse`:

```ts
interface LabelRequest { itemId: string; labeler: string; verdict: 'pass' | 'fail'; critique: string }
```

The server takes the input, output, group and criterion from the queue item
itself, decides `sampled_by`, stamps `at`, validates the whole label with the
same `LabelSchema` `evals calibrate` uses, and appends one line. Errors: 400
(a missing or blank critique or labeler, a bad verdict, any unknown field
including `split` and `sampled_by`), 404 `item_not_found`, 409
`duplicate_label`, 422 `item_not_in_queue`, 422 `corrupt_record` (the file is
already broken, so nothing is appended).

**`GET /api/labels`** returns `LabelsResponse`: the file, every label, and
`LabelStats` (counts, random share, verdict counts, split counts, labelers, and
the same sanity warnings `evals validate` gives).

**`GET /api/labels/:id/reveal`** returns `RevealResponse` for a label, with `:id`
URL-encoded (item ids contain a colon). It returns the judge's verdict, critique
and criticality for that item, the human label, and whether they agree. 403
`not_labelled` if the id has no label (this is also the answer for ids that do
not exist, so the answer does not depend on whether a run does), 404
`not_revealable` if the label is not for a queue item or its run is gone.

### Calibration

**`POST /api/calibrate/preview`** takes `CalibrateRequest` and returns
`CalibratePreviewResponse`.

```ts
interface CalibrateRequest { rubricId: string; split: 'dev' | 'test'; selection?: 'random' | 'all' }
```

`rubricId` comes from `GET /api/rubrics`. The train split is not accepted (400).
The labels are the server's label file. `contamination` is non-null when the
judge's few-shot examples include dev or test labels, and start will refuse.
`preview.judgements.count` is exact.

**`POST /api/calibrate/start`** takes `CalibrateStartRequest` and returns 200
`CalibrateStartResponse` (`{ record }`, a `CalibrationRecord` holding the
`CalibrationReport`) when the measurement finishes. It is a single long request.
It follows the same confirmation protocol, refuses a contaminated judge with 409
`contamination` before any spend, and needs no provider when there are no labels
to judge. It holds the one-job lock while it runs. Low rates are a result, not an
error.

**`GET /api/calibration`** returns `CalibrationResponse`: `{ latest }`, the most
recent saved calibration or `null`.

## The run event stream

`GET /api/run/events` stays open. Each event is one SSE frame:

```
event: run:end
id: 14
data: {"seq":14,"at":"2026-11-13T09:15:02.113Z","suiteId":"...","type":"run:end", ...}
```

- `event:` is the `type`, `id:` is `seq`, and `data:` is JSON (`RunStreamEvent`).
  `seq` rises across suites and is unique per server run.
- The first frame is `hello` (`StreamHello`, no `id`): the active job, so a page
  knows at once whether something is running.
- Then come the buffered events of the current (or most recent) suite, so a page
  opened mid-run, or after one, sees what happened. A reconnecting `EventSource`
  sends `Last-Event-ID` and gets only what is newer. The buffer holds the last
  5000 events and starts afresh with each suite.
- Then live events. A `: keepalive` comment is sent every 15 seconds.

A suite produces, in order: `suite:start`, then for each scenario `run:start`,
any number of `turn` and `grader:done`, and `run:end`; then `suite:end`. An
`error` event reports a failure of the run machinery itself (followed by
`suite:end` with `state: 'failed'`). A scenario that fails is not an `error`
event: it is a `run:end` with `status: 'fail'` or `'error'`.

| Event | Payload (besides `seq`, `at`, `suiteId`) |
|---|---|
| `suite:start` | `startedAt`, `scenarioIds`, `preview` |
| `run:start` | `runId`, `scenarioId` |
| `turn` | `runId`, `turn` (the turn **without** `raw`, to keep the stream light) |
| `grader:done` | `runId`, `result` (a full `GraderResult`, with critiques) |
| `run:end` | `runId`, `summary` (`RunEndSummary`). Fetch `/api/runs/:runId` for the trace |
| `suite:end` | `state` (`complete`, `cancelled` or `failed`), `summary`, `warnings` (problems saving) |
| `error` | `code` (`run_failed`, or an error code from the table above), `message` |

When `run:end` arrives the run is already on disk: the file is written before the
event is sent.

## Blind labelling and the random quota

### Why blind

A person who sees the judge's verdict before deciding anchors on it, and labels
that echo the judge cannot measure the judge. So **a queue item never contains the
judge's verdict or critique**. Items are built field by field, never by spreading
the stored result, so a new judge field cannot leak into one by accident. The
judge's answer is available only from the reveal endpoint, and only for an item
that already has a human label.

What an item does contain: the criterion (id, the rubric's text, whether it is
critical), the `input` (the user message that came before, or a transcript of
everything before when the conversation had several turns), the `output`, the
whole preceding conversation in `context` (turns without raw responses, with tool
calls), and a `reason`.

**One caveat.** `reason` is `random`, `targeted-failure` or `targeted-error`, and a
`targeted-*` reason hints that the judge failed the run. The API includes it (the
server needs it to explain the queue, and a tool may want it), but **the page must
not show it before the item is labelled**. The queue is also shuffled by a hash
independent of the reason, so position says nothing. See the open questions.

### The unit of labelling

One item per run and rubric criterion, from every saved run that has a response to
label. `itemId` is `<runId>:<criterionId>`, and it is also the `id` of the label
made from it, so "already labelled" is a lookup. The `output` is the final
assistant reply in the run, and everything before it is the input. `group` is the
run id, so every criterion of one conversation lands in the same train, dev or
test split.

A run whose judge never decided some criterion (an `error` run) contributes those
criteria with `reason: 'targeted-error'`, taking the criterion list from the
scenario's rubric as it is now.

### How the queue is chosen

Let `L` be the number of labels, `R` how many of them are random, and `M` the
number of unlabelled items. The queue is computed as a pure function of the saved
runs and the label file:

1. **Targeted:** an item the judge failed (`targeted-failure`), or that an error
   left undecided (`targeted-error`).
2. **Random:** a seeded sample drawn from **all** `M` items, passes and failures
   alike. A random label that could only ever be a judge pass could not estimate
   the true negative rate, which is the number that matters. The sample size is
   `r = clamp(ceil(0.3 x (L + M)) - R, 0, M)`: enough that, once everything up for
   review is labelled, at least 30 percent of all labels are random. Items are
   ranked by `sha256(seed | "sample" | itemId)` and the first `r` are the sample.
   An item that is both sampled and a judge failure is `random`.
3. **Up for review** is the sampled items plus the remaining targeted items. A
   judge pass that was not sampled is not offered.
4. **Order** is by `sha256(seed | "order" | itemId)`, independent of the sampling
   hash and of the reason.
5. **A page** is the first `limit` of that order, with a guarantee: if the page has
   fewer than `ceil(0.3 x limit)` random items (capped by how many exist), the last
   targeted items are swapped for the next random ones.

Consequences, all tested:

- The queue is identical on every reload with the same data, whatever order the
  suites are read in.
- Labelling an item removes it and leaves the rest in the same relative order,
  because an item's rank does not depend on the others.
- A labeller who has so far reviewed only targeted items is caught up: `r` grows
  until the share is met.
- `quotaMet` in the response is whether the labels so far meet the share.

### `sampled_by`

Every label records `random` or `targeted`. **The server decides**, from the plan
as it stands when the label is posted. A client cannot claim an item was random
(the field is not accepted), and cannot label an item that is not up for review
(422 `item_not_in_queue`), so it cannot choose which passes to review.

Calibration then uses the labels as 0002 describes: accuracy metrics from `random`
labels only by default.

## What the front end needs to do

These follow from the above. They are the parts that are easy to get wrong.

1. **Open the printed URL.** Do not build your own login. The cookie does the rest.
   Use relative URLs (`fetch('/api/...')`, `new EventSource('/api/run/events')`),
   so Host and Origin are always right. Do not store the token anywhere.
2. **Cost flow:** preview, show `lines` or `preview` (with every warning), require
   an explicit click, then start with the `previewToken` and `confirm: true`. If
   start answers 412, preview again and show the user what changed. Never reuse a
   token for a different plan. A plan with `anyModelCalls: false` can start
   directly.
3. **One job at a time.** Disable the start buttons while `activeJob` is set (from
   `hello`, `/api/run/status` or `/api/health`), and handle 409 anyway.
4. **Progress:** one `EventSource` for the page. `turn` and `grader:done` give a
   live transcript. On `run:end`, fetch the run if it is open. On `suite:end`,
   refresh lists.
5. **Labelling:** show `criterion.text`, `input`, `output`, and `context` on demand.
   Do not show `reason`. Require a critique before enabling the submit button.
   Show reveal only after a label is saved.
6. **Costs and rates can be `null`.** Show "unknown", never `0`.
7. **Do not render stored text as HTML.** Transcripts come from the agent under
   test and a simulated user.
8. **Build output goes in `dist/ui`**, with `index.html` at its root. The compiled
   `src/ui/api-types.ts` also lands there (`api-types.js`, `.d.ts`), and the server
   will not serve those or any `.map` file. Configure the bundler not to empty the
   directory (`emptyOutDir: false` in Vite), or the types are lost from `dist`.
   Until `dist/ui/index.html` exists the server shows a "not built yet" page, and
   `uiBuilt` in `/api/health` is `false`.
9. Unknown paths without a file extension return `index.html`, so client-side
   routes survive a reload. Paths with an extension that do not exist are 404.

## Command line

```
evals ui [path] [--port n] [--config file] [--labels file] [--no-open]
evals run ... [--no-save]
```

- `path` is the scenarios file or directory (default `./scenarios` if present). It
  is optional: the page can show saved runs with no scenarios and no config.
- `--port` defaults to 4747. `0` picks a free port. A taken port exits 2 and says
  how to choose another.
- `--config` defaults to `evals.config.yaml` in the working directory if present.
  Naming a file that is not there exits 2.
- `--labels` defaults to `.evals/labels.jsonl`.
- `--no-open` skips opening a browser. Ctrl+C stops the server, aborting a run in
  progress (it is saved as cancelled).
- The model key is read from the server process's environment, by the same
  provider `evals run` uses.

## Testing

`tests/ui/` runs the real server on port 0 over HTTP, with the fake model provider
and the stub agent, never a real model. It covers the token, Host and Origin
checks, path traversal, the preview-token refusals (including a tampered plan, an
edited config and a changed label set), a streamed deterministic run and its saved
suite, one run at a time, cancel, the blind queue, the quota and its stability,
label validation, calibration through the API, corrupt files, and that no response
contains a secret value from the environment.

## Open questions

1. **`reason` in queue items.** It hints that the judge failed the run. Hiding it
   would mean returning it only after labelling (it is already in the label's
   `sampled_by`, coarsely). The contract includes it, because the server and any
   other tool benefit, and relies on the page not showing it. If the page cannot
   be trusted with that, drop the field from `QueueItem` and add it to `Reveal`.
2. **Granularity of an item.** A rubric judge sees the whole conversation and
   decides each criterion once. A label here has one `output`, the final reply, with
   the rest as `input`. Criteria that are about an earlier reply (such as
   "confirms before acting") lose some precision. The alternative is to label whole
   transcripts, which would change the label format 0002 defined.
3. **Calibration is one long request.** A large label set holds the request open for
   minutes. If that matters, make it a job with the same event stream as runs.
4. **Overview scale.** It reads the newest 100 suites in full on each call (headers
   are cached). A larger store wants a persisted digest per suite.
5. **A label's criterion text.** It is read from the scenario's rubric as it is now,
   so editing a rubric changes what a labeller is shown for old runs. Pinning the
   rubric version in the suite record would fix that.
6. **Stored traces are not scrubbed**, only responses. Scrubbing at save time would
   also protect the file, at the cost of altering recorded transcripts.

## Appendix: the wire types

This is `src/ui/api-types.ts`, verbatim.

<!-- api-types:start -->
```ts
// The wire types of the local web UI's JSON API. This file is the contract:
// the server (src/server) builds exactly these shapes, and the front end
// imports its types from here. It contains types only, so importing it adds
// nothing to a bundle. docs/design/0003-ui-and-api.md describes every endpoint.
//
// Conventions
//  - Every success body is a JSON object. Every failure body is ApiErrorBody.
//  - Timestamps are ISO 8601 strings. Costs are US dollars, or null when a
//    model had no price in the config (never 0 as a stand-in for "unknown").
//  - Paths are absolute, as the server sees them.

import type { CalibrationReport } from '../calibration/evaluate.js'
import type { Label, Split } from '../calibration/labels.js'
import type { EnvRef, ModelNeeds, PreviewData } from '../engine/plan.js'
import type { GraderResult, RunResult, RunStatus } from '../core/interfaces.js'
import type { Rubric, Scenario } from '../core/scenario.js'
import type { Turn } from '../core/trace.js'
import type { CalibrationRecord } from '../store/calibration.js'
import type {
  LabelStats, QueueItem, QueueStats, QueueReason, Reveal, QueueTurn, QueueToolCall,
} from '../store/labels.js'
import type { SuiteRecord, SuiteStatus, SuiteSummary } from '../store/suites.js'

export type {
  CalibrationReport, CalibrationRecord, EnvRef, GraderResult, Label, LabelStats, ModelNeeds, PreviewData, QueueItem, QueueReason,
  QueueStats, QueueToolCall, QueueTurn, Reveal, Rubric, RunResult, RunStatus, Scenario, Split, SuiteRecord, SuiteStatus, SuiteSummary, Turn,
}

// ------------------------------------------------------------------- errors

export type ErrorCode =
  | 'unauthorized' //            401: no valid token (header or cookie)
  | 'forbidden_host' //          403: Host header is not 127.0.0.1 or localhost on this port
  | 'forbidden_origin' //        403: cross-origin request
  | 'bad_request' //             400: malformed JSON, unknown field, invalid value, invalid id
  | 'unsupported_media_type' //  415: a POST body must be application/json
  | 'payload_too_large' //       413: body over the cap
  | 'not_found' //               404
  | 'method_not_allowed' //      405
  | 'run_in_progress' //         409: a run or calibration is already running
  | 'no_active_run' //           409: cancel with nothing running
  | 'confirmation_required' //   428: a plan that can call a model needs previewToken and confirm: true
  | 'preview_token_invalid' //   412: the token does not match a fresh preview of this exact plan, or expired
  | 'config_missing' //          409: no config file was found or given
  | 'config_invalid' //          422: the config does not validate
  | 'plan_invalid' //            422: scenarios or selection cannot run. details.errors lists them
  | 'provider_unavailable' //    503: the model provider could not be created (key missing, say)
  | 'contamination' //           409: the judge's few-shot examples include dev or test labels
  | 'duplicate_label' //         409
  | 'item_not_found' //          404: no such queue item
  | 'item_not_in_queue' //       422: the item exists but is not up for review (an unsampled pass)
  | 'not_labelled' //            403: reveal before the item has a human label
  | 'not_revealable' //          404: the label is not for a queue item, or its run is gone
  | 'corrupt_record' //          422: a saved file could not be read
  | 'store_unwritable' //        500: the .evals directory could not be written
  | 'internal' //               500

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown }
}

// ------------------------------------------------------------------- health

export interface ActiveJob {
  kind: 'run' | 'calibrate'
  startedAt: string
  /** Set for a run. */
  suiteId?: string
  /** Set for a run: scenario ids in order, and how many have finished. */
  scenarioIds?: string[]
  finished?: number
  /** True once cancel was requested and the run has not finished yet. */
  cancelling: boolean
}

export interface HealthResponse {
  ok: true
  version: string
  workdir: string
  /** `<workdir>/.evals` */
  dataDir: string
  /** Null when no config file was found or given. Runs and scenario checks need one. */
  configFile: string | null
  /** Null when there is no scenarios path (no argument and no ./scenarios). */
  scenarioPath: string | null
  labelsFile: string
  /** False until `dist/ui/index.html` exists. */
  uiBuilt: boolean
  activeJob: ActiveJob | null
}

// ----------------------------------------------------------------- overview

export interface TrendPoint {
  suiteId: string
  startedAt: string
  status: SuiteStatus
  runs: number
  pass: number
  fail: number
  error: number
  /** pass / runs, null with no runs. */
  passRate: number | null
  /** achieved / total over runs with a goal result, null when none had one. */
  goalRate: number | null
  avgScore: number | null
  costUsd: number | null
}

export interface TagFailures {
  tag: string
  runs: number
  pass: number
  fail: number
  error: number
}

export interface FailingCriterion {
  criterion: string
  failures: number
  /** Times the judge decided this criterion in the suites considered. */
  judged: number
  failureRate: number
  /** Scenarios whose runs failed it. */
  scenarios: string[]
  critical: boolean
}

export interface FailingCheck {
  grader: string
  failures: number
  scenarios: string[]
}

export interface OverviewResponse {
  /** How many of the newest suites were aggregated, out of how many exist. */
  suites: { considered: number; total: number }
  runs: number
  counts: { pass: number; fail: number; error: number }
  goal: { achieved: number; total: number; rate: number | null }
  cost: {
    /** Null when any run's cost is unknown, so a partial sum is never shown as a total. */
    totalUsd: number | null
    /** Sum over runs whose cost is known. */
    knownUsd: number
    runsWithUnknownCost: number
    inputTokens: number
    outputTokens: number
  }
  /** Oldest first, so it can be drawn left to right. */
  trend: TrendPoint[]
  failuresByTag: TagFailures[]
  topFailingCriteria: FailingCriterion[]
  topFailingChecks: FailingCheck[]
  /** Corrupt files that were skipped, and the like. */
  warnings: string[]
}

// ------------------------------------------------------------ suites, runs

export type SuiteState = SuiteStatus | 'interrupted'

export interface SuiteListItem {
  suiteId: string
  startedAt: string
  endedAt: string | null
  /**
   * The stored status, except that a suite still marked `running` that is not
   * the one running now is reported as `interrupted` (the process died).
   */
  state: SuiteState
  command: string
  configFile: string
  scenarioPath: string
  summary: SuiteSummary
}

export interface SuitesResponse {
  suites: SuiteListItem[]
  warnings: string[]
}

export interface SuiteResponse extends SuiteListItem {
  results: RunResult[]
}

/** One run in a list: everything a table needs, none of the trace. */
export interface RunListItem {
  runId: string
  suiteId: string
  scenarioId: string
  scenarioVersion: string
  status: RunStatus
  score: number | null
  goalAchieved: boolean | null
  costUsd: number | null
  durationMs: number
  startedAt: string
  turns: number
  tags: string[]
  models: { simulator?: string; judge?: string }
  /** Ids of criteria the judge failed. */
  failedCriteria: string[]
  /** Names of deterministic checks that failed. */
  failedChecks: string[]
  error?: string
  warnings: number
}

export interface RunsResponse {
  runs: RunListItem[]
  /** Matches before `limit` and `offset`. */
  total: number
  warnings: string[]
}

export interface RunResponse {
  suiteId: string
  result: RunResult
}

// --------------------------------------------------- scenarios and rubrics

export interface ScenarioItem {
  scenario: Scenario
  /** Absolute path of the scenario file. */
  file: string
  rubricId: string | null
  /** Upper bound on the model calls one run of it can make. */
  needs: ModelNeeds
  needsModel: boolean
}

export interface ValidationReport {
  /** Same as `evals validate`: anything here would stop a run. */
  errors: string[]
  warnings: string[]
  /** Environment variables the targets refer to, by name only. Values are never sent. */
  envRefs: EnvRef[]
}

export interface ScenariosResponse {
  path: string | null
  configFile: string | null
  scenarios: ScenarioItem[]
  validation: ValidationReport
}

export interface RubricItem {
  rubric: Rubric
  file: string
  /** Ids of scenarios that use it. */
  usedBy: string[]
}

export interface RubricsResponse {
  path: string | null
  rubrics: RubricItem[]
  problems: string[]
}

// -------------------------------------------------------- running scenarios

/** The body of POST /api/run/preview. POST /api/run/start takes it plus RunStartFields. */
export interface RunRequest {
  /** A scenario file or directory. Default: the server's configured path. Must be inside the working directory, the config's directory or the configured path. */
  path?: string
  /** Scenario ids. */
  only?: string[]
  /** Run scenarios with any of these tags. */
  tags?: string[]
  /** Per-scenario cap in US dollars. Overrides budget.maxCostUsd in the config. */
  maxCostUsd?: number
}

export interface RunStartFields {
  /** From the preview of this exact plan. Required whenever the plan can call a model. */
  previewToken?: string
  /** Must be true whenever the plan can call a model. */
  confirm?: boolean
}
export type RunStartRequest = RunRequest & RunStartFields

export interface RunPreviewResponse {
  /** The same numbers the CLI prints. */
  preview: PreviewData
  /** The CLI's text, line by line. */
  lines: string[]
  /** Config problems that are warnings, such as an unset environment variable. */
  warnings: string[]
  /** HMAC of the exact plan. Send it back with `confirm: true` to start. Valid for `expiresAt`. */
  previewToken: string
  expiresAt: string
  /** The plan the token covers: scenario ids in run order, and the cap. */
  plan: { path: string; scenarioIds: string[]; capUsd: number | null }
}

export interface RunStartResponse {
  suiteId: string
  startedAt: string
  /** Progress arrives on GET /api/run/events. */
  preview: PreviewData
}

export interface RunCancelResponse {
  suiteId: string
  cancelling: true
}

export interface RunStatusResponse {
  activeJob: ActiveJob | null
}

// -------------------------------------------------- server-sent run events

/** Every event is JSON in the `data:` field, with `event:` set to `type` and `id:` set to `seq`. */
export interface StreamBase {
  seq: number
  at: string
  suiteId: string
}

export type TurnEvent = Omit<Turn, 'raw'>

/** What `run:end` carries. Fetch GET /api/runs/:runId for the full trace. */
export type RunEndSummary = Omit<RunListItem, 'suiteId' | 'startedAt' | 'turns' | 'tags' | 'models' | 'failedChecks'> & {
  turns: number
}

export type RunStreamEvent =
  | (StreamBase & { type: 'suite:start'; startedAt: string; scenarioIds: string[]; preview: PreviewData })
  | (StreamBase & { type: 'run:start'; runId: string; scenarioId: string })
  | (StreamBase & { type: 'turn'; runId: string; turn: TurnEvent })
  | (StreamBase & { type: 'grader:done'; runId: string; result: GraderResult })
  | (StreamBase & { type: 'run:end'; runId: string; summary: RunEndSummary })
  | (StreamBase & { type: 'suite:end'; state: 'complete' | 'cancelled' | 'failed'; summary: SuiteSummary; warnings: string[] })
  | (StreamBase & { type: 'error'; code: ErrorCode | 'run_failed'; message: string })

/**
 * Sent once when a stream opens, without an `id:`. It is the only event that
 * does not carry `seq`, `at` or `suiteId`. After it come the buffered events of
 * the current (or most recent) suite, then live ones.
 */
export interface StreamHello {
  type: 'hello'
  activeJob: ActiveJob | null
}

// ----------------------------------------------------------------- labelling

export interface QueueResponse {
  items: QueueItem[]
  stats: QueueStats
  /** Why the queue is empty or short, in words, when there is a reason. */
  notes: string[]
}

export interface LabelRequest {
  /** From a queue item. The server takes the input, output, group and criterion from the item itself. */
  itemId: string
  labeler: string
  verdict: 'pass' | 'fail'
  /** Required, on every label. */
  critique: string
}

export interface LabelResponse {
  label: Label
}

export interface LabelsResponse {
  file: string
  labels: Label[]
  stats: LabelStats
}

export type RevealResponse = Reveal

// --------------------------------------------------------------- calibration

export interface CalibrateRequest {
  /** A rubric id from GET /api/rubrics. */
  rubricId: string
  split: 'dev' | 'test'
  /** Default `random`. */
  selection?: 'random' | 'all'
}
export type CalibrateStartRequest = CalibrateRequest & RunStartFields

export interface CalibratePreviewResponse {
  preview: PreviewData
  lines: string[]
  warnings: string[]
  /** Set when the judge's few-shot examples include dev or test labels. Start will refuse. */
  contamination: string | null
  labelsFile: string
  previewToken: string
  expiresAt: string
}

export interface CalibrateStartResponse {
  record: CalibrationRecord
}

export interface CalibrationResponse {
  /** The most recent saved calibration, or null when there is none. */
  latest: CalibrationRecord | null
}
```
<!-- api-types:end -->
