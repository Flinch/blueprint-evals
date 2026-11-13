import { useState } from 'react'
import type { ActiveJob } from '../../../src/ui/api-types'
import { costSoFar, type ConnectionState, type LiveRun, type SuiteProgress } from '../state/runStream'
import { duration, plural, score, usd } from '../lib/format'
import { runHref } from '../lib/router'
import { TurnView } from '../pages/RunDetailPage'
import { Banner, StatusBadge, Warnings } from './ui'

// Live progress of the run on the server, drawn from the event stream: one row
// per scenario, its turns as they stream in, each grader as it finishes, and the
// running cost. A screen reader hears the state changes through a polite live
// region.

function LiveRunRow({ run }: { run: LiveRun }) {
  const [open, setOpen] = useState(false)
  const failed = run.graders.filter(g => g.status === 'fail').length
  return (
    <div className="progress-run" data-phase={run.phase}>
      <div className="progress-run-head">
        <StatusBadge status={run.phase} />
        <span className="verdict-name grow">{run.scenarioId}</span>
        {run.turns.length > 0 ? <span className="small muted num">{plural(run.turns.length, 'turn')}</span> : null}
        {run.summary ? (
          <>
            <span className="small num" title="Weighted share of applicable criteria passed">score {score(run.summary.score)}</span>
            <span className="small num muted">{usd(run.summary.costUsd)}</span>
            <span className="small num muted">{duration(run.summary.durationMs)}</span>
            {run.runId ? <a className="btn btn-ghost btn-sm" href={runHref(run.runId)}>Open run</a> : null}
          </>
        ) : null}
        {run.turns.length > 0 || run.graders.length > 0 ? (
          <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} onClick={() => setOpen(o => !o)}>
            {open ? 'Hide live view' : 'Show live view'}
          </button>
        ) : null}
      </div>
      {run.graders.length > 0 ? (
        <div className="progress-run-body">
          <div className="pill-row" aria-label={`Graders finished for ${run.scenarioId}`}>
            {run.graders.map((g, i) => (
              <span key={i} className="row" style={{ gap: '0.3rem' }}>
                <StatusBadge status={g.status} />
                <span className="mono small">{g.grader}</span>
              </span>
            ))}
          </div>
          {failed > 0 ? <p className="small muted" style={{ marginTop: '0.3rem' }}>{plural(failed, 'grader')} failed so far.</p> : null}
        </div>
      ) : null}
      {run.summary?.error ? <div className="progress-run-body small break" style={{ color: 'var(--danger-text)' }}>{run.summary.error}</div> : null}
      {open ? (
        <div className="progress-run-body">
          <div className="transcript">
            {run.turns.map(t => (
              <TurnView key={t.index} turn={t} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function RunProgress({
  suite,
  activeJob,
  connection,
  announcement,
  onCancel,
  cancelling,
}: {
  suite: SuiteProgress
  activeJob: ActiveJob | null
  connection: ConnectionState
  announcement: string
  onCancel(): void
  cancelling: boolean
}) {
  const running = suite.end === null && suite.failure === null
  const done = suite.runs.filter(r => r.summary !== null).length
  const cost = costSoFar(suite)
  const isCancelling = cancelling || activeJob?.cancelling === true

  return (
    <section className="stack" aria-label="Run progress">
      <div className="row-between">
        <div>
          <h3 className="section-title">{running ? 'Run in progress' : 'Last run'}</h3>
          <div className="mono small muted break">{suite.suiteId}</div>
        </div>
        {running ? (
          <button type="button" className="btn btn-danger" onClick={onCancel} disabled={isCancelling}>
            {isCancelling ? 'Cancelling' : 'Cancel run'}
          </button>
        ) : null}
      </div>

      {/* Screen readers: changes are announced politely. Visible text below carries the same facts. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>

      {connection !== 'open' ? (
        <Banner kind="warning" role="status">Reconnecting to the server. Progress will catch up when the connection returns.</Banner>
      ) : null}

      <div className="stats-row" style={{ marginBottom: 0 }}>
        <div className="stat-card">
          <div className="stat-num">{done} of {suite.runs.length}</div>
          <div className="stat-label">Scenarios finished</div>
        </div>
        <div className="stat-card">
          <div className="stat-num">{cost === null ? 'Unknown' : usd(cost)}</div>
          <div className="stat-label">Cost so far</div>
          {cost === null ? <div className="stat-sub">At least one model has no price.</div> : null}
        </div>
      </div>

      {suite.failure ? (
        <Banner kind="danger" title="The run failed." role="alert">
          <span className="break">{suite.failure.message}</span> ({suite.failure.code})
        </Banner>
      ) : null}
      {suite.end ? (
        <Banner kind={suite.end.state === 'complete' ? 'success' : 'warning'} title={suite.end.state === 'complete' ? 'Run complete.' : suite.end.state === 'cancelled' ? 'Run cancelled.' : 'Run failed.'}>
          {suite.end.summary.pass} pass, {suite.end.summary.fail} fail, {suite.end.summary.error} error. Cost {usd(suite.end.summary.costUsd)}.
        </Banner>
      ) : null}
      {suite.end ? <Warnings items={suite.end.warnings} title="Problems saving the run" /> : null}

      <div>
        {suite.runs.map((r, i) => (
          <LiveRunRow key={`${r.scenarioId}-${i}`} run={r} />
        ))}
      </div>
    </section>
  )
}
