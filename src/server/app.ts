import { randomBytes } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { ContaminationError } from '../calibration/evaluate.js'
import { SplitViolationError } from '../calibration/labels.js'
import { FRAMEWORK_VERSION } from '../core/version.js'
import type { Config } from '../core/config.js'
import type { ModelProvider, Reporter } from '../core/interfaces.js'
import { loadConfig, loadScenarios } from '../core/load.js'
import { loadLabels } from '../calibration/labels.js'
import { executeCalibration, planCalibration } from '../engine/calibrate.js'
import { loadCatalog, type Catalog } from '../engine/catalog.js'
import { UsageError } from '../engine/errors.js'
import { providerErrors, crossCheck, modelNeeds, needsModel } from '../engine/plan.js'
import { executeRun, planRun, PlanProblemsError, type RunPlan } from '../engine/run.js'
import { defaultProvider } from '../cli/common.js'
import {
  appendLabel, buildQueue, CorruptRecordError, createSuiteWriter, DuplicateLabelError, findQueueItem, findRun, InvalidIdError, labelStats,
  LabelValidationError, latestCalibration, listLabels, listSuites, readSuite, readSuites, revealItem, saveCalibration, storePaths,
  type QueueOptions, type RubricLookup, type SuiteWriter,
} from '../store/index.js'
import type {
  ActiveJob, ApiErrorBody, CalibratePreviewResponse, CalibrateStartResponse, CalibrationResponse, ErrorCode, HealthResponse, LabelResponse,
  LabelsResponse, OverviewResponse, QueueResponse, RevealResponse, RubricsResponse, RunCancelResponse, RunPreviewResponse, RunResponse,
  RunsResponse, RunStartResponse, RunStatusResponse, ScenariosResponse, SuiteResponse, SuitesResponse,
} from '../ui/api-types.js'
import {
  ApiError, BASE_HEADERS, errorBody, readJson, sendJson, type Scrub,
} from './http.js'
import { createPreviewTokens, digest } from './preview-token.js'
import { createScrubber, secretValues } from './redact.js'
import { createSecurity, LOOPBACK_HOST, type Security } from './security.js'
import { createEventHub } from './sse.js'
import { DEFAULT_STATIC_DIR, isBuilt, sendUnauthorizedPage, serveStatic } from './static.js'
import { buildOverview, runEndSummary, runListItem, suiteListItem } from './views.js'

// The local web UI's server. See docs/design/0003-ui-and-api.md.

export interface UiServerOptions {
  /** Where `.evals/` lives. */
  workdir: string
  /** Absolute path of the config file, or null when there is none. Runs need one. */
  configFile?: string | null
  /** Absolute path of the scenarios file or directory, or null when there is none. */
  scenarioPath?: string | null
  /** The label file. Default `<workdir>/.evals/labels.jsonl`. */
  labelsFile?: string
  /** 0 picks a free port. */
  port?: number
  /** What ${env:NAME} references and secret scrubbing read. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** Passed to http targets. */
  fetch?: typeof fetch
  /** Builds the model provider. Defaults to the Anthropic provider, which reads its key from the environment. */
  createProvider?(config: Config): ModelProvider
  staticDir?: string
  /** The access token. Default: 32 random bytes. */
  token?: string
  maxBodyBytes?: number
  queueSeed?: string
  /** Marks the data as synthetic demo data. Reported in `GET /api/health` so the page can say so. Default false. */
  demo?: boolean
}

export interface UiServer {
  readonly port: number
  readonly token: string
  /** The URL to open, with the token. Printing it is the only place the token appears. */
  readonly url: string
  /** The URL without the token. */
  readonly origin: string
  readonly server: Server
  close(): Promise<void>
}

/** Every endpoint, as "METHOD /path". The design doc is checked against this list. */
export const API_ROUTES = [
  'GET /api/health',
  'GET /api/overview',
  'GET /api/suites',
  'GET /api/suites/:id',
  'GET /api/runs',
  'GET /api/runs/:runId',
  'GET /api/scenarios',
  'GET /api/rubrics',
  'POST /api/run/preview',
  'POST /api/run/start',
  'GET /api/run/status',
  'GET /api/run/events',
  'POST /api/run/cancel',
  'GET /api/queue',
  'POST /api/labels',
  'GET /api/labels',
  'GET /api/labels/:id/reveal',
  'POST /api/calibrate/preview',
  'POST /api/calibrate/start',
  'GET /api/calibration',
] as const

