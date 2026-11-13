import { useMemo, useState } from 'react'
import type { RunListItem, SuiteListItem, SuiteState } from '../../../src/ui/api-types'
import { api } from '../api/client'
import { useAsync } from '../api/useAsync'
import { EmptyState, ErrorState, Loading, PageHead, StatusBadge, TagList, Warnings } from '../components/ui'
import { duration, percent, plural, score, shortDate, usd } from '../lib/format'
import { href, runHref, useLocation } from '../lib/router'
import { useRunStream } from '../state/RunStreamProvider'

const PAGE = 100

function SuiteStateBadge({ state }: { state: SuiteState }) {
  switch (state) {
    case 'running':
      return <StatusBadge status="running" />
    case 'failed':
      return <StatusBadge status="error" label="Failed" />
    case 'interrupted':
      return <StatusBadge status="error" label="Interrupted" />
    case 'cancelled':
      return <span className="badge">Cancelled</span>
    default:
      return <span className="badge">Complete</span>
  }
}

function GoalCell({ goal }: { goal: boolean | null }) {
  if (goal === null) return <span className="muted small">No goal check</span>
  return goal ? <span className="small" style={{ color: 'var(--success)' }}>Achieved</span> : <span className="small" style={{ color: 'var(--danger-text)' }}>Not achieved</span>
}

export function RunRow({ run }: { run: RunListItem }) {
  const failing = [...run.failedChecks, ...run.failedCriteria]
  return (
    <tr className="run-row" onClick={e => { if (!(e.target as HTMLElement).closest('a')) window.location.hash = runHref(run.runId) }} style={{ cursor: 'pointer' }}>
      <td className="cell-status"><StatusBadge status={run.status} /></td>
      <td className="cell-title">
        <a className="run-title" href={runHref(run.runId)}>{run.scenarioId}</a>
        {run.error ? (
          <span className="run-sub-error" style={{ display: 'block' }} title={run.error}>{run.error}</span>
        ) : failing.length > 0 ? (
          <span className="run-sub" style={{ display: 'block' }} title={failing.join(', ')}>Failed: {failing.join(', ')}</span>
        ) : (
          <span className="run-sub" style={{ display: 'block' }}>{run.tags.join(', ') || 'No tags'} &middot; {plural(run.turns, 'turn')}</span>
        )}
      </td>
      <td className="cell-goal"><GoalCell goal={run.goalAchieved} /></td>
      <td className="cell-score" title="Weighted share of criteria passed. It is a diagnostic only.">{score(run.score)}</td>
      <td className="cell-cost">{usd(run.costUsd)}</td>
      <td className="cell-duration">{duration(run.durationMs)}</td>
      <td className="cell-date">{shortDate(run.startedAt)}</td>
    </tr>
  )
}

