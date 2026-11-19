import type {
  AnchorFromLabelRequest, AnchorFromLabelResponse, ApiErrorBody, CalibratePreviewResponse, CalibrateRequest, CalibrateStartRequest, CalibrateStartResponse, CalibrationResponse, ErrorCode,
  FindingsResponse, FindingsSummaryPreviewResponse, FindingsSummaryRequest, FindingsSummaryResponse, FindingsSummaryStartRequest, HealthResponse, LabelRequest, LabelResponse, LabelsResponse, LabelSuggestionsResponse, OverviewResponse, QueueResponse, RevealResponse, ReviseRequest, RubricsResponse,
  RubricUpdateRequest, RubricUpdateResponse, RunCancelResponse, RunPreviewResponse, RunRequest, RunResponse, RunsResponse, RunStartRequest, RunStartResponse, RunStatusResponse,
  ScenariosResponse, SuiteResponse, SuitesResponse,
} from '../../../src/ui/api-types'

// A thin typed wrapper over fetch. Relative URLs only, so Host and Origin are
// always the server's own. The access token lives in an HttpOnly cookie that
// the browser sends by itself: this code never sees it and never stores it.

export type ClientErrorCode = ErrorCode | 'network' | 'bad_response'

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: ClientErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiFailure'
  }
}

export function isApiFailure(e: unknown): e is ApiFailure {
  return e instanceof ApiFailure
}

function isErrorBody(x: unknown): x is ApiErrorBody {
  return typeof x === 'object' && x !== null && typeof (x as ApiErrorBody).error === 'object' && (x as ApiErrorBody).error !== null
}

async function request<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new ApiFailure(0, 'network', 'Could not reach the evals server. It may have stopped.')
  }

  let json: unknown
  const text = await res.text()
  try {
    json = text === '' ? {} : JSON.parse(text)
  } catch {
    json = undefined
  }

  if (!res.ok) {
    if (isErrorBody(json)) throw new ApiFailure(res.status, json.error.code, json.error.message, json.error.details)
    if (res.status === 401) throw new ApiFailure(401, 'unauthorized', 'This page needs the access token from the terminal.')
    throw new ApiFailure(res.status, 'bad_response', `The server answered ${res.status}.`)
  }
  if (json === undefined) throw new ApiFailure(res.status, 'bad_response', 'The server sent something that is not JSON.')
  return json as T
}

/** A GET whose success body is text (the findings Markdown). A failure is still ApiErrorBody. */
async function requestText(path: string): Promise<string> {
  let res: Response
  try {
    res = await fetch(path, { method: 'GET', credentials: 'same-origin', headers: { accept: 'text/markdown, application/json' } })
  } catch {
    throw new ApiFailure(0, 'network', 'Could not reach the evals server. It may have stopped.')
  }
  const text = await res.text()
  if (!res.ok) {
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    if (isErrorBody(json)) throw new ApiFailure(res.status, json.error.code, json.error.message, json.error.details)
    throw new ApiFailure(res.status, 'bad_response', `The server answered ${res.status}.`)
  }
  return text
}

const get = <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, signal)
const post = <T>(path: string, body: unknown = {}) => request<T>('POST', path, body)
const put = <T>(path: string, body: unknown) => request<T>('PUT', path, body)

function qs(params: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
  const s = q.toString()
  return s ? `?${s}` : ''
}

export interface RunsQuery {
  suite?: string
  scenario?: string
  tag?: string
  status?: string
  limit?: number
  offset?: number
}

export const api = {
  health: (signal?: AbortSignal) => get<HealthResponse>('/api/health', signal),
  overview: (limit = 100) => get<OverviewResponse>(`/api/overview${qs({ limit })}`),
  suites: (limit = 200) => get<SuitesResponse>(`/api/suites${qs({ limit })}`),
  suite: (id: string) => get<SuiteResponse>(`/api/suites/${encodeURIComponent(id)}`),
  runs: (q: RunsQuery = {}) => get<RunsResponse>(`/api/runs${qs({ ...q })}`),
  run: (runId: string) => get<RunResponse>(`/api/runs/${encodeURIComponent(runId)}`),
  scenarios: () => get<ScenariosResponse>('/api/scenarios'),
  rubrics: () => get<RubricsResponse>('/api/rubrics'),
  updateRubric: (id: string, body: RubricUpdateRequest) => put<RubricUpdateResponse>(`/api/rubrics/${encodeURIComponent(id)}`, body),
  runPreview: (body: RunRequest) => post<RunPreviewResponse>('/api/run/preview', body),
  runStart: (body: RunStartRequest) => post<RunStartResponse>('/api/run/start', body),
  runStatus: () => get<RunStatusResponse>('/api/run/status'),
  runCancel: () => post<RunCancelResponse>('/api/run/cancel'),
  queue: (limit = 25, criterion?: string | null) => get<QueueResponse>(`/api/queue${qs({ limit, criterion })}`),
  postLabel: (body: LabelRequest) => post<LabelResponse>('/api/labels', body),
  labels: () => get<LabelsResponse>('/api/labels'),
  suggestions: (q: { criterion: string; verdict: 'pass' | 'fail' | 'not_applicable'; labeler?: string; exclude?: string }) =>
    get<LabelSuggestionsResponse>(`/api/labels/suggestions${qs({ ...q })}`),
  reveal: (itemId: string) => get<RevealResponse>(`/api/labels/${encodeURIComponent(itemId)}/reveal`),
  revise: (itemId: string, body: ReviseRequest) => post<LabelResponse>(`/api/labels/${encodeURIComponent(itemId)}/revise`, body),
  calibratePreview: (body: CalibrateRequest) => post<CalibratePreviewResponse>('/api/calibrate/preview', body),
  calibrateStart: (body: CalibrateStartRequest) => post<CalibrateStartResponse>('/api/calibrate/start', body),
  calibration: () => get<CalibrationResponse>('/api/calibration'),
  anchorFromLabel: (rubricId: string, body: AnchorFromLabelRequest) => post<AnchorFromLabelResponse>(`/api/rubrics/${encodeURIComponent(rubricId)}/anchors/from-label`, body),
  findings: (q: FindingsSummaryRequest = {}) => get<FindingsResponse>(`/api/findings${qs({ ...q })}`),
  findingsMarkdown: (q: FindingsSummaryRequest = {}) => requestText(`/api/findings.md${qs({ ...q })}`),
  findingsSummaryPreview: (body: FindingsSummaryRequest) => post<FindingsSummaryPreviewResponse>('/api/findings/summary/preview', body),
  findingsSummary: (body: FindingsSummaryStartRequest) => post<FindingsSummaryResponse>('/api/findings/summary', body),
}

/** A sentence for an error, for the places that only show one. */
export function describeError(e: unknown): string {
  if (e instanceof ApiFailure) return e.message
  return e instanceof Error ? e.message : String(e)
}
