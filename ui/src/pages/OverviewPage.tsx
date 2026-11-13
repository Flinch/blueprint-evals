import { api } from '../api/client'
import { useAsync } from '../api/useAsync'
import { OutcomeBar, TrendChart } from '../components/charts'
import { Banner, Disclosure, EmptyState, ErrorState, Loading, PageHead, Tile, Warnings } from '../components/ui'
import { count, percent, plural, score, shortDate, usd } from '../lib/format'
import { href } from '../lib/router'
import { useHealth } from '../state/HealthContext'
import { useRunStream } from '../state/RunStreamProvider'

const EMPTY_COMMANDS = `npx evals validate ./scenarios
npx evals run ./scenarios
npx evals ui`

export function OverviewPage() {
  const { state } = useRunStream()
  const { health } = useHealth()
  const overview = useAsync(() => api.overview(100), [state.refreshTick])
  const o = overview.data

  return (
    <>
      <PageHead title="Overview" sub="How your agent is doing across saved runs. The goal-achieved rate comes first: it says whether the agent did what the scenario asked." />
      {overview.loading && !o ? <Loading label="Loading the overview" /> : null}
      {overview.error && !o ? <ErrorState error={overview.error} onRetry={overview.reload} title="Could not load the overview" /> : null}

      {o ? (
        <>
          <Warnings items={o.warnings} title="Some files were skipped" />
          {o.runs === 0 ? (
            <div className="card">
              <EmptyState title="No runs yet" commands={EMPTY_COMMANDS}>
                Run your scenarios from a terminal, or from the Run page, and they show up here.
                {health.demo ? ' This demo workdir should have runs. Re-run npm run ui:demo to rebuild it.' : ''}
              </EmptyState>
            </div>
          ) : (
            <>
              <div className="stats-row" aria-label="Headline numbers">
                <Tile
                  lead
                  label="Goal achieved"
                  value={percent(o.goal.rate)}
                  sub={o.goal.total > 0 ? `${o.goal.achieved} of ${plural(o.goal.total, 'run')} with a goal check` : 'No run had a goal check'}
                />
                <Tile label="Pass rate" value={percent(o.runs === 0 ? null : o.counts.pass / o.runs)} sub={`${o.counts.pass} pass, ${o.counts.fail} fail, ${o.counts.error} error`} />
                <Tile label="Runs" value={count(o.runs)} sub={`${plural(o.suites.considered, 'suite')} shown of ${count(o.suites.total)}`} />
                <Tile
                  label="Total cost"
                  value={o.cost.totalUsd === null ? 'Unknown' : usd(o.cost.totalUsd)}
                  sub={
                    o.cost.totalUsd === null
                      ? `${usd(o.cost.knownUsd)} known. ${plural(o.cost.runsWithUnknownCost, 'run')} had no price in the config.`
                      : `${count(o.cost.inputTokens)} tokens in, ${count(o.cost.outputTokens)} out`
                  }
                />
              </div>

              <div className="section-header">
                <h2 className="section-title">Trend across suites</h2>
                <span className="section-note">Oldest on the left. A gap means that suite had no value for the rate.</span>
              </div>
              <div className="card">
                <TrendChart points={o.trend} />
                <div style={{ marginTop: '1rem' }}>
                  <Disclosure title="Show the numbers as a table">
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Suite</th>
                            <th>Started</th>
                            <th>Runs</th>
                            <th>Goal</th>
                            <th>Pass</th>
                            <th>Avg score</th>
                            <th>Cost</th>
                          </tr>
                        </thead>
                        <tbody>
                          {o.trend.map(t => (
                            <tr key={t.suiteId}>
                              <td className="mono break"><a href={href('/runs', { suite: t.suiteId })}>{t.suiteId}</a></td>
                              <td>{shortDate(t.startedAt)}</td>
                              <td className="num">{t.runs}</td>
                              <td className="num">{percent(t.goalRate)}</td>
                              <td className="num">{percent(t.passRate)}</td>
                              <td className="num">{score(t.avgScore)}</td>
                              <td className="num">{usd(t.costUsd)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Disclosure>
                </div>
              </div>

              <div className="section-header">
                <h2 className="section-title">Failures by scenario tag</h2>
              </div>
              <div className="card">
                {o.failuresByTag.length === 0 ? (
                  <p className="muted">No scenario in these runs has a tag.</p>
                ) : (
                  <div>
                    {o.failuresByTag.map(t => (
                      <div className="bar-row" key={t.tag}>
                        <a className="bar-label" href={href('/runs', { tag: t.tag })} title={t.tag}>{t.tag}</a>
                        <OutcomeBar pass={t.pass} fail={t.fail} error={t.error} label={t.tag} />
                        <span className="num small muted">{t.fail + t.error} of {t.runs} not passing</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="section-header">
                <h2 className="section-title">Most common failing criteria</h2>
                <span className="section-note">Graded criteria the judge failed, most failures first. Runs where a criterion was N/A are not counted.</span>
              </div>
              <div className="verdict-list">
                {o.topFailingCriteria.length === 0 ? (
                  <div className="verdict-item muted">The judge failed no criteria in these runs.</div>
                ) : (
                  o.topFailingCriteria.map(c => (
                    <div className="verdict-item" key={c.criterion}>
                      <div className="verdict-top">
                        <span className="verdict-name">{c.criterion}</span>
                        {c.critical ? <span className="badge badge-critical">Critical</span> : null}
                        <span className="num small muted" style={{ marginLeft: 'auto' }}>
                          failed {c.failures} of {c.judged} ({percent(c.failureRate)})
                        </span>
                      </div>
                      <div className="small muted" style={{ marginTop: '0.3rem' }}>
                        Scenarios: {c.scenarios.join(', ')}
                        {c.notApplicable > 0 ? <> &middot; N/A in {plural(c.notApplicable, 'run')}</> : null}
                      </div>
                    </div>
                  ))
                )}
              </div>

              {o.topFailingChecks.length > 0 ? (
                <>
                  <div className="section-header">
                    <h2 className="section-title">Most common failing checks</h2>
                    <span className="section-note">Deterministic checks. These are exact, so a failure is a real finding.</span>
                  </div>
                  <div className="verdict-list">
                    {o.topFailingChecks.map(c => (
                      <div className="verdict-item" key={c.grader}>
                        <div className="verdict-top">
                          <span className="verdict-name">{c.grader}</span>
                          <span className="num small muted" style={{ marginLeft: 'auto' }}>{plural(c.failures, 'failure')}</span>
                        </div>
                        <div className="small muted" style={{ marginTop: '0.3rem' }}>Scenarios: {c.scenarios.join(', ')}</div>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}

              {o.suites.considered < o.suites.total ? (
                <div style={{ marginTop: '1.25rem' }}>
                  <Banner kind="info">Numbers cover the newest {o.suites.considered} of {o.suites.total} suites.</Banner>
                </div>
              ) : null}
            </>
          )}
        </>
      ) : null}
    </>
  )
}
