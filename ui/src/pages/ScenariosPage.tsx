import { useState } from 'react'
import type { RubricItem, ScenarioItem } from '../../../src/ui/api-types'
import { api } from '../api/client'
import { useAsync } from '../api/useAsync'
import { Banner, CriticalMarker, Disclosure, EmptyState, ErrorState, JsonBlock, Loading, PageHead, StatusBadge, Tabs, TagList, VerdictBadge } from '../components/ui'
import { plural } from '../lib/format'

// Read-only. Scenarios and rubrics are files in a repository, reviewed like
// code, so this page shows them and what is wrong with them. It edits nothing.

function ScenarioCard({ item }: { item: ScenarioItem }) {
  const s = item.scenario
  const calls = item.needs.simulatorCalls + item.needs.rubricCalls + item.needs.goalCalls
  return (
    <details className="disclosure">
      <summary>
        <span className="verdict-name">{s.id}</span>
        <span className="small muted">v{s.version}</span>
        {item.needsModel ? <span className="badge badge-warning">Up to {plural(calls, 'model call')}</span> : <span className="badge badge-pass">Checks only</span>}
      </summary>
      <div className="disclosure-body stack">
        <dl className="facts">
          <dt>Mode</dt><dd>{s.mode}</dd>
          <dt>Target</dt><dd>{s.target}</dd>
          <dt>Max turns</dt><dd>{s.max_turns}</dd>
          <dt>Rubric</dt><dd>{item.rubricId ?? 'None'}</dd>
          <dt>File</dt><dd className="break">{item.file}</dd>
          <dt>Calls, at most</dt><dd>simulator {item.needs.simulatorCalls}, rubric {item.needs.rubricCalls}, goal {item.needs.goalCalls}</dd>
        </dl>
        <TagList tags={s.tags} />
        {s.persona ? <div className="crit-box"><h4>Persona</h4>{s.persona}</div> : null}
        {s.seed_message ? <div className="crit-box"><h4>Seed message</h4>{s.seed_message}</div> : null}
        {s.goal ? <div className="crit-box"><h4>Goal</h4>{s.goal}</div> : null}
        {s.input !== undefined ? (
          <div>
            <div className="review-label">Input</div>
            <JsonBlock value={s.input} label="Scenario input" />
          </div>
        ) : null}
        <div>
          <div className="review-label">Checks ({s.checks.length})</div>
          {s.checks.length === 0 ? (
            <p className="small muted">None.</p>
          ) : (
            <div className="verdict-list">
              {s.checks.map((c, i) => (
                <div className="verdict-item" key={i}>
                  <div className="verdict-name">{c.type}</div>
                  <pre className="json" style={{ marginTop: '0.4rem' }}>{JSON.stringify(Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'type')), null, 2)}</pre>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </details>
  )
}

function RubricCard({ item }: { item: RubricItem }) {
  const r = item.rubric
  return (
    <details className="disclosure">
      <summary>
        <span className="verdict-name">{r.id}</span>
        <span className="small muted">version {r.version}</span>
        <span className="small muted">{plural(r.criteria.length, 'criterion', 'criteria')}, {plural(r.anchors.length, 'anchor')}</span>
      </summary>
      <div className="disclosure-body stack">
        <dl className="facts">
          <dt>File</dt><dd className="break">{item.file}</dd>
          <dt>Used by</dt><dd>{item.usedBy.length === 0 ? 'No scenario' : item.usedBy.join(', ')}</dd>
        </dl>
        {r.context ? (
          <div>
            <div className="review-label">Reference facts (shown to the judge as ground truth)</div>
            <div className="crit-box" style={{ whiteSpace: 'pre-wrap' }}>{r.context}</div>
          </div>
        ) : null}
        <div>
          <div className="review-label">Criteria</div>
          <div className="verdict-list">
            {r.criteria.map(c => (
              <div className="verdict-item" key={c.id}>
                <div className="verdict-top">
                  <span className="verdict-name">{c.id}</span>
                  {c.critical ? <CriticalMarker /> : null}
                  <span className="crit-meta" style={{ marginLeft: 'auto' }}>weight {c.weight}</span>
                </div>
                <div className="verdict-body">{c.text}</div>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="review-label">Anchors (few-shot examples shown to the judge)</div>
          {r.anchors.length === 0 ? (
            <p className="small muted">None.</p>
          ) : (
            <div className="stack-sm">
              {r.anchors.map((a, i) => (
                <div className="card-sm" key={i}>
                  <div className="row" style={{ marginBottom: '0.4rem' }}>
                    <VerdictBadge verdict={a.verdict} />
                    <span className="small mono">{a.criterion ?? 'whole rubric'}</span>
                  </div>
                  {a.input ? <div className="crit-box" style={{ marginBottom: '0.4rem' }}><h4>Input</h4>{a.input}</div> : null}
                  <div className="crit-box" style={{ marginBottom: '0.4rem' }}><h4>Output</h4>{a.output}</div>
                  <div className="crit-box"><h4>Critique</h4>{a.critique}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </details>
  )
}

type Tab = 'scenarios' | 'rubrics' | 'validation'

export function ScenariosPage() {
  const scenarios = useAsync(() => api.scenarios(), [])
  const rubrics = useAsync(() => api.rubrics(), [])
  const [tab, setTab] = useState<Tab>('scenarios')

  const problemCount = (scenarios.data?.validation.errors.length ?? 0) + (rubrics.data?.problems.length ?? 0)
  const warningCount = scenarios.data?.validation.warnings.length ?? 0

  return (
    <>
      <PageHead title="Scenarios" sub="The scenarios and rubrics the server reads. They are files in your repository, so this page only shows them." />
      {problemCount > 0 ? (
        <div style={{ marginBottom: '1rem' }}>
          <Banner kind="danger" title={`${plural(problemCount, 'problem')} found.`} role="alert">
            Anything listed under Validation would stop a run.
          </Banner>
        </div>
      ) : null}
      <Tabs<Tab>
        label="Scenario views"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'scenarios', label: `Scenarios${scenarios.data ? ` (${scenarios.data.scenarios.length})` : ''}` },
          { id: 'rubrics', label: `Rubrics${rubrics.data ? ` (${rubrics.data.rubrics.length})` : ''}` },
          { id: 'validation', label: `Validation${problemCount + warningCount > 0 ? ` (${problemCount + warningCount})` : ''}` },
        ]}
      />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'scenarios' ? (
          scenarios.loading && !scenarios.data ? (
            <Loading label="Loading scenarios" />
          ) : scenarios.error && !scenarios.data ? (
            <ErrorState error={scenarios.error} onRetry={scenarios.reload} title="Could not load scenarios" />
          ) : scenarios.data && scenarios.data.scenarios.length === 0 ? (
            <div className="card"><EmptyState title="No scenarios found">{scenarios.data.path ? 'The path has no scenario files, or none of them parsed. See Validation.' : 'The server has no scenarios path. Start it with a path, or from a directory that has ./scenarios.'}</EmptyState></div>
          ) : (
            <div className="stack-sm">
              {scenarios.data?.path ? <div className="small muted">Path: <span className="mono break">{scenarios.data.path}</span></div> : null}
              {scenarios.data?.scenarios.map(i => <ScenarioCard key={i.file + i.scenario.id} item={i} />)}
            </div>
          )
        ) : null}

        {tab === 'rubrics' ? (
          rubrics.loading && !rubrics.data ? (
            <Loading label="Loading rubrics" />
          ) : rubrics.error && !rubrics.data ? (
            <ErrorState error={rubrics.error} onRetry={rubrics.reload} title="Could not load rubrics" />
          ) : rubrics.data && rubrics.data.rubrics.length === 0 ? (
            <div className="card"><EmptyState title="No rubrics found">Scenarios refer to a rubric file with the rubric key.</EmptyState></div>
          ) : (
            <div className="stack-sm">{rubrics.data?.rubrics.map(i => <RubricCard key={i.file + i.rubric.id} item={i} />)}</div>
          )
        ) : null}

        {tab === 'validation' ? (
          <div className="stack">
            {scenarios.error && !scenarios.data ? <ErrorState error={scenarios.error} onRetry={scenarios.reload} title="Could not validate" /> : null}
            {scenarios.data ? (
              <>
                <section>
                  <h2 className="section-title" style={{ marginBottom: '0.5rem' }}>Errors</h2>
                  {scenarios.data.validation.errors.length === 0 ? (
                    <div className="card-sm"><StatusBadge status="pass" label="No errors" /> <span className="small muted">The same checks as evals validate found nothing that would stop a run.</span></div>
                  ) : (
                    <div className="verdict-list">
                      {scenarios.data.validation.errors.map((e, i) => (
                        <div className="verdict-item" key={i}><div className="verdict-top"><StatusBadge status="fail" label="Error" /></div><div className="verdict-body">{e}</div></div>
                      ))}
                    </div>
                  )}
                </section>
                {scenarios.data.validation.warnings.length > 0 ? (
                  <section>
                    <h2 className="section-title" style={{ marginBottom: '0.5rem' }}>Warnings</h2>
                    <div className="verdict-list">
                      {scenarios.data.validation.warnings.map((e, i) => (
                        <div className="verdict-item" key={i}><div className="verdict-top"><StatusBadge status="error" label="Warning" /></div><div className="verdict-body">{e}</div></div>
                      ))}
                    </div>
                  </section>
                ) : null}
                <section>
                  <h2 className="section-title" style={{ marginBottom: '0.5rem' }}>Environment variables the targets use</h2>
                  {scenarios.data.validation.envRefs.length === 0 ? (
                    <div className="card-sm muted">The targets refer to no environment variables.</div>
                  ) : (
                    <div className="card" style={{ padding: 0 }}>
                      <div className="table-wrap">
                        <table>
                          <thead><tr><th>Name</th><th>Used by</th><th>State</th></tr></thead>
                          <tbody>
                            {scenarios.data.validation.envRefs.map(r => (
                              <tr key={r.name}>
                                <td className="mono small">{r.name}</td>
                                <td className="small">{r.targets.join(', ')}</td>
                                <td>{r.isSet ? <span className="badge badge-pass">Set</span> : <span className="badge badge-warning">Not set</span>}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                  <p className="small muted" style={{ marginTop: '0.4rem' }}>Only names and whether each is set. Values are never sent to this page.</p>
                </section>
              </>
            ) : null}
            {rubrics.data && rubrics.data.problems.length > 0 ? (
              <section>
                <h2 className="section-title" style={{ marginBottom: '0.5rem' }}>Rubric problems</h2>
                <div className="verdict-list">
                  {rubrics.data.problems.map((p, i) => (
                    <div className="verdict-item" key={i}><div className="verdict-top"><StatusBadge status="fail" label="Problem" /></div><div className="verdict-body">{p}</div></div>
                  ))}
                </div>
              </section>
            ) : null}
            <Disclosure title="What these checks cover">
              <p>The same checks as <span className="mono">evals validate</span>: files that do not parse, duplicate ids, unknown targets, targets of a kind that cannot run yet, tool-call mappings, and the environment variables the targets use.</p>
            </Disclosure>
          </div>
        ) : null}
      </div>
    </>
  )
}