export function RunTable({ runs }: { runs: RunListItem[] }) {
  return (
    <div className="table-wrap">
      <table className="run-list-table">
        <thead>
          <tr className="run-head-row">
            <th className="cell-status">Status</th>
            <th className="cell-title">Scenario</th>
            <th className="cell-goal">Goal</th>
            <th className="cell-score">Score</th>
            <th className="cell-cost">Cost</th>
            <th className="cell-duration">Time</th>
            <th className="cell-date">Started</th>
          </tr>
        </thead>
        <tbody>
          {runs.map(r => (
            <RunRow key={r.runId} run={r} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function matches(run: RunListItem, needle: string): boolean {
  if (needle === '') return true
  const hay = [run.scenarioId, run.runId, run.error ?? '', ...run.failedCriteria, ...run.failedChecks, ...run.tags, run.models.judge ?? '', run.models.simulator ?? '']
    .join(' ')
    .toLowerCase()
  return needle
    .toLowerCase()
    .split(/\s+/)
    .every(word => hay.includes(word))
}

export function RunsPage() {
  const { state } = useRunStream()
  const loc = useLocation()
  const suite = loc.query.get('suite') ?? ''
  const status = loc.query.get('status') ?? ''
  const scenario = loc.query.get('scenario') ?? ''
  const tag = loc.query.get('tag') ?? ''
  const [search, setSearch] = useState('')
  const [shown, setShown] = useState(PAGE)

  const setFilter = (key: string, value: string) => {
    const q: Record<string, string | undefined> = { suite, status, scenario, tag, [key]: value }
    loc.navigate(href('/runs', q), { replace: true })
    setShown(PAGE)
  }

  const suites = useAsync(() => api.suites(200), [state.refreshTick])
  const base = useAsync(() => api.runs({ limit: 1000 }), [state.refreshTick])
  const hasServerFilter = suite !== '' || status !== '' || scenario !== '' || tag !== ''
  const filtered = useAsync(
    () => (hasServerFilter ? api.runs({ suite, status, scenario, tag, limit: 1000 }) : Promise.resolve(null)),
    [suite, status, scenario, tag, state.refreshTick],
  )
  const result = hasServerFilter ? filtered : base
  const rows = result.data?.runs ?? []
  const visible = useMemo(() => rows.filter(r => matches(r, search.trim())), [rows, search])

  const scenarioOptions = useMemo(() => [...new Set((base.data?.runs ?? []).map(r => r.scenarioId))].sort(), [base.data])
  const tagOptions = useMemo(() => [...new Set((base.data?.runs ?? []).flatMap(r => r.tags))].sort(), [base.data])

  return (
    <>
      <PageHead title="Runs" sub="Every saved suite, then the runs inside them. Open a run to read the transcript and the verdicts." />
      <Warnings items={[...(suites.data?.warnings ?? []), ...(base.data?.warnings ?? [])]} title="Some files were skipped" />

      <div className="section-header" style={{ marginTop: '0.5rem' }}>
        <h2 className="section-title">Suites</h2>
        {suite ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFilter('suite', '')}>Show runs from all suites</button> : null}
      </div>
      {suites.loading && !suites.data ? <Loading label="Loading suites" /> : null}
      {suites.error && !suites.data ? <ErrorState error={suites.error} onRetry={suites.reload} title="Could not load suites" /> : null}
      {suites.data ? (
        suites.data.suites.length === 0 ? (
          <div className="card"><EmptyState title="No suites yet" commands={'npx evals run ./scenarios'}>Each run of your scenarios is saved as a suite.</EmptyState></div>
        ) : (
          <SuiteTable suites={suites.data.suites} selected={suite} onSelect={id => setFilter('suite', id === suite ? '' : id)} />
        )
      ) : null}

      <div className="section-header">
        <h2 className="section-title">Runs</h2>
        <span className="section-note">{suite ? `In suite ${suite}` : 'Across the newest suites'}</span>
      </div>
      <form className="filters" role="search" onSubmit={e => e.preventDefault()}>
        <div className="form-group wide">
          <label className="form-label" htmlFor="run-search">Search</label>
          <input id="run-search" className="form-input" type="search" placeholder="Scenario, criterion, error, model" value={search} onChange={e => { setSearch(e.target.value); setShown(PAGE) }} />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="f-status">Status</label>
          <select id="f-status" className="form-select" value={status} onChange={e => setFilter('status', e.target.value)}>
            <option value="">All</option>
            <option value="pass">Pass</option>
            <option value="fail">Fail</option>
            <option value="error">Error</option>
          </select>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="f-scenario">Scenario</label>
          <select id="f-scenario" className="form-select" value={scenario} onChange={e => setFilter('scenario', e.target.value)}>
            <option value="">All</option>
            {scenarioOptions.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="f-tag">Tag</label>
          <select id="f-tag" className="form-select" value={tag} onChange={e => setFilter('tag', e.target.value)}>
            <option value="">All</option>
            {tagOptions.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </form>

      {result.loading && !result.data ? <Loading label="Loading runs" /> : null}
      {result.error && !result.data ? <ErrorState error={result.error} onRetry={result.reload} title="Could not load runs" /> : null}
      {result.data ? (
        <div className="card" style={{ padding: 0 }}>
          <div className="run-list-head">
            <span className="run-list-count" aria-live="polite">
              {plural(visible.length, 'run')}
              {visible.length !== result.data.total ? ` of ${result.data.total}` : ''}
            </span>
            {hasServerFilter || search ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setSearch(''); loc.navigate(href('/runs'), { replace: true }) }}>Clear filters</button>
            ) : null}
          </div>
          {visible.length === 0 ? (
            <EmptyState title={rows.length === 0 && !hasServerFilter ? 'No runs yet' : 'No runs match'}>
              {rows.length === 0 && !hasServerFilter ? 'Run your scenarios and they appear here.' : 'Change or clear the filters to see more.'}
            </EmptyState>
          ) : (
            <>
              <RunTable runs={visible.slice(0, shown)} />
              {visible.length > shown ? (
                <div style={{ padding: '0.9rem', textAlign: 'center' }}>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShown(n => n + PAGE)}>Show {Math.min(PAGE, visible.length - shown)} more</button>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </>
  )
}

function SuiteTable({ suites, selected, onSelect }: { suites: SuiteListItem[]; selected: string; onSelect(id: string): void }) {
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Suite</th>
              <th>State</th>
              <th>Started</th>
              <th>Runs</th>
              <th>Pass / fail / error</th>
              <th>Goal</th>
              <th>Cost</th>
              <th>Command</th>
            </tr>
          </thead>
          <tbody>
            {suites.map(s => (
              <tr key={s.suiteId} className="run-row" style={selected === s.suiteId ? { background: 'var(--accent-tint)' } : undefined}>
                <td>
                  <button type="button" className="link-btn mono break" aria-pressed={selected === s.suiteId} onClick={() => onSelect(s.suiteId)} title="Show only this suite's runs">
                    {s.suiteId}
                  </button>
                </td>
                <td><SuiteStateBadge state={s.state} /></td>
                <td className="small">{shortDate(s.startedAt)}</td>
                <td className="num">{s.summary.runs}</td>
                <td className="num small">{s.summary.pass} / {s.summary.fail} / {s.summary.error}</td>
                <td className="num small">{s.summary.goal.total === 0 ? 'n/a' : percent(s.summary.goal.achieved / s.summary.goal.total)}</td>
                <td className="num small">{usd(s.summary.costUsd)}</td>
                <td className="mono small break muted">{s.command}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
