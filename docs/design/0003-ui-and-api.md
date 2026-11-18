# 0003: The local web UI and its API

| | |
|---|---|
| Status | Phase 1 (backend) and Phase 2 (front end, `ui/`) implemented |
| Date | 2026-11-13 |
| Code | `src/engine/`, `src/store/`, `src/server/`, `src/ui/api-types.ts`, `src/cli/ui.ts`, `ui/` (front end), `scripts/seed-demo.ts` (demo data) |
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
- Editing scenarios or the config from the page. They are files in a
  repository, reviewed like code. The API reads them and reports problems.
  Rubrics are the one exception, and an edit from the page still writes the
  rubric's file (see [Editing a rubric](#editing-a-rubric)).
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
  findings/<summaryId>.json      one AI draft of suggested fixes per "Suggest fixes" on the Findings page
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

**Findings summary record** (`FindingsSummaryRecord`): `{ schemaVersion: 1,
summaryId, at, filters, fingerprint, findings, itemIds, model, usage, fixes,
warnings }`. `fingerprint` is a hash of the findings the draft was written from,
so the page can tell when the findings have changed since. The id is a
timestamp like a suite id.

**Labels** are the format in 0002, one JSON object per line, append-only. A
changed label is a new line with `replaces` set to the id of the line it
supersedes and an id of `<itemId>~r<n>`. Nothing already in the file is
rewritten, so the first, blind label is always kept. Readers follow the chains
and use the latest version of each item (see "Changing a label after seeing the
judge" in 0002).

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
| A web page in your browser calls the API (CSRF) | Token required, `SameSite=Strict` cookie, `Origin` checked, `Sec-Fetch-Site` checked, `POST` and `PUT` bodies must be `application/json` (which forces a preflight cross-origin), and no CORS headers are ever sent |
| DNS rebinding (a hostile site re-points its name at 127.0.0.1 and reads the API) | The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`, on every request, or the answer is 403 |
| A secret value leaks in a response | Nothing in the API is built from the environment, and every outgoing body (JSON and event stream) is scrubbed of the values of secret-looking environment variables and of any variable the config refers to with `${env:NAME}` |
| A client supplies a model key | The API does not accept one. Bodies are strict: an unknown field (`apiKey`, `env`, `headers`) is a 400. The key is read from the server process's environment by the model provider |
| Spending without looking | The confirmation protocol below |
| Oversized or malformed requests | Bodies over 1 MiB are refused with 413 and the connection is dropped. Malformed JSON is a 400 |
| Path traversal | Static files: the URL path is decoded once, any `..`, `.`, dotfile segment, NUL or backslash is refused, and the real path (symlinks followed) must stay inside `dist/ui`. API ids: a strict alphabet, and a `path` in a request body must resolve inside the workdir, the config's directory or the configured scenarios path |
| Writing files it should not | The only file the API writes outside `.evals/` is a rubric being edited or given a worked example, and only the file the server loaded that rubric from. The body has no path, and the file's real path must be inside the workdir, the config's directory or the scenarios path |
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

Anything that could call a model (a run with a persona, a rubric or a goal, a
calibration with labels to judge, or a findings summary) must pass through two
calls:

1. **Preview.** `POST /api/run/preview` (or `/api/calibrate/preview`) returns the
   same cost preview the CLI prints, as data, and a `previewToken`. The token is
   an HMAC-SHA256, under a key that exists only in this server process, of a
   canonical form of the exact plan: the scenarios selected (id, version and a
   hash of each scenario and rubric, in run order), the cost cap, both models
   with their efforts and prices, the timeouts, and a hash of each target's
   config. For a calibration: the rubric, the split, the selection, a hash of
   the label set, what each item will be judged on (a hash of its saved run, or
   its label text; see [Calibration](#calibration)), the timezone, and the judge
   model. For a findings summary
   (`/api/findings/summary/preview`): a hash of the findings (which includes the
   filters), the judge model with its price and timeout, and the output cap. It
   also covers an expiry, 15 minutes out.
2. **Start.** `POST /api/run/start` (or `/api/calibrate/start`) takes the same
   body plus `previewToken` and `confirm: true`. The server rebuilds the plan from
   the files as they are **now**, recomputes the HMAC and compares. A plan that
   changed (a different selection, a higher cap, an edited scenario, a new price,
   new labels, a saved run that a label is judged on disappearing), an expired
   token and a token from another server all fail.

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
- Paths are absolute, as the server sees them. `RubricItem.relativeFile` is the
  one display path, relative to the workdir.
- Responses are never cached.
- The server runs **one job at a time** (a run or a calibration). A second start
  while one is going is a 409 `run_in_progress`. A findings summary is one short
  model call with its own lock: a second one while it is being written is also a
  409 `run_in_progress`. It does not wait for a run.

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
| 404 | `not_found` | No such endpoint, suite, run or rubric |
| 404 | `not_labelled` | Revise an item, or make a worked example from an item, that has no label yet |
| 404 | `item_not_found` | No unlabelled queue item with that id |
| 404 | `not_revealable` | The label is not for a queue item, or its run is gone |
| 405 | `method_not_allowed` | Wrong method for the endpoint |
| 409 | `run_in_progress` | A run or calibration is already going, or a findings summary is being written |
| 409 | `no_active_run` | Cancel with nothing running |
| 409 | `config_missing` | No config file was found or given |
| 409 | `contamination` | The judge's few-shot examples include dev or test labels, or a new worked example has the same input and output as a dev or test label |
| 409 | `duplicate_example` | The rubric already has a worked example with this input and output (or one made from this label) |
| 409 | `duplicate_label` | The item already has a label |
| 409 | `stale` | A rubric edit whose `baseHash` is not the file's current hash: the file changed on disk since the page read it |
| 412 | `preview_token_invalid` | See the confirmation protocol |
| 413 | `payload_too_large` | Body over 1 MiB |
| 415 | `unsupported_media_type` | A `POST` or `PUT` body that is not `application/json` |
| 422 | `config_invalid` | The config does not validate |
| 422 | `plan_invalid` | Scenarios or selection cannot run. `details.errors` lists them |
| 422 | `item_not_in_queue` | The item exists but is not up for review |
| 422 | `not_train` | A worked example from a dev or test label. Only train labels can become worked examples |
| 422 | `not_in_rubric` | A worked example whose label is about a criterion the rubric does not have |
| 422 | `no_findings` | A findings summary for filters with no findings |
| 422 | `no_change` | A revision with the same verdict and critique as the current label, or a rubric edit identical to the file |
| 422 | `rubric_invalid` | A rubric edit that cannot be applied: criteria added, removed, renamed or reordered, blank wording, a bad weight or example, a missing version, a file defined twice or outside the allowed directories |
| 422 | `corrupt_record` | A saved file could not be read |
| 428 | `confirmation_required` | See the confirmation protocol |
| 500 | `store_unwritable` | `.evals/`, or a rubric file being edited, could not be written |
| 500 | `internal` | A bug. The message says what |
| 502 | `provider_error` | The model call for a findings summary failed, was refused, ran out of tokens or returned the wrong structure. Nothing was saved |
| 503 | `provider_unavailable` | The model provider could not be created (a missing key, say) |

## Endpoints

All paths are under `/api`. Every request needs the token and a valid `Host`.
Type names refer to the appendix.

### Health and overview

**`GET /api/health`** returns `HealthResponse`: version, the workdir, the data
directory, the config file, scenarios path and label file in use (each may be
`null` except the label file), whether `dist/ui` is built, whether the server is
running on synthetic demo data (`demo`), and the active job. Poll it once at
start to decide what the page can offer (no config means no runs). `demo` is
`true` only when the server was started by `npm run ui:demo` (the
`demo` option of `startUiServer`), and the page then shows a "Demo data" banner.
`evals ui` never sets it.

**`GET /api/overview?limit=100`** returns `OverviewResponse`, aggregated over the
newest `limit` suites (1 to 1000). It carries pass, fail and error counts, the
goal-achieved rate, cost totals (null-safe, with `runsWithUnknownCost`), a `trend`
with one point per suite (oldest first, for drawing left to right), failure
counts by scenario tag, the most common failing criteria, the most common failing
deterministic checks, and warnings (corrupt files that were skipped).

A criterion the judge found not applicable (its situation never arose, see
[0002](0002-judge-methodology.md#not-applicable)) is left out of every rate here.
`FailingCriterion.judged` and `failureRate` count graded verdicts only, so a
criterion that was not applicable in half the runs is not diluted by them. The
count of those runs is kept apart as `notApplicable`, and `criteria` gives the
pass, fail and not-applicable counts for every criterion the judge decided. A run
where no criterion applied has a `null` score and is left out of `avgScore`.

### Suites and runs

**`GET /api/suites?limit=200`** returns `SuitesResponse`: `SuiteListItem[]`
(newest first, no results) and warnings for files that were skipped. `state` is
the stored status, or `interrupted`.

**`GET /api/suites/:id`** returns `SuiteResponse`: the list item plus every
`RunResult` with its trace. 404 `not_found` when absent, 422 `corrupt_record`
when the file is unreadable, 400 for an unsafe id.

**`GET /api/runs?suite=&scenario=&tag=&status=&limit=200&offset=0`** returns
`RunsResponse`: compact `RunListItem[]` across the newest 200 suites, newest
first, with `total` before paging. `status` is `pass`, `fail` or `error`. Each item
lists `failedCriteria` and, apart from them, `notApplicableCriteria`: criteria that
were not graded in that run. The two lists never share an id.

**`GET /api/runs/:runId`** returns `RunResponse`: `{ suiteId, result, conversationDate }` where
`result` is a full `RunResult` (trace with turns, tool calls and raw responses,
every grader result with criteria and critiques, cost, models, warnings), and
`conversationDate` is the day the conversation took place, worded as LLM graders
are told it (for example "Sunday, 15 November 2026 (America/Toronto)"), in the
config's `timezone` (the machine's when it has none or there is no usable
config). It is null when the run's start time is not a valid time.

### Scenarios and rubrics

**`GET /api/scenarios`** returns `ScenariosResponse` for the configured path: the
parsed scenarios, the upper bound on model calls for each, and a
`ValidationReport` with the same checks as `evals validate` (parse errors,
duplicate ids, unknown targets, unimplemented target kinds, tool-call mappings,
the environment variables the targets refer to **by name and whether each is
set**, never values). Files that do not parse are reported and the rest are
still listed.

**`GET /api/rubrics`** returns `RubricsResponse`: each rubric with its criteria,
anchors and the scenarios that use it, plus problems. Each `RubricItem` also has
`relativeFile` (the file relative to the workdir, for display) and `hash`, the
sha256 of the file's bytes, which an edit sends back as `baseHash`. Rubrics are
read from disk on every request, never cached, so an edit made here or in an
editor shows at once in this list, the review queue's criterion text and the
calibration screen.

**`PUT /api/rubrics/:id`** takes `RubricUpdateRequest` and returns
`RubricUpdateResponse`. It edits one rubric and writes the one file the server
loaded it from. The body names no path.

```ts
interface RubricUpdateRequest {
  baseHash: string
  criteria: { id: string; text: string; weight?: number; critical?: boolean }[]
  context: string | null
  anchors: Anchor[]
  version?: string
}
```

- 404 `not_found` when no loaded rubric has that id. A rubric file that does not
  validate is not loaded, so it cannot be edited here.
- 409 `stale` when the file's sha256 is not `baseHash`. The page reloads.
- `criteria`: the file's ids, all of them, in the file's order. Adding, removing,
  renaming or reordering is a 422 `rubric_invalid`, because labels and runs refer
  to criteria by id. Wording must not be blank and a weight must be above 0.
  Omitting `weight` or `critical` keeps the file's value.
- `anchors` replaces the list (add, edit, delete). Each is checked with the
  loader's `AnchorSchema`, and its `criterion`, when set, must exist (422
  `rubric_invalid`, naming the example).
- `context`: null or blank removes the key.
- 422 `no_change` when nothing differs from the file.
- **The version goes up on every save.** A whole-number version (`2` or `"2"`)
  goes up by one, keeping its quoting. Any other version (`v2`, `1.5`) needs
  `version` in the body, different from the current one, or the answer is 422
  `rubric_invalid` saying so. `version`, when given, is used as it is.
- The edited file is read back with the loader's own schema (the same validation
  as `evals validate`) and compared with what was asked for before anything is
  written. The write is atomic: a temporary file in the same directory, then a
  rename.
- The response has the rubric as `GET /api/rubrics` now returns it, its new
  `hash` and `version`, and `labelImpact`: for each criterion whose wording
  changed, how many current labels (the end of each revision chain, as
  calibration uses) are about it. A label file that cannot be read does not stop
  the save. The response then says so in `warnings`.

**`POST /api/rubrics/:id/anchors/from-label`** takes `AnchorFromLabelRequest` and
returns `AnchorFromLabelResponse`. It turns one train-split label into a worked
example at the end of the rubric's `anchors` (see
[Worked examples from labels](#worked-examples-from-labels)).

```ts
interface AnchorFromLabelRequest { itemId: string; baseHash: string; input?: string; output?: string; critique?: string }
```

- The example gets the label's criterion and verdict, and its input, output and
  critique unless the body replaces them (to trim a long transcript or tidy the
  critique). A blank `input` leaves the example without one. `output` and
  `critique`, when sent, must not be blank. The label is not changed.
- 404 `not_labelled` when the item has no current label.
- 422 `not_train` when the label's split is dev or test: those labels must stay
  unseen by the judge, or calibration would grade it on examples it was shown.
- 404 `not_found` for an unknown rubric, 409 `stale` when the file's hash is not
  `baseHash`, and 422 `not_in_rubric` when the label's criterion is not one of
  the rubric's.
- 409 `duplicate_example` when the rubric already has an example with the same
  content key (input and output, normalised) or one made from this label,
  trimmed. 409 `contamination` when the new example's input and output match a
  dev or test label.
- The write goes through the same code as `PUT /api/rubrics/:id`: the example is
  appended to `anchors` as a span-preserving edit (comments and everything else
  kept byte for byte), the version goes up (a version that is not a whole number
  is a 422 `rubric_invalid`), the result is read back with the loader's schema,
  and the write is atomic.
- The response has the rubric as `GET /api/rubrics` now returns it, its new
  `hash` and `version`, and the `anchor` that was added.

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

**`GET /api/queue?limit=25&criterion=<id>`** returns `QueueResponse` (`limit` 1 to
200). `criterion` is optional: with it, the items are only that criterion's,
filtered from the finished plan before the page limit is applied, so what is up
for review, each item's `reason` and the stats are the same as without it (see
[One criterion at a time](#one-criterion-at-a-time)). An unknown criterion, or
one with nothing left, gives an empty list and a note. `stats.byCriterion` lists
every criterion with items up for review and how many, by id, from the whole
plan. See [Blind labelling](#blind-labelling-and-the-random-quota).

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

**`GET /api/labels`** returns `LabelsResponse`: the file, the current label of
each item (a changed label appears once, as its latest version), `history` (for
each changed item, keyed by item id, the versions it superseded, oldest first),
`meta` (for each current label, keyed by item id: its `split`, the `rubricId`
its criterion belongs to, and `isExample`, whether that rubric already has a
worked example made from it; derived on every read, so the label format is
unchanged), and `LabelStats` (counts of items, random share, verdict counts, split counts,
labelers, `revisions` (how many items were changed), and the same sanity
warnings `evals validate` gives).

**`GET /api/labels/suggestions?criterion=<id>&verdict=pass|fail`** returns
`LabelSuggestionsResponse`: up to four earlier critiques for that criterion and
verdict, to offer as one-click phrases (see [Quick critiques](#quick-critiques)).
Optional `labeler` prefers that person's critiques, and `exclude` (an item id)
leaves out that item's own label, which the page uses when changing a label.
Errors: 400 for a missing criterion or a verdict other than `pass` or `fail`,
422 `corrupt_record` for a broken label file.

**`GET /api/labels/:id/reveal`** returns `RevealResponse` for an item, with `:id`
the item id, URL-encoded (item ids contain a colon). It returns the judge's
verdict, critique and criticality for that item, the current human label, and
whether they agree. When the label was changed, `original` is the first, blind
label, `revisions` counts the changes, and `blindAgrees` says whether the judge
agrees with the blind label (`agrees` is about the current one). A hand-made
label can name a criterion the judge found not applicable. Then `judge.verdict` is
`not_applicable`, and `agrees` and `blindAgrees` are `null`, because there is no
graded verdict to compare with. 403
`not_labelled` if the id has no label (this is also the answer for ids that do
not exist, so the answer does not depend on whether a run does), 404
`not_revealable` if the label is not for a queue item or its run is gone.

**`POST /api/labels/:id/revise`** changes the label of an item that already has
one. `:id` is the item id, URL-encoded. It takes `ReviseRequest` and returns 201
`LabelResponse` with the new line:

```ts
interface ReviseRequest { labeler: string; verdict: 'pass' | 'fail'; critique: string }
```

The body is checked like `POST /api/labels` (same limits, critique trimmed,
unknown fields refused). The server appends a new line that copies the
original's group, criterion, input, output and `sampled_by`, sets `replaces` to
the current label's id, takes the id `<itemId>~r<n>`, and stamps `at`. The
blind label and any earlier revisions stay in the file. Because the split and
`sampled_by` are copied, a revision never moves an item between splits or
changes the random quota, and the queue's counts are unchanged. Errors: 400 (as
for `POST /api/labels`), 404 `not_labelled` if the item has no label, 422
`no_change` if the verdict and the trimmed critique equal the current label's,
422 `corrupt_record` if the label file is already broken.

The reveal endpoint answers anyone once an item is labelled, so the server
cannot know whether the person looked. Every revision is therefore treated as
made after seeing the judge, and calibration reports agreement on the blind
labels next to the headline numbers.

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

The judge is shown what production grading saw (see "The same evidence for
everyone" in [0002](0002-judge-methodology.md#the-same-evidence-for-everyone)).
A label made from a saved run (its item id is `<group>:<criterion>`, the run is
in `.evals/runs`, and the run's judged reply is the label's `output`) is judged on
that whole run: every turn with tool calls and results, and the date line in the
config's timezone. Any other label is judged on its own input and output, with no
date. The preview's lines and notes say how many items take each path
("Evidence: 3 judged on the whole saved run, 1 on the label's text alone."), and
its warnings say so when any item uses the label text. The token covers each
item's path and a hash of its run, so a run that disappears or changes after the
preview makes start answer 412. The server reads each run once per request, so
the calibration measures exactly what the token covered.

**`POST /api/calibrate/start`** takes `CalibrateStartRequest` and returns 200
`CalibrateStartResponse` (`{ record }`, a `CalibrationRecord` holding the
`CalibrationReport`) when the measurement finishes. The report's `evidence` is
`{ fullRun, labelText }`: how many of the measured items the judge saw the whole
saved run for, and how many only the label's text, with a warning when the
second is above zero. Reports saved before this existed have no `evidence`. It is a single long request.
It follows the same confirmation protocol, refuses a contaminated judge with 409
`contamination` before any spend, and needs no provider when there are no labels
to judge. It holds the one-job lock while it runs. Low rates are a result, not an
error.

**`GET /api/calibration`** returns `CalibrationResponse`: `{ latest }`, the most
recent saved calibration or `null`.

### Findings

**`GET /api/findings?since=&rubric=&criterion=`** returns `FindingsResponse`, the
findings report (see [Findings](#the-findings-report)). All three filters are optional.
`since` is a date (`2026-11-01`, read as midnight UTC) or an ISO time, compared
with each run's start time; anything else is a 400. It is a pure read and calls
no model.

- `criteria`: one entry per criterion with at least one finding, critical first,
  then by the number of failures. Each has the criterion's text and critical
  flag from the rubric as it is now, the rubric id and version, `failed` (current
  fail labels in the filter), `labelled` (every current label for it in the
  filter) and `findings`, newest run first.
- A finding: `itemId`, `suiteId`, `runId`, the run's `startedAt`, `scenarioId`,
  `userMessage` (the last user message before the judged reply, or an excerpt of
  the label's input), `output` (the judged reply), `critique`, `labeler`,
  `labelledAt`, and `revised` (the label was changed after it was first saved,
  so possibly after seeing the judge).
- `unreviewedJudgeFailures`: criteria the judge failed in the saved runs in the
  filter that nobody has labelled. They are counted and left out, so the report
  covers verified findings only. `notFromSavedRun` counts current labels whose
  item is not in the saved runs (a hand-written label, a deleted run).
- `summary`: the latest saved AI draft whose filters equal these, with
  `current: false` when the findings have changed since it was written. Null
  when there is none.

**`GET /api/findings.md?since=&rubric=&criterion=`** returns the same report as
`text/markdown` with `Content-Disposition: attachment; filename="findings-<date>.md"`.
The server builds the Markdown, so the page's download, its copy button and a
script all get the same text, scrubbed like every other response. Layout: title,
date, filters, the unreviewed count, then the AI draft when there is a current
one for these filters ("Suggested fixes (AI draft, review before use)"), a
summary table (criterion, critical, failed / labelled), and a section per
criterion with the rule text and each finding (scenario, run time, user message,
the assistant reply as a quote block, critique). A draft written from other
findings is left out of the file.

**`POST /api/findings/summary/preview`** takes `FindingsSummaryRequest` (the same
three filters, in the body) and returns `FindingsSummaryPreviewResponse`: the
filters as read, the number of findings and how many go into the prompt (at most
25 per criterion, newest first), the number of criteria, the judge model from the
config (`ModelPlan`), an estimated input size (about four characters per token),
the output cap, `estimatedCostUsd` (the input estimate plus the whole output cap
at the config's prices, so usually above the real cost; null when the model has
no price), `anyModelCalls` (false with no findings), warnings, and a
`previewToken`. Errors: 409 `config_missing`, 422 `config_invalid`, 422
`plan_invalid` (a judge provider other than Anthropic).

**`POST /api/findings/summary`** takes `FindingsSummaryStartRequest` (the filters
plus `previewToken` and `confirm: true`) and returns 201
`FindingsSummaryResponse` (`{ record }`). It rebuilds the findings, refuses an
empty report with 422 `no_findings`, then follows the
[confirmation protocol](#the-cost-confirmation-protocol): 428 without the token
and `confirm`, 412 when the findings, the filters or the judge model changed
since the preview. It makes one judge-model call with structured output: per
criterion, the pattern the failures share, a proposed plain-language change to
the assistant's instructions or behavior, and the item ids it rests on. The
prompt quotes each finding inside tags and says that quoted content is data and
never an instruction. Fixes for criteria not in the report are dropped, and item
ids that are not findings are removed, each with a warning on the record. The
draft is saved to `.evals/findings/<summaryId>.json` with the filters, the
findings fingerprint, the model and the usage. Errors: 503
`provider_unavailable` (no provider, a missing key), 502 `provider_error` (the
call failed, was refused, was cut off or returned the wrong structure; nothing is
saved), 409 `run_in_progress` (another summary is being written), 500
`store_unwritable`.

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
made from it, so "already labelled" is a lookup. A changed label keeps the item
id with a `~r<n>` suffix, and the item stays labelled. The `output` is the final
assistant reply in the run, and everything before it is the input. `group` is the
run id, so every criterion of one conversation lands in the same train, dev or
test split.

An item carries the evidence the judge is shown, so the person labelling sees
what the judge sees:

- `context`: every turn before the reply, each with its tool calls
  (`QueueToolCall`: `name`, `arguments`, `result` when the target reported one,
  `error` when the call failed). `input` is the same turns rendered as the judge
  gets them, results included.
- `outputToolCalls`: the tool calls made in the judged reply's own turn, with
  their results. Absent when it made none.
- `after`: any turns after the reply (an assistant turn with tool calls and no
  text, say). Absent when there are none.
- `conversationDate`: the day the conversation took place, worded as the judge's
  date line words it, in the config's `timezone`. Null when the run's start time
  is not a valid time.

These are built field by field from the trace, like the rest of the item, so a
tool call's id, a turn's raw response and anything from the judge stay out. The
page shows the date at the top of the item and each tool call compactly under
its turn: the name, the arguments on one line, the result's `status` as a badge
(an error status, `is_error`, or a call that errored, in the error style), and
the full JSON when the call is opened. In the All labels list, a label made from
a run can load the whole conversation from `GET /api/runs/:runId` the same way.

A run whose judge never decided some criterion (an `error` run) contributes those
criteria with `reason: 'targeted-error'`, taking the criterion list from the
scenario's rubric as it is now.

**A criterion the judge found not applicable is not an item.** Its situation never
arose, so a person has nothing to pass or fail, and a label for it could not be
compared with a graded verdict. It is also never counted as undecided in an `error`
run. `QueueStats.notApplicable` says how many unlabelled criteria were left out for
this reason, so the gap between the criteria in the runs and the items in the queue
is visible. Only the count is exposed. The queue still never says which item the
judge decided what.

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
5. **A page** is the first `limit` of that order (of one criterion's items, when
   `criterion` is given), with a guarantee in mixed mode: if the page has fewer
   than `ceil(0.3 x limit)` random items (capped by how many exist), the last
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

### Jumping to an item

The review queue screen has a "Jump to an item" picker, so a person can open a
specific conversation instead of only going through the items with Skip. It is a
grouped native `<select>` (one group per scenario, with a text filter once there
are more than 12 items). The page loads the queue with `limit=200`, the most the
server returns, and the picker lists exactly those items and nothing else. When
more items are up for review than were returned (`stats.pending` is more than the
list), the page says so, and the rest load when the batch is done. Each entry
shows the criterion id (with "Critical" when it is), a short run id (the first
eight characters) and the run's start time, so several runs of one scenario can be
told apart. `QueueItem.startedAt` carries that time. It is the run's own start, so
it says nothing about the judge.

`#/classify?item=<itemId>` opens the queue with that item current. When the item is
not in the loaded list (already labelled, or not up for review) the page shows a
short banner saying so and opens the normal first item. Choosing an item moves it
to the front of the local list and keeps the others in their order. If the person
has chosen a verdict or typed a critique for the current item, the page asks before
it discards them. "Item N of M" shows where the current item sits in the picker's
order among the loaded items.

**Why this does not break blindness or the quota.** The picker's order is the
scenario id, then the criterion id, then the run time, with the run id and item id
only to break ties. It never uses `reason`, the judge's outcome or the queue's
position, so it hints at nothing. No entry text, banner or link contains a reason
or any judge field, and a test asserts that every assignment of reasons gives the
same picker. The server's rules do not change: a label for an item that is not in
the queue is still refused (422 `item_not_in_queue`), the picker cannot offer one,
and a deep link to one just falls back to the first item. `sampled_by` is decided
from the whole plan (`findQueueItem` runs the plan with no page limit), so how many
items the page loaded, and which one the person chose first, does not change it.

### One criterion at a time

Labelling is faster when the same question stays in mind for a run of items.
The review queue has a mode switch: **Mixed** (the default, every criterion in
the queue's own order) and **One criterion at a time**. In the second mode a
select lists every criterion with items up for review, with its count
("protects-other-patients (14 left)"), sorted by id, from `stats.byCriterion`. The
chosen criterion's text, its Critical flag and the "View or edit this criterion"
link are pinned to the top of the page (sticky under the top bar), and each item
shows only its scenario instead of repeating the criterion.

The page asks for `GET /api/queue?criterion=<id>`. **The filter runs after the
plan**, so it changes which items are on the page and nothing else:

- What is up for review, each item's `reason`, and therefore `sampled_by` and
  the random quota, are exactly as in mixed mode. `findQueueItem` (used when a
  label is posted) never sees the filter.
- The items keep the blind display order (the order hash), so within a criterion
  position still says nothing about why an item is there.
- All the stats come from the whole plan. Only `queued`, the page size, differs.
- A one-criterion page gets no per-page random top-up. In mixed mode a page
  swaps its last targeted items for random ones until it has its share; doing
  that inside a criterion would pull items out of the blind order for no gain,
  because the plan already holds the quota across the whole queue.

When a criterion runs out the page says so and offers the next criterion by id
that has items left (wrapping round), or a way back to mixed.

`#/classify?criterion=<id>` opens this mode on that criterion. It composes with
`item=`, and the item wins: the page opens the item's own criterion (the part of
the item id after the first colon), with the item current. Choosing a mode or a
criterion on the page puts it in the address (replacing the history entry), and
the last mode is remembered in `localStorage` inside try/catch. An address that
names a criterion wins over the remembered mode. With the mode remembered but no
criterion named, the page starts on the first criterion by id that has items.

### Quick critiques

Many critiques repeat. Once a verdict is chosen, in the first label form and in
"Change my label", up to four one-click phrases appear under the critique box.
They come from `GET /api/labels/suggestions`:

- **The person's own earlier critiques** for the same criterion and verdict, from
  the current labels (a changed label counts with its latest critique). The page
  sends the name in the "Your name" field as `labeler`. If that person has none,
  everyone's are used and the page says they are from other labelers. With no
  name, everyone's are used.
- **Ranked by how often** the normalised text (trimmed, whitespace collapsed,
  case ignored) was written, ties by the most recent. Each is shown as last
  written. Critiques over 300 characters are left out, as too specific to one
  item. With none to offer there are no chips, and there are no generic defaults.
- **Nothing from the judge.** The endpoint reads only the label file.

A chip shows the start of the text, with the whole text in its title. Clicking
it fills an empty critique box. When the box already has text the phrase goes on
a new line after it, so nothing typed is lost and no undo is needed. The box
stays editable. Keys 1 to 4 insert the matching chip while focus is outside a
text field, so typing a digit in the critique box still types it. When changing
a label, the item's own current critique is left out (`exclude`), since it is
already in the box.

## Editing a rubric

**Why.** Calibration and the reveal in Classify show where the judge and the
person disagree. Some disagreements are the judge misreading the rubric. Others
are the judge following the rubric faithfully where the rubric says something the
person does not agree with (a criterion that fails a refusal the person would
pass, say, and a worked example that teaches the same). The fix for the second
kind is in the rubric, and making it should not mean leaving the page to find
the file. The links from Classify and Calibration go straight to the criterion,
and the Rubrics tab can change it. This closes the loop from a disagreement to
the rule.

**The file stays the source of truth.** An edit writes the rubric's own YAML file
and nothing else, so it shows up in `git diff` and is reviewed like any other
change. There is no second copy and no database. The server changes only the
text that was edited: it finds each node with the `yaml` Document API and
replaces those spans of the file, keeping everything else byte for byte,
comments included. (Printing the whole parsed document again would keep comments
but re-wrap every folded block in the file, which would bury a one-line change in
dozens of unrelated ones.) An edited folded paragraph keeps its own line breaks
where the words did not change.

**What can change.** The wording, weight and critical flag of each criterion, the
reference facts (`context`), and the worked examples (`anchors`), which can be
added, edited and deleted. Criterion ids are fixed, along with how many there are
and their order: labels, runs and calibrations refer to criteria by id, so a
rename would orphan them. To change the set, edit the file in an editor.

**Versions bump on every save**, so past runs and calibrations, which record the
rubric version they used, keep showing it. A version that is not a whole number
asks for the new one.

**Labels made against the old wording.** Labels are about a criterion id, not its
wording. The save confirmation, and the response, say how many current labels
exist for each criterion whose wording changed: "3 labels were made against the
old wording of protects-other-patients. If the meaning changed, review them in
Classify." It is information. Nothing is relabelled or hidden.

**On the page.** Each rubric on the Rubrics tab has an Edit button. Edit mode has
a text area for each criterion's wording, a weight, a critical checkbox, a text
area for the reference facts, and the worked examples with Edit, Delete and Add
example (criterion or "Whole rubric", input, output, verdict, critique). Save
opens a confirmation that lists what changed, says which version the save makes
("Saving makes this version 3. Past runs and calibrations keep showing the
version they used."), and gives the label counts. Confirm writes, Back to editing
returns to the form. A 409 `stale` (the file was edited on disk meanwhile) shows a
message and a button to reload the file.

## Worked examples from labels

**Why.** When the judge misreads a rubric, a sharper worked example is often the
fix, and the label a person just wrote is that example: the input, the output,
the verdict and a critique. Copying it into the YAML by hand is slow and easy to
get wrong, and it is easy to copy a dev or test label by mistake, which would
let calibration grade the judge on an example it was shown. A button does it
under the rules instead.

**On the page.** In Classify, every label in the All labels list carries a small
split badge (train, dev or test), and so does the saved item in the review queue
after the reveal. The label's details, and the queue after the reveal, show:

- for a train label that is not an example yet, **Use as worked example**. It
  opens a dialog prefilled with the input, output, verdict and critique. Input,
  output and critique are editable, so a long transcript can be trimmed; the
  verdict is read-only. The dialog says "Adds this to rubric `<id>` and makes it
  version N. The judge sees every worked example on every grading call, so each
  call costs slightly more." Confirm calls
  `POST /api/rubrics/:id/anchors/from-label` with the rubric's current hash. On
  success the page says "Added as a worked example" and links to the criterion
  on the Rubrics tab.
- for a dev or test label, the button disabled, with the reason beside it: "Only
  training labels can become worked examples, so dev and test stay an honest
  check of the judge."
- for a label that already is an example, an **Example** badge instead.

All of this is on labelled items only, so nothing about the judge shows before a
label is saved. Adding an example changes the judge, so the next step is a new
calibration on dev (see "Worked examples from labels" in 0002).

## The findings report

**Why.** The labels are also the clearest bug reports there are: each fail label
is a reply a person judged wrong, with a written reason. The Findings page turns
them into a document a developer can act on. It lists only failures a person
confirmed, and says how many judge failures are still waiting for review, so a
reader knows where the line is. Disagreements with the judge belong to the other
loop, fixing the judge (see "Two loops" in 0002).

**On the page** (`#/findings`, in the navigation): filters for runs since a date,
rubric and criterion, kept in the address; the summary table (criterion,
critical, failed / labelled); a collapsible section per criterion with the rule
text and each finding (scenario, run time, user message, assistant reply,
critique, labeler, a Revised badge when the label was changed) and an "Open the
run" link; and the buttons **Download Markdown** and **Copy as Markdown**, both
of which fetch `GET /api/findings.md` with the same filters.

**Suggest fixes** asks the judge model for a draft of fixes. It never fires on
one click: the page asks the server for a preview, shows a dialog with the
scope, the number of findings, the model and the estimated cost (focus on
Cancel), and only Confirm makes the call. A 412 means the findings changed: the
page previews again and shows the new numbers in the dialog. The latest draft
for the current filters is shown above the table as "Suggested fixes (AI draft,
review before use)", with its date, model and cost and a note that it is a draft
to check against the findings, and a warning when the findings have changed
since it was written.

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

## Front end (Phase 2)

The page is React and TypeScript in `ui/`, built by Vite into `dist/ui` with
`emptyOutDir: false` (the build removes only its own `index.html` and `assets/`,
so the compiled `api-types` stays). It imports its types from
`src/ui/api-types.ts` with `import type`, so nothing from the server reaches the
bundle. React, Vite and the test libraries are devDependencies, so the package's
runtime dependencies are unchanged.

| Route | Screen |
|---|---|
| `#/` | Overview: goal-achieved rate first, pass rate, runs, cost (null shown as unknown), trend, failures by tag, failing criteria and checks |
| `#/runs`, `#/runs/<runId>` | Suites, filtered run list, and run detail with transcript, tool calls, checks (skipped shown apart from pass), criteria with critiques (N/A criteria listed apart, muted and marked "Not graded"), goal, score (n/a when no criterion applied), cost, trace |
| `#/launch` | Choose scenarios and a cap, preview, confirm, then live progress from the event stream and cancel |
| `#/classify`, `#/classify?item=<itemId>`, `#/classify?criterion=<id>`, `#/classify/labels` | Blind review queue (with a picker, a deep link to one item, and one-criterion mode), and the label list |
| `#/findings`, `#/findings?since=<date>&rubric=<id>&criterion=<id>` | The findings report: what people failed and why, by criterion, with Markdown download and copy, and an AI draft of suggested fixes behind a confirmation |
| `#/calibration` | Choose rubric, split and selection, preview, confirm, then the report with the true negative rate first |
| `#/scenarios`, `#/scenarios?tab=rubrics&rubric=<id>&criterion=<id>` | Scenarios (read-only), rubrics with an Edit button, and validation problems. The deep link opens the Rubrics tab and highlights that criterion and its worked examples |

Choices worth knowing:

- **Hash routing**, with no router dependency, so a reload at any address returns
  `index.html` and the page restores its own route.
- **Fonts are bundled** (`@fontsource`, latin subsets) instead of linked from Google
  Fonts. The server's Content-Security-Policy allows only this origin for styles and
  fonts, so a Google Fonts link would be blocked, and a bundled font makes no
  request to another origin and looks the same offline. Fallback stacks cover a
  font that fails to load.
- **Theme.** Blueprint's warm dark palette is the default. Blueprint has no light
  theme, so the light tokens are derived from the same palette. The choice is saved
  in `localStorage` inside try/catch, and the page works when storage throws.
- **One event stream** per page, in a provider, with a reducer over the events. A
  replayed event is applied once, a dropped connection shows a notice, and a stream
  that the browser closes for good is opened again.
- **Blind labelling.** The queue view renders the criterion text, `input`, `output`
  and, on request, `context`. It never renders `reason`, and it calls
  `GET /api/labels/:id/reveal` only after `POST /api/labels` succeeds and the person
  asks for it. Tests assert that neither the reason nor the judge's text is in the
  DOM before the label is saved.
- **Changing a label.** After the reveal, "Change my label" (shortcut E) opens
  the verdict and critique form pre-filled with the current label. Saving calls
  `POST /api/labels/:id/revise` and fetches the reveal again, which then says
  what was changed. The label list offers the same action on each label and
  marks changed labels "Revised". Nothing about the judge appears before the
  first label is saved, and only a labelled item can be changed.
- **One criterion at a time.** A mode switch on the review queue filters it to
  one criterion with `GET /api/queue?criterion=`, pins the criterion to the top
  of the page, and offers the next criterion when one runs out. See
  [One criterion at a time](#one-criterion-at-a-time).
- **Quick critiques.** After a verdict is chosen, up to four of the person's own
  earlier critiques for that criterion and verdict appear as chips under the
  critique box, in the first label form and in "Change my label". Keys 1 to 4
  insert one when focus is outside a text field. See
  [Quick critiques](#quick-critiques).
- **Editing a rubric.** See [Editing a rubric](#editing-a-rubric). Classify (next
  to the criterion, before and after the reveal) and the disagreements in a
  calibration report link to the criterion with "View or edit this criterion".
  From Classify the link opens a new tab, so an unsaved label stays put.
- **Worked examples from labels.** See
  [Worked examples from labels](#worked-examples-from-labels).
- **Findings.** See [Findings](#the-findings-report).
- **Confirmation.** The page never calls `POST /api/run/start`,
  `POST /api/calibrate/start` or `POST /api/findings/summary` without a preview of
  the same request and a click in a dialog that states the scope and the number
  of model calls (for a findings summary: the number of findings, the model and
  the estimated cost). A changed selection or
  cap drops the preview. A 412 triggers a new preview and a list of what changed.
- **Demo mode.** `npm run ui:demo` starts the server with `demo: true`, which
  `GET /api/health` reports and the page turns into a "Demo data" banner. The demo
  server has no model provider and no key, so a plan that calls a model is refused
  at start with 503 `provider_unavailable`.
- **Development.** `npm run dev:ui` runs Vite with a proxy for `/api` that adds the
  token header and presents the server's own origin. See the README.

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
label validation, calibration through the API, corrupt files, rubric edits (on
temporary copies of the example rubrics: comments kept, version bumps, stale,
refused edits, label counts, and the change showing in the rubric list and the
queue), worked examples from labels (comments kept, version bump, train only,
duplicates, stale, overrides), the findings report and its Markdown (grouping,
ordering, counts, filters, revised labels, unreviewed judge failures), the
findings summary's preview and confirmation (a changed report is a 412, a
missing provider, a failed call, a saved draft), and that no response contains a
secret value from the environment.

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
   so editing a rubric changes what a labeller is shown for old runs. A save from
   the page says how many labels were made against the old wording, but they are
   not marked. Pinning the rubric version in the suite record, and on each label,
   would fix that.
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
import type { EnvRef, ModelNeeds, ModelPlan, PreviewData } from '../engine/plan.js'
import type { CriterionVerdict, GraderResult, RunResult, RunStatus } from '../core/interfaces.js'
import type { Anchor, Rubric, Scenario } from '../core/scenario.js'
import type { Turn } from '../core/trace.js'
import type { CalibrationRecord } from '../store/calibration.js'
import type { CriterionFindings, Finding, FindingsFilters, FindingsReport, FindingsSummaryRecord, SuggestedFix } from '../store/findings.js'
import type {
  LabelStats, QueueItem, QueueStats, QueueReason, Reveal, QueueTurn, QueueToolCall,
} from '../store/labels.js'
import type { SuiteRecord, SuiteStatus, SuiteSummary } from '../store/suites.js'

export type {
  Anchor, CalibrationReport, CalibrationRecord, CriterionFindings, CriterionVerdict, EnvRef, Finding, FindingsFilters, FindingsReport, FindingsSummaryRecord,
  GraderResult, Label, LabelStats, ModelNeeds, ModelPlan, PreviewData, QueueItem, QueueReason, QueueStats, QueueToolCall, QueueTurn, Reveal, Rubric, RunResult,
  RunStatus, Scenario, Split, SuggestedFix, SuiteRecord, SuiteStatus, SuiteSummary, Turn,
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
  | 'run_in_progress' //         409: a run or calibration is already running, or a findings summary is being written
  | 'no_active_run' //           409: cancel with nothing running
  | 'confirmation_required' //   428: a plan that can call a model needs previewToken and confirm: true
  | 'preview_token_invalid' //   412: the token does not match a fresh preview of this exact plan, or expired
  | 'config_missing' //          409: no config file was found or given
  | 'config_invalid' //          422: the config does not validate
  | 'plan_invalid' //            422: scenarios or selection cannot run. details.errors lists them
  | 'provider_unavailable' //    503: the model provider could not be created (key missing, say)
  | 'contamination' //           409: the judge's few-shot examples include dev or test labels, or a new worked example would
  | 'duplicate_label' //         409
  | 'item_not_found' //          404: no such queue item
  | 'item_not_in_queue' //       422: the item exists but is not up for review (an unsampled pass)
  | 'not_labelled' //            403: reveal before the item has a human label. 404 from revise or from-label: the item has no label
  | 'not_revealable' //          404: the label is not for a queue item, or its run is gone
  | 'no_change' //               422: a label revision or rubric edit that changes nothing
  | 'not_train' //               422: only a train-split label can become a worked example
  | 'not_in_rubric' //           422: the label's criterion is not a criterion of that rubric
  | 'duplicate_example' //       409: the rubric already has a worked example with this input and output
  | 'no_findings' //             422: a findings summary was asked for with no findings in the filter
  | 'provider_error' //          502: the model call failed or returned something unusable
  | 'stale' //                   409: the rubric file changed on disk since the page read it (its hash is not baseHash). Reload
  | 'rubric_invalid' //          422: a rubric edit that cannot be applied: criteria added, removed or renamed, a bad example, a missing version
  | 'corrupt_record' //          422: a saved file could not be read
  | 'store_unwritable' //        500: the .evals directory, or a rubric file being edited, could not be written
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
  /** True when the server was started on synthetic demo data (`npm run ui:demo`). The page shows a banner. */
  demo: boolean
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
  /** Times the judge graded this criterion (pass or fail) in the suites considered. Runs where it was not applicable are not counted. */
  judged: number
  /** Times the judge found this criterion not applicable. Not part of `judged` or `failureRate`. */
  notApplicable: number
  /** failures / judged. */
  failureRate: number
  /** Scenarios whose runs failed it. */
  scenarios: string[]
  critical: boolean
}

/** Pass, fail and not-applicable counts for one criterion, over the suites considered. */
export interface CriterionTally {
  criterion: string
  pass: number
  fail: number
  /** The situation the criterion governs never arose. Not graded. */
  notApplicable: number
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
  /** Every criterion the judge decided, with its pass, fail and not-applicable counts, by id. Not applicable is never counted as a pass or a failure. */
  criteria: CriterionTally[]
  /** Criteria with at least one failure. Runs where a criterion was not applicable are left out of the rates. */
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
  /** Ids of criteria the judge found not applicable. They are not graded. */
  notApplicableCriteria: string[]
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
  /** The day the conversation took place, worded as LLM graders are told it, in the config's timezone. Null when the start time is not a valid time. */
  conversationDate: string | null
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
  /** `file` relative to the working directory, for display. Absolute when the file is outside it. */
  relativeFile: string
  /** sha256 of the file's bytes, in hex. Send it back as `baseHash` to edit the rubric. */
  hash: string
  /** Ids of scenarios that use it. */
  usedBy: string[]
}

export interface RubricsResponse {
  path: string | null
  rubrics: RubricItem[]
  problems: string[]
}

/** One criterion in RubricUpdateRequest. The id must be the file's; only the other fields can change. */
export interface CriterionEdit {
  id: string
  /** Must not be blank. */
  text: string
  /** Omit to keep the file's value. */
  weight?: number
  /** Omit to keep the file's value. */
  critical?: boolean
}

/**
 * The body of PUT /api/rubrics/:id. The server writes the file it loaded the
 * rubric from, and nothing else.
 */
export interface RubricUpdateRequest {
  /** `hash` from GET /api/rubrics. A file that changed on disk since then is refused with 409 `stale`. */
  baseHash: string
  /** Every criterion, with the file's ids in the file's order. Criteria cannot be added, removed, renamed or reordered here. */
  criteria: CriterionEdit[]
  /** The reference facts. Null or blank removes them. */
  context: string | null
  /** Every example, replacing the file's list. Each must name an existing criterion, or none for the rubric as a whole. */
  anchors: Anchor[]
  /**
   * The new version. A whole-number version goes up by one on its own, so this
   * is needed only when the current version is not a whole number. It must
   * differ from the current version.
   */
  version?: string
}

/** How many current labels were made against a criterion whose wording just changed. */
export interface LabelImpact {
  criterion: string
  labels: number
}

export interface RubricUpdateResponse {
  /** The rubric as GET /api/rubrics now returns it. */
  item: RubricItem
  /** The new version. */
  version: string
  /** The new file's hash, for the next edit. */
  hash: string
  /** One entry per criterion whose text changed, with the number of current labels for it (zero included). */
  labelImpact: LabelImpact[]
  /** Set when the labels could not be counted, for one. The edit was saved. */
  warnings: string[]
}

/**
 * The body of POST /api/rubrics/:id/anchors/from-label: turns a train-split
 * label into a worked example at the end of the rubric's `anchors`. The
 * criterion and verdict come from the label. The optional fields replace the
 * label's text in the example, so a long transcript can be trimmed or the
 * critique tidied first. The label itself is unchanged.
 */
export interface AnchorFromLabelRequest {
  /** The item id of a labelled item. */
  itemId: string
  /** `hash` from GET /api/rubrics. A file that changed on disk since then is refused with 409 `stale`. */
  baseHash: string
  /** Replaces the label's input. Blank leaves the example without one. */
  input?: string
  /** Replaces the label's output. Must not be blank. */
  output?: string
  /** Replaces the label's critique. Must not be blank. */
  critique?: string
}

export interface AnchorFromLabelResponse {
  /** The rubric as GET /api/rubrics now returns it. */
  item: RubricItem
  /** The new version. */
  version: string
  /** The new file's hash, for the next edit. */
  hash: string
  /** The example that was added. */
  anchor: Anchor
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
export type RunEndSummary = Omit<RunListItem, 'suiteId' | 'startedAt' | 'turns' | 'tags' | 'models' | 'failedChecks' | 'notApplicableCriteria'> & {
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

/**
 * The body of POST /api/labels/:id/revise, where `:id` is the item id. A
 * revision is a new line that replaces the current label. The blind label stays
 * in the file.
 */
export interface ReviseRequest {
  labeler: string
  verdict: 'pass' | 'fail'
  /** Required, as on every label. */
  critique: string
}

export interface LabelResponse {
  label: Label
}

export interface LabelsResponse {
  file: string
  /** The current label of each item. A changed label appears once, as its latest version. */
  labels: Label[]
  /** For each item whose label was changed, keyed by item id: the superseded versions, oldest first (the blind label first). */
  history: Record<string, Label[]>
  /** For each current label, keyed by item id: its split and whether it is already a worked example. */
  meta: Record<string, LabelMeta>
  stats: LabelStats
}

/** What the page needs to offer "Use as worked example" on a label. Derived on every read, never stored. */
export interface LabelMeta {
  /** From the label's group (or its item id). Only train labels can become worked examples. */
  split: Split
  /** The rubric the label's criterion belongs to: the one its run's scenario uses, else the only loaded rubric with that criterion. Null when there is none. */
  rubricId: string | null
  /** True when that rubric already has a worked example made from this label (same input and output, or a trimmed copy of them). */
  isExample: boolean
}

/**
 * GET /api/labels/suggestions?criterion=&verdict=&labeler=&exclude=: up to
 * four of the labeler's own earlier critiques for that criterion and verdict,
 * most often written first, as one-click phrases. Taken from the current
 * labels only, never from the judge.
 */
export interface LabelSuggestionsResponse {
  suggestions: string[]
  /** True when the named labeler had none, so these are other people's critiques. */
  fromOtherLabelers: boolean
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

// ------------------------------------------------------------------ findings

/**
 * GET /api/findings?since=&rubric=&criterion= (and GET /api/findings.md, the
 * same report as Markdown). Built from the current fail labels joined to the
 * saved runs. No model is called.
 */
export interface FindingsResponse extends FindingsReport {
  /** The latest saved AI draft for these exact filters, or null. `current` is false when the findings changed since it was written. */
  summary: { record: FindingsSummaryRecord; current: boolean } | null
  /** Skipped run files, and the like. */
  warnings: string[]
}

/** The body of POST /api/findings/summary/preview. The same filters as GET /api/findings. */
export interface FindingsSummaryRequest {
  /** A date (2026-11-01) or an ISO time. Only runs that started then or later. */
  since?: string
  rubric?: string
  criterion?: string
}
export type FindingsSummaryStartRequest = FindingsSummaryRequest & RunStartFields

export interface FindingsSummaryPreviewResponse {
  /** The filters as the server read them (`since` as an ISO time). */
  filters: FindingsFilters
  /** Findings in the report, and how many of them the prompt holds (at most 25 per criterion, newest first). */
  findings: number
  findingsInPrompt: number
  criteria: number
  /** The judge model from the config, which writes the draft. */
  model: ModelPlan
  /** Rough: about four characters per token. */
  estimatedInputTokens: number
  /** The output cap. Thinking counts against it. */
  maxOutputTokens: number
  /** Estimated input plus output at its cap, at the config's prices, so usually more than the real cost. Null when the model has no price. */
  estimatedCostUsd: number | null
  /** False when there are no findings: there is nothing to summarise and start will refuse. */
  anyModelCalls: boolean
  warnings: string[]
  /** HMAC of these findings, filters and model. Send it back with `confirm: true`. Valid until `expiresAt`. */
  previewToken: string
  expiresAt: string
}

export interface FindingsSummaryResponse {
  /** The draft, as saved in .evals/findings/. */
  record: FindingsSummaryRecord
}
```
<!-- api-types:end -->