const MAX_BODY = 1024 * 1024
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ------------------------------------------------------------ request bodies
// Strict: an unknown field is an error, so a client cannot slip in a field the
// server would silently ignore (an API key, for one).

const runShape = {
  path: z.string().min(1).max(4096).optional(),
  only: z.array(z.string().min(1).max(200)).max(1000).optional(),
  tags: z.array(z.string().min(1).max(200)).max(1000).optional(),
  maxCostUsd: z.number().positive().finite().optional(),
}
const startShape = { previewToken: z.string().max(500).optional(), confirm: z.boolean().optional() }
const RunRequestSchema = z.strictObject(runShape)
const RunStartSchema = z.strictObject({ ...runShape, ...startShape })

const calibrateShape = {
  rubricId: z.string().min(1).max(200),
  split: z.enum(['dev', 'test']),
  selection: z.enum(['random', 'all']).optional(),
}
const CalibrateRequestSchema = z.strictObject(calibrateShape)
const CalibrateStartSchema = z.strictObject({ ...calibrateShape, ...startShape })

const LabelRequestSchema = z.strictObject({
  itemId: z.string().min(1).max(300),
  labeler: z.string().trim().min(1, 'labeler is required').max(100),
  verdict: z.enum(['pass', 'fail']),
  critique: z.string().trim().min(1, 'a critique is required on every label').max(20_000),
})

function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new ApiError(400, 'bad_request', z.prettifyError(parsed.error))
  return parsed.data
}

function intParam(url: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = url.get(name)
  if (raw === null) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) throw new ApiError(400, 'bad_request', `"${name}" must be an integer from ${min} to ${max}.`)
  return n
}

// ------------------------------------------------------------------ routing

interface Ctx {
  req: IncomingMessage
  res: ServerResponse
  query: URLSearchParams
  params: Record<string, string>
}
type Handled = { status?: number; body: unknown } | 'handled'
type Handler = (ctx: Ctx) => Handled | Promise<Handled>

interface Route {
  method: string
  regex: RegExp
  names: string[]
  handler: Handler
}

function compile(method: string, pattern: string, handler: Handler): Route {
  const names: string[] = []
  const source = pattern
    .split('/')
    .map(seg => {
      if (!seg.startsWith(':')) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      names.push(seg.slice(1))
      return '([^/]+)'
    })
    .join('/')
  return { method, regex: new RegExp(`^${source}$`), names, handler }
}

type ActiveState =
  | {
      kind: 'run'
      suiteId: string
      startedAt: string
      scenarioIds: string[]
      finished: number
      controller: AbortController
      cancelling: boolean
    }
  | { kind: 'calibrate'; startedAt: string }

// ------------------------------------------------------------------- server

