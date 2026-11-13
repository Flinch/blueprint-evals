import type {
  ActiveJob, GraderResult, PreviewData, RunEndSummary, RunStreamEvent, StreamHello, SuiteSummary, TurnEvent,
} from '../../../src/ui/api-types'

// The page's one view of what the server is running. It is built only from the
// event stream (docs/design/0003, "The run event stream"): a reducer over the
// events, so a page opened mid-run or after one replays to the same state.

export type ConnectionState = 'connecting' | 'open' | 'reconnecting'

export type RunPhase = 'queued' | 'running' | 'pass' | 'fail' | 'error'

export interface LiveRun {
  runId: string | null
  scenarioId: string
  phase: RunPhase
  turns: TurnEvent[]
  graders: GraderResult[]
  summary: RunEndSummary | null
}

export interface SuiteProgress {
  suiteId: string
  startedAt: string
  scenarioIds: string[]
  preview: PreviewData
  /** One per scenario, in run order. */
  runs: LiveRun[]
  end: { state: 'complete' | 'cancelled' | 'failed'; summary: SuiteSummary; warnings: string[] } | null
  failure: { code: string; message: string } | null
}

export interface RunStreamState {
  connection: ConnectionState
  /** From the last `hello`, kept current by suite events. Null when nothing is running. */
  activeJob: ActiveJob | null
  /** Highest `seq` applied. Replayed events at or below it are ignored. */
  lastSeq: number
  suite: SuiteProgress | null
  /** Bumps on every `run:end` and `suite:end`, so lists know to refresh. */
  refreshTick: number
  /** A plain-language line for a screen reader. */
  announcement: string
}

export const initialStreamState: RunStreamState = {
  connection: 'connecting',
  activeJob: null,
  lastSeq: 0,
  suite: null,
  refreshTick: 0,
  announcement: '',
}

export type StreamAction =
  | { type: 'connection'; state: ConnectionState }
  | { type: 'hello'; hello: StreamHello }
  | { type: 'event'; event: RunStreamEvent }
  | { type: 'seed-job'; job: ActiveJob | null }

function updateRun(suite: SuiteProgress, runId: string, fn: (r: LiveRun) => LiveRun): SuiteProgress {
  return { ...suite, runs: suite.runs.map(r => (r.runId === runId ? fn(r) : r)) }
}

const phaseOf = (s: RunEndSummary['status']): RunPhase => s

export function streamReducer(state: RunStreamState, action: StreamAction): RunStreamState {
  switch (action.type) {
    case 'connection':
      return { ...state, connection: action.state }

    case 'hello':
      return { ...state, activeJob: action.hello.activeJob }

    case 'seed-job':
      // From /api/health or /api/run/status. The stream's own hello wins once it arrives.
      return state.connection === 'open' || state.activeJob === action.job ? state : { ...state, activeJob: action.job }

    case 'event': {
      const e = action.event
      // A replay after a reconnect repeats events. A lower seq with a different
      // suite is a restarted server, whose counter began again.
      if (e.seq <= state.lastSeq && e.suiteId === state.suite?.suiteId) return state
      const base = { ...state, lastSeq: e.seq }

      switch (e.type) {
        case 'suite:start': {
          const suite: SuiteProgress = {
            suiteId: e.suiteId,
            startedAt: e.startedAt,
            scenarioIds: e.scenarioIds,
            preview: e.preview,
            runs: e.scenarioIds.map(id => ({ runId: null, scenarioId: id, phase: 'queued', turns: [], graders: [], summary: null })),
            end: null,
            failure: null,
          }
          const job: ActiveJob = state.activeJob ?? { kind: 'run', startedAt: e.startedAt, suiteId: e.suiteId, scenarioIds: e.scenarioIds, finished: 0, cancelling: false }
          return { ...base, suite, activeJob: job, announcement: `Run started with ${e.scenarioIds.length} scenarios.` }
        }

        case 'run:start': {
          const suite = state.suite
          if (!suite || suite.suiteId !== e.suiteId) return base
          // The first queued slot for this scenario id takes the run.
          const i = suite.runs.findIndex(r => r.scenarioId === e.scenarioId && r.runId === null)
          const runs =
            i >= 0
              ? suite.runs.map((r, idx) => (idx === i ? { ...r, runId: e.runId, phase: 'running' as const } : r))
              : [...suite.runs, { runId: e.runId, scenarioId: e.scenarioId, phase: 'running' as const, turns: [], graders: [], summary: null }]
          return { ...base, suite: { ...suite, runs }, announcement: `Running ${e.scenarioId}.` }
        }

        case 'turn': {
          if (!state.suite || state.suite.suiteId !== e.suiteId) return base
          return { ...base, suite: updateRun(state.suite, e.runId, r => ({ ...r, turns: [...r.turns, e.turn] })) }
        }

        case 'grader:done': {
          if (!state.suite || state.suite.suiteId !== e.suiteId) return base
          return {
            ...base,
            suite: updateRun(state.suite, e.runId, r => ({ ...r, graders: [...r.graders, e.result] })),
            announcement: `Grader ${e.result.grader} finished: ${e.result.status}.`,
          }
        }

        case 'run:end': {
          if (!state.suite || state.suite.suiteId !== e.suiteId) return base
          const suite = updateRun(state.suite, e.runId, r => ({ ...r, phase: phaseOf(e.summary.status), summary: e.summary }))
          const finished = suite.runs.filter(r => r.summary !== null).length
          return {
            ...base,
            suite,
            activeJob: state.activeJob ? { ...state.activeJob, finished } : state.activeJob,
            refreshTick: state.refreshTick + 1,
            announcement: `${e.summary.scenarioId} ${e.summary.status}.`,
          }
        }

        case 'suite:end': {
          if (!state.suite || state.suite.suiteId !== e.suiteId) return { ...base, activeJob: null, refreshTick: state.refreshTick + 1 }
          return {
            ...base,
            suite: { ...state.suite, end: { state: e.state, summary: e.summary, warnings: e.warnings } },
            activeJob: null,
            refreshTick: state.refreshTick + 1,
            announcement: `Run ${e.state}.`,
          }
        }

        case 'error': {
          const suite = state.suite && state.suite.suiteId === e.suiteId ? { ...state.suite, failure: { code: e.code, message: e.message } } : state.suite
          return { ...base, suite, announcement: `The run failed: ${e.message}` }
        }
      }
      return base
    }
  }
}

/** Cost so far: known run costs plus finished graders of runs still going. null when any part is unknown. */
export function costSoFar(suite: SuiteProgress | null): number | null {
  if (!suite) return 0
  let total = 0
  for (const r of suite.runs) {
    if (r.summary) {
      if (r.summary.costUsd === null) return null
      total += r.summary.costUsd
    } else {
      for (const g of r.graders) {
        if (!g.usage) continue
        if (g.usage.costUsd === null) return null
        total += g.usage.costUsd
      }
    }
  }
  return total
}
