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
import type { CriterionVerdict, GraderResult, RunResult, RunStatus } from '../core/interfaces.js'
import type { Anchor, Rubric, Scenario } from '../core/scenario.js'
import type { Turn } from '../core/trace.js'
import type { CalibrationRecord } from '../store/calibration.js'
import type {
  LabelStats, QueueItem, QueueStats, QueueReason, Reveal, QueueTurn, QueueToolCall,
} from '../store/labels.js'
import type { SuiteRecord, SuiteStatus, SuiteSummary } from '../store/suites.js'

export type {
  Anchor, CalibrationReport, CalibrationRecord, CriterionVerdict, EnvRef, GraderResult, Label, LabelStats, ModelNeeds, PreviewData, QueueItem, QueueReason,
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
  | 'not_labelled' //            403: reveal before the item has a human label. 404 from revise: no label to change
  | 'not_revealable' //          404: the label is not for a queue item, or its run is gone
  | 'no_change' //               422: a label revision or rubric edit that changes nothing
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
  stats: LabelStats
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