export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const workdir = resolve(options.workdir)
  const env = options.env ?? process.env
  const paths = storePaths(workdir)
  const labelsFile = options.labelsFile ? resolve(options.labelsFile) : paths.labels
  const configFile = options.configFile ? resolve(options.configFile) : null
  const scenarioPath = options.scenarioPath ? resolve(options.scenarioPath) : null
  const staticDir = options.staticDir ?? DEFAULT_STATIC_DIR
  const maxBody = options.maxBodyBytes ?? MAX_BODY
  const token = options.token ?? randomBytes(32).toString('base64url')
  const tokens = createPreviewTokens(randomBytes(32))
  const hub = createEventHub()
  const pending = new Set<Promise<unknown>>()

  let security!: Security
  let active: ActiveState | null = null

  /** Rebuilt per call: the config can change under a running server, and so can the environment. */
  const scrubber = (): Scrub => createScrubber(secretValues(env, configFile))
  const shownPath = (file: string) => {
    const rel = relative(workdir, file)
    return rel === '' ? '.' : rel.startsWith('..') || isAbsolute(rel) ? file : rel
  }

  // ---- config, scenarios, paths

  function loadCfg(): Config {
    if (!configFile) {
      throw new ApiError(409, 'config_missing', 'No config file was found. Start the server with --config, or from a directory that has evals.config.yaml.')
    }
    if (!existsSync(configFile)) throw new ApiError(409, 'config_missing', `The config file is gone: ${shownPath(configFile)}`)
    try {
      return loadConfig(configFile)
    } catch (e) {
      throw new ApiError(422, 'config_invalid', message(e))
    }
  }

  /** A request's `path` may point only inside the working directory, the config's directory or the configured scenarios path. */
  function resolveScenarioPath(requested: string | undefined): string {
    if (requested === undefined) {
      if (!scenarioPath) {
        throw new ApiError(422, 'plan_invalid', 'There is no scenarios path. Start the server with a path, or from a directory that has a "scenarios" directory.', { errors: ['no scenarios path'] })
      }
      return scenarioPath
    }
    const full = resolve(workdir, requested)
    const roots = [workdir, ...(configFile ? [dirname(configFile)] : []), ...(scenarioPath ? [statSafe(scenarioPath)?.isDirectory() ? scenarioPath : dirname(scenarioPath)] : [])]
    let real: string
    try {
      real = realpathSync(full)
    } catch {
      throw new ApiError(422, 'plan_invalid', `Scenarios path not found: ${shownPath(full)}`, { errors: ['scenarios path not found'] })
    }
    const inside = roots.some(r => {
      let base: string
      try {
        base = realpathSync(r)
      } catch {
        return false
      }
      return real === base || real.startsWith(base + sep)
    })
    if (!inside) throw new ApiError(400, 'bad_request', 'path must be inside the working directory, the config directory or the scenarios path.')
    return full
  }

  const statSafe = (p: string) => {
    try {
      return statSync(p)
    } catch {
      return undefined
    }
  }

  function catalog(): Catalog | null {
    return scenarioPath && existsSync(scenarioPath) ? loadCatalog(scenarioPath) : null
  }

  // ---- run planning (shared by preview and start)

  function planFromRequest(request: z.infer<typeof RunRequestSchema>) {
    const config = loadCfg()
    const path = resolveScenarioPath(request.path)
    let all
    try {
      all = loadScenarios(path)
    } catch (e) {
      throw new ApiError(422, 'plan_invalid', message(e), { errors: [message(e)] })
    }
    let plan: RunPlan
    try {
      plan = planRun({
        config,
        all,
        only: request.only,
        tags: request.tags,
        maxCost: request.maxCostUsd === undefined ? undefined : { usd: request.maxCostUsd, source: 'maxCostUsd in the request' },
        env,
        display: shownPath,
        names: { only: '"only"', tags: '"tags"' },
      })
    } catch (e) {
      if (e instanceof PlanProblemsError) throw new ApiError(422, 'plan_invalid', e.message, { errors: e.errors })
      if (e instanceof UsageError) throw new ApiError(422, 'plan_invalid', e.message, { errors: [e.message] })
      throw e
    }
    const usedTargets = [...new Set(plan.selected.map(l => l.scenario.target))].sort()
    const fingerprint = {
      kind: 'run',
      path,
      scenarios: plan.selected.map(l => ({
        id: l.scenario.id,
        version: l.scenario.version,
        scenario: digest(l.scenario),
        rubric: l.rubric ? digest(l.rubric) : null,
      })),
      capUsd: plan.capUsd ?? null,
      models: config.models,
      pricing: Object.fromEntries([config.models.simulator.model, config.models.judge.model].map(m => [m, config.pricing[m] ?? null])),
      timeouts: config.timeouts,
      shortCircuit: config.shortCircuit,
      targets: Object.fromEntries(usedTargets.map(t => [t, digest(config.targets[t])])),
    }
    return { config, path, plan, fingerprint }
  }

  /** The gate: a plan that can call a model starts only with a token for this exact plan and confirm: true. */
  function requireConfirmation(anyModelCalls: boolean, body: { previewToken?: string; confirm?: boolean }, fingerprint: unknown): void {
    if (!anyModelCalls) return
    if (body.confirm !== true || !body.previewToken) {
      throw new ApiError(428, 'confirmation_required', 'This can call a model, which costs money. Preview it, then start with the previewToken and confirm: true.')
    }
    if (!tokens.verify(body.previewToken, fingerprint)) {
      throw new ApiError(412, 'preview_token_invalid', 'The preview token does not match this plan (the plan changed, or the token expired or is from another server). Preview again.')
    }
  }

  function createProviderOrThrow(config: Config): ModelProvider {
    try {
      return (options.createProvider ?? defaultProvider)(config)
    } catch (e) {
      throw new ApiError(503, 'provider_unavailable', `Cannot create the model provider: ${message(e)}`)
    }
  }

  const activeJob = (): ActiveJob | null =>
    active === null
      ? null
      : active.kind === 'run'
        ? { kind: 'run', startedAt: active.startedAt, suiteId: active.suiteId, scenarioIds: active.scenarioIds, finished: active.finished, cancelling: active.cancelling }
        : { kind: 'calibrate', startedAt: active.startedAt, cancelling: false }

  function assertIdle(): void {
    if (active) {
      throw new ApiError(409, 'run_in_progress', active.kind === 'run' ? 'A run is already in progress.' : 'A calibration is already in progress.', { activeJob: activeJob() })
    }
  }

  // ---- queue inputs

  function queueOptions(limit?: number): QueueOptions {
    const { suites } = readSuites(paths.runs, 200)
    const cat = catalog()
    const rubrics = new Map<string, { criteria: { id: string; text: string; critical: boolean }[] }>()
    for (const l of cat?.scenarios ?? []) if (l.rubric) rubrics.set(l.scenario.id, { criteria: l.rubric.criteria.map(c => ({ id: c.id, text: c.text, critical: c.critical })) })
    const rubricFor: RubricLookup = id => rubrics.get(id)
    return { suites, labels: readLabels(), rubricFor, limit, seed: options.queueSeed }
  }

  function readLabels() {
    try {
      return listLabels(labelsFile)
    } catch (e) {
      throw new ApiError(422, 'corrupt_record', message(e))
    }
  }

  // --------------------------------------------------------------- handlers

  const handlers: Record<(typeof API_ROUTES)[number], Handler> = {
    'GET /api/health': () => {
      const body: HealthResponse = {
        ok: true,
        version: FRAMEWORK_VERSION,
        workdir,
        dataDir: paths.root,
        configFile,
        scenarioPath,
        labelsFile,
        uiBuilt: isBuilt(staticDir),
        demo: options.demo === true,
        activeJob: activeJob(),
      }
      return { body }
    },

    'GET /api/overview': ({ query }) => {
      const limit = intParam(query, 'limit', 100, 1, 1000)
      const { suites, total, warnings } = readSuites(paths.runs, limit)
      const body: OverviewResponse = buildOverview(suites, total, warnings)
      return { body }
    },

    'GET /api/suites': ({ query }) => {
      const limit = intParam(query, 'limit', 200, 1, 1000)
      const listing = listSuites(paths.runs)
      const activeId = active?.kind === 'run' ? active.suiteId : undefined
      const body: SuitesResponse = { suites: listing.suites.slice(0, limit).map(({ runIds: _ids, ...h }) => suiteListItem(h, activeId)), warnings: listing.warnings }
      return { body }
    },

    'GET /api/suites/:id': ({ params }) => {
      const record = readSuite(paths.runs, params.id!)
      if (!record) throw new ApiError(404, 'not_found', `No suite "${params.id}".`)
      const { results, ...header } = record
      const body: SuiteResponse = { ...suiteListItem(header, active?.kind === 'run' ? active.suiteId : undefined), results }
      return { body }
    },

    'GET /api/runs': ({ query }) => {
      const limit = intParam(query, 'limit', 200, 1, 1000)
      const offset = intParam(query, 'offset', 0, 0, 1_000_000)
      const { suites, warnings } = readSuites(paths.runs, 200)
      const status = query.get('status')
      if (status !== null && !['pass', 'fail', 'error'].includes(status)) throw new ApiError(400, 'bad_request', '"status" must be pass, fail or error.')
      const suiteId = query.get('suite')
      const scenario = query.get('scenario')
      const tag = query.get('tag')
      let rows = suites.flatMap(s => s.results.map(r => runListItem(s.suiteId, r)))
      rows = rows.filter(r => (!status || r.status === status) && (!suiteId || r.suiteId === suiteId) && (!scenario || r.scenarioId === scenario) && (!tag || r.tags.includes(tag)))
      rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.runId.localeCompare(b.runId))
      const body: RunsResponse = { runs: rows.slice(offset, offset + limit), total: rows.length, warnings }
      return { body }
    },

    'GET /api/runs/:runId': ({ params }) => {
      const found = findRun(paths.runs, params.runId!)
      if (!found) throw new ApiError(404, 'not_found', `No run "${params.runId}".`)
      const body: RunResponse = found
      return { body }
    },

    'GET /api/scenarios': () => {
      const cat = catalog()
      const errors = [...(cat?.problems ?? [])]
      const warnings: string[] = []
      let envRefs: ScenariosResponse['validation']['envRefs'] = []
      if (!scenarioPath) errors.push('There is no scenarios path. Start the server with a path, or from a directory that has a "scenarios" directory.')
      else if (!cat) errors.push(`Scenarios path not found: ${shownPath(scenarioPath)}`)
      if (!configFile) errors.push('No config file was found, so targets cannot be checked and nothing can run.')
      else {
        try {
          const config = loadConfig(configFile)
          if (cat) {
            const check = crossCheck(config, cat.scenarios, env, shownPath)
            errors.push(...check.errors)
            warnings.push(...check.warnings)
            envRefs = check.envRefs
          }
        } catch (e) {
          errors.push(message(e))
        }
      }
      const body: ScenariosResponse = {
        path: scenarioPath,
        configFile,
        scenarios: (cat?.scenarios ?? []).map(l => ({
          scenario: l.scenario,
          file: l.file,
          rubricId: l.rubric?.id ?? null,
          needs: modelNeeds(l.scenario),
          needsModel: needsModel(modelNeeds(l.scenario)),
        })),
        validation: { errors, warnings, envRefs },
      }
      return { body }
    },

    'GET /api/rubrics': () => {
      const cat = catalog()
      const body: RubricsResponse = {
        path: scenarioPath,
        rubrics: (cat?.rubrics ?? []).map(r => ({
          rubric: r.rubric,
          file: r.file,
          usedBy: (cat?.scenarios ?? []).filter(l => l.rubric?.id === r.rubric.id).map(l => l.scenario.id),
        })),
        problems: cat?.problems ?? [],
      }
      return { body }
    },

    'POST /api/run/preview': async ({ req }) => {
      const request = parseBody(RunRequestSchema, await readJson(req, maxBody))
      const { plan, path, fingerprint } = planFromRequest(request)
      const { token, expiresAt } = tokens.issue(fingerprint)
      const body: RunPreviewResponse = {
        preview: plan.preview.data,
        lines: plan.preview.lines,
        warnings: [...plan.preview.data.warnings, ...plan.check.warnings],
        previewToken: token,
        expiresAt: new Date(expiresAt).toISOString(),
        plan: { path, scenarioIds: plan.selected.map(l => l.scenario.id), capUsd: plan.capUsd ?? null },
      }
      return { body }
    },

    'POST /api/run/start': async ({ req }) => {
      const request = parseBody(RunStartSchema, await readJson(req, maxBody))
      // Everything from here to setting `active` is synchronous, so two starts cannot both pass the check.
      assertIdle()
      const { config, path, plan, fingerprint } = planFromRequest(request)
      requireConfirmation(plan.preview.anyModelCalls, request, fingerprint)
      const provider = plan.preview.anyModelCalls ? createProviderOrThrow(config) : undefined

      const writer = createSuiteWriter({ dir: paths.runs, command: 'evals ui', configFile: configFile!, scenarioPath: path })
      try {
        writer.start()
      } catch (e) {
        throw new ApiError(500, 'store_unwritable', `Cannot write ${shownPath(paths.runs)}: ${message(e)}. Nothing was run.`)
      }

      const controller = new AbortController()
      const run = {
        kind: 'run' as const,
        suiteId: writer.suiteId,
        startedAt: writer.record().startedAt,
        scenarioIds: plan.selected.map(l => l.scenario.id),
        finished: 0,
        controller,
        cancelling: false,
      }
      active = run

      const job = runInBackground(run, writer, { config, plan, provider })
      pending.add(job)
      void job.finally(() => pending.delete(job))

      const body: RunStartResponse = { suiteId: writer.suiteId, startedAt: run.startedAt, preview: plan.preview.data }
      return { status: 202, body }
    },

    'GET /api/run/status': () => {
      const body: RunStatusResponse = { activeJob: activeJob() }
      return { body }
    },

    'GET /api/run/events': ({ req, res }) => {
      hub.attach(req, res, { type: 'hello', activeJob: activeJob() }, scrubber())
      return 'handled'
    },

    'POST /api/run/cancel': ({ req }) => {
      req.resume() // the body, if any, means nothing
      if (active?.kind !== 'run') {
        throw new ApiError(409, 'no_active_run', active ? 'A calibration is running, and it cannot be cancelled.' : 'No run is in progress.')
      }
      active.cancelling = true
      active.controller.abort()
      const body: RunCancelResponse = { suiteId: active.suiteId, cancelling: true }
      return { status: 202, body }
    },

    'GET /api/queue': ({ query }) => {
      const limit = intParam(query, 'limit', 25, 1, 200)
      const queue = buildQueue(queueOptions(limit))
      const notes: string[] = []
      if (queue.stats.candidates === 0) {
        notes.push(listSuites(paths.runs).suites.length === 0 ? 'There are no saved runs yet. Run some scenarios first.' : 'Nothing is left to label: every item from the saved runs has a label.')
      } else if (queue.items.length === 0) notes.push('Nothing is up for review right now.')
      if (!queue.stats.quotaMet) notes.push('Fewer than the required share of the labels so far are random samples, so the queue favours random items until it catches up.')
      const body: QueueResponse = { ...queue, notes }
      return { body }
    },

    'POST /api/labels': async ({ req }) => {
      const request = parseBody(LabelRequestSchema, await readJson(req, maxBody))
      const options_ = queueOptions()
      if (options_.labels.some(l => l.id === request.itemId)) throw new ApiError(409, 'duplicate_label', `Item "${request.itemId}" already has a label.`)
      const found = findQueueItem(options_, request.itemId)
      if (found.status === 'unknown') throw new ApiError(404, 'item_not_found', `No unlabelled item "${request.itemId}".`)
      if (found.status === 'not_in_queue') {
        throw new ApiError(422, 'item_not_in_queue', 'That item is not up for review. Only items in the queue can be labelled, so the random quota holds.')
      }
      const { item, sampledBy } = found
      try {
        const label = appendLabel(labelsFile, {
          id: item.itemId,
          group: item.group,
          criterion: item.criterion.id,
          ...(item.input !== '' ? { input: item.input } : {}),
          output: item.output,
          verdict: request.verdict,
          critique: request.critique,
          labeler: request.labeler,
          sampled_by: sampledBy,
        })
        const body: LabelResponse = { label }
        return { status: 201, body }
      } catch (e) {
        if (e instanceof DuplicateLabelError) throw new ApiError(409, 'duplicate_label', e.message)
        if (e instanceof LabelValidationError) throw new ApiError(400, 'bad_request', e.message)
        throw e
      }
    },

    'GET /api/labels': () => {
      const labels = readLabels()
      const body: LabelsResponse = { file: labelsFile, labels, stats: labelStats(labels) }
      return { body }
    },

    'GET /api/labels/:id/reveal': ({ params }) => {
      const label = readLabels().find(l => l.id === params.id)
      if (!label) throw new ApiError(403, 'not_labelled', 'The judge\'s verdict is shown only after the item has a human label.')
      const revealed = revealItem(label, runId => {
        try {
          return findRun(paths.runs, runId)
        } catch {
          return null
        }
      })
      if (!revealed) throw new ApiError(404, 'not_revealable', 'This label is not for an item from a saved run, or the run is no longer saved.')
      const body: RevealResponse = revealed
      return { body }
    },

    'POST /api/calibrate/preview': async ({ req }) => {
      const request = parseBody(CalibrateRequestSchema, await readJson(req, maxBody))
      const c = calibrationPlan(request)
      const { token, expiresAt } = tokens.issue(c.fingerprint)
      const body: CalibratePreviewResponse = {
        preview: c.plan.preview.data,
        lines: c.plan.preview.lines,
        warnings: c.plan.preview.data.warnings,
        contamination: c.plan.contamination,
        labelsFile,
        previewToken: token,
        expiresAt: new Date(expiresAt).toISOString(),
      }
      return { body }
    },

    'POST /api/calibrate/start': async ({ req }) => {
      const request = parseBody(CalibrateStartSchema, await readJson(req, maxBody))
      assertIdle()
      const c = calibrationPlan(request)
      if (c.plan.contamination) throw new ApiError(409, 'contamination', `${c.plan.contamination} Nothing was run and nothing was spent.`)
      requireConfirmation(c.plan.preview.anyModelCalls, request, c.fingerprint)
      // With no labels to judge there is no model call, so no key is needed either.
      const provider: ModelProvider = c.plan.preview.anyModelCalls
        ? createProviderOrThrow(c.config)
        : { complete: async () => { throw new Error('no model call was expected') } }

      active = { kind: 'calibrate', startedAt: new Date().toISOString() }
      const work = (async () => {
        try {
          const report = await executeCalibration({ config: c.config, labels: c.labels, rubric: c.rubric, provider, split: request.split, selection: c.selection })
          try {
            return saveCalibration(paths.calibration, {
              rubricId: c.rubric.id,
              rubricVersion: c.rubric.version,
              labelsFile,
              split: request.split,
              selection: c.selection,
              command: 'evals ui',
              report,
            })
          } catch (e) {
            throw new ApiError(500, 'store_unwritable', `The calibration ran but could not be saved: ${message(e)}`)
          }
        } catch (e) {
          if (e instanceof ContaminationError || e instanceof SplitViolationError) throw new ApiError(409, 'contamination', e.message)
          throw e
        } finally {
          active = null
        }
      })()
      pending.add(work)
      void work.then(() => pending.delete(work), () => pending.delete(work))
      const body: CalibrateStartResponse = { record: await work }
      return { body }
    },

    'GET /api/calibration': () => {
      const body: CalibrationResponse = { latest: latestCalibration(paths.calibration) }
      return { body }
    },
  }

  function calibrationPlan(request: z.infer<typeof CalibrateRequestSchema>) {
    const config = loadCfg()
    const cat = catalog()
    const found = cat?.rubrics.find(r => r.rubric.id === request.rubricId)
    if (!found) {
      throw new ApiError(422, 'plan_invalid', `No rubric "${request.rubricId}". Known: ${(cat?.rubrics ?? []).map(r => r.rubric.id).join(', ') || '(none)'}.`, { errors: ['unknown rubric'] })
    }
    const problems = providerErrors(config, false, true)
    if (problems.length > 0) throw new ApiError(422, 'plan_invalid', problems.join('\n'), { errors: problems })
    const labels = (() => {
      try {
        return loadLabelsIfPresent()
      } catch (e) {
        throw new ApiError(422, 'corrupt_record', message(e))
      }
    })()
    const selection = request.selection ?? 'random'
    const plan = planCalibration({ config, labels, rubric: found.rubric, split: request.split, selection })
    const fingerprint = {
      kind: 'calibrate',
      rubric: digest(found.rubric),
      split: request.split,
      selection,
      labels: digest(labels),
      judge: config.models.judge,
      pricing: config.pricing[config.models.judge.model] ?? null,
      timeoutMs: config.timeouts.judgeMs,
    }
    return { config, rubric: found.rubric, labels, plan, selection, fingerprint }
  }

  function loadLabelsIfPresent() {
    return existsSync(labelsFile) ? loadLabels(labelsFile) : []
  }

  // ---- the background run

  async function runInBackground(
    run: Extract<ActiveState, { kind: 'run' }>,
    writer: SuiteWriter,
    ctx: { config: Config; plan: RunPlan; provider: ModelProvider | undefined },
  ): Promise<void> {
    const scrub = scrubber()
    const suiteId = run.suiteId
    hub.resetBuffer()
    hub.publish('suite:start', suiteId, { startedAt: run.startedAt, scenarioIds: run.scenarioIds, preview: ctx.plan.preview.data }, scrub)

    const bridge: Reporter = {
      onEvent(e) {
        if (e.type === 'run:start') hub.publish('run:start', suiteId, { runId: e.runId, scenarioId: e.scenarioId }, scrub)
        else if (e.type === 'turn') {
          const { raw: _raw, ...turn } = e.turn
          hub.publish('turn', suiteId, { runId: e.runId, turn }, scrub)
        } else if (e.type === 'grader:done') hub.publish('grader:done', suiteId, { runId: e.runId, result: e.result }, scrub)
        else {
          run.finished++
          hub.publish('run:end', suiteId, { runId: e.runId, summary: runEndSummary(e.result) }, scrub)
        }
      },
    }

    let failed = false
    try {
      await executeRun({
        config: ctx.config,
        selected: ctx.plan.selected,
        capUsd: ctx.plan.capUsd,
        env,
        fetch: options.fetch,
        provider: ctx.provider,
        // The writer comes first: when a client sees run:end, the run is already on disk.
        reporters: [writer, bridge],
        signal: run.controller.signal,
      })
    } catch (e) {
      failed = true
      hub.publish('error', suiteId, { code: 'run_failed', message: `The run stopped unexpectedly: ${message(e)}` }, scrub)
    }
    const cancelled = run.controller.signal.aborted
    const record = writer.finish({ cancelled, failed })
    hub.publish('suite:end', suiteId, { state: failed ? 'failed' : cancelled ? 'cancelled' : 'complete', summary: record.summary, warnings: writer.warnings }, scrub)
    active = null
  }

  // ----------------------------------------------------------------- server

  const routes = (Object.keys(handlers) as (keyof typeof handlers)[]).map(key => {
    const [method, pattern] = key.split(' ') as [string, string]
    return compile(method, pattern, handlers[key])
  })

  const apiError = (res: ServerResponse, e: ApiError, scrub: Scrub) => sendJson(res, e.status, errorBody(e) satisfies ApiErrorBody, scrub)

  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> {
    const scrub = scrubber()
    try {
      const matched = routes.filter(r => r.regex.test(path))
      if (matched.length === 0) throw new ApiError(404, 'not_found', 'No such endpoint.')
      const route = matched.find(r => r.method === req.method)
      if (!route) throw new ApiError(405, 'method_not_allowed', `Use ${matched.map(r => r.method).join(' or ')} for this endpoint.`)

      const m = route.regex.exec(path)!
      const params: Record<string, string> = {}
      for (const [i, name] of route.names.entries()) {
        try {
          params[name] = decodeURIComponent(m[i + 1]!)
        } catch {
          throw new ApiError(400, 'bad_request', 'The URL has an invalid percent escape.')
        }
      }
      const out = await route.handler({ req, res, query, params })
      if (out !== 'handled') sendJson(res, out.status ?? 200, out.body, scrub)
    } catch (e) {
      if (res.headersSent) return void res.end()
      if (e instanceof ApiError) return apiError(res, e, scrub)
      if (e instanceof InvalidIdError) return apiError(res, new ApiError(400, 'bad_request', e.message), scrub)
      if (e instanceof CorruptRecordError) return apiError(res, new ApiError(422, 'corrupt_record', e.message), scrub)
      apiError(res, new ApiError(500, 'internal', `Unexpected error: ${message(e)}`), scrub)
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const plain = (status: number, code: ErrorCode, text: string) => {
      const body: ApiErrorBody = { error: { code, message: text } }
      sendJson(res, status, body, s => s)
    }

    // 1. Host: only this server's own names, which defeats DNS rebinding.
    if (!security.hostAllowed(req.headers.host)) return plain(403, 'forbidden_host', 'The Host header is not this server.')

    // The URL is split by hand: new URL("//evil.example/x", base) would treat the
    // first segment as a host.
    const raw = req.url ?? '/'
    if (!raw.startsWith('/')) return plain(400, 'bad_request', 'Bad request target.')
    const q = raw.indexOf('?')
    const path = q < 0 ? raw : raw.slice(0, q)
    const query = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1))
    const method = req.method ?? 'GET'
    const isApi = path === '/api' || path.startsWith('/api/')

    if (isApi) {
      // 2. Origin, on every API call (and a cross-site marker from the browser).
      const problem = security.originProblem(req)
      if (problem) return plain(403, 'forbidden_origin', `Cross-origin requests are refused. ${problem}`)
      // 3. Token.
      if (!security.authenticated(req)) return plain(401, 'unauthorized', 'A valid access token is required (the link printed when the server started).')
      return handleApi(req, res, path, query)
    }

    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { ...BASE_HEADERS, allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
      return void res.end('Method not allowed')
    }
    // The first page load carries ?token=. Set the cookie and redirect to the same
    // page without it, so the token does not stay in the address bar or the history.
    const queryToken = query.get('token')
    if (queryToken !== null && security.tokenValid(queryToken)) {
      res.writeHead(302, { ...BASE_HEADERS, location: path.startsWith('//') ? '/' : path, 'set-cookie': security.cookieHeader() })
      return void res.end()
    }
    if (!security.authenticated(req)) return sendUnauthorizedPage(res, method === 'HEAD')
    serveStatic(staticDir, path, res, method === 'HEAD')
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(e => {
      if (!res.headersSent) {
        const body: ApiErrorBody = { error: { code: 'internal', message: `Unexpected error: ${message(e)}` } }
        sendJson(res, 500, body, scrubber())
      } else res.end()
    })
  })
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })

  await new Promise<void>((ok, fail) => {
    server.once('error', fail)
    // 127.0.0.1 only: the server is never reachable from another machine.
    server.listen(options.port ?? 0, LOOPBACK_HOST, () => {
      server.off('error', fail)
      ok()
    })
  })
  const port = (server.address() as AddressInfo).port
  security = createSecurity(token, port)
  const origin = `http://${LOOPBACK_HOST}:${port}`

  return {
    port,
    token,
    origin,
    url: `${origin}/?token=${token}`,
    server,
    async close() {
      if (active?.kind === 'run') active.controller.abort()
      await Promise.race([Promise.allSettled([...pending]), new Promise(r => setTimeout(r, 10_000).unref())])
      hub.closeAll()
      server.closeAllConnections()
      await new Promise<void>(done => server.close(() => done()))
    },
  }
}
