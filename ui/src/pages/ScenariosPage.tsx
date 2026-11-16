import { useEffect, useRef, useState } from 'react'
import type { RubricItem, RubricUpdateResponse, ScenarioItem } from '../../../src/ui/api-types'
import { api } from '../api/client'
import { useAsync } from '../api/useAsync'
import { LabelImpactLine, RubricEditor } from '../components/RubricEditor'
import { Banner, CriticalMarker, Disclosure, EmptyState, ErrorState, JsonBlock, Loading, PageHead, StatusBadge, Tabs, TagList, VerdictBadge, Warnings } from '../components/ui'
import { plural } from '../lib/format'

// Scenarios and rubrics are files in a repository, reviewed like code, so this
// page shows them and what is wrong with them. A rubric can be edited here, to
// close the loop from a disagreement in Classify or Calibration to the rule the
// judge followed. The edit writes the rubric's own file, so it is reviewed with
// git diff like any other change. Scenarios are read-only.

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

const SAFE_CRITERION = /^[a-z0-9][a-z0-9._-]*$/

function RubricCard({ item, focus, onSaved, onReload }: { item: RubricItem; focus?: string; onSaved(res: RubricUpdateResponse): void; onReload(): void }) {
  const r = item.rubric
  const [editing, setEditing] = useState(false)
  const [saved, setSaved] = useState<RubricUpdateResponse | null>(null)
  const box = useRef<HTMLDetailsElement>(null)

  // A deep link opens the card and brings the criterion into view.
  useEffect(() => {
    if (!focus || !box.current) return
    box.current.open = true
    if (!SAFE_CRITERION.test(focus)) return
    const el = box.current.querySelector<HTMLElement>(`[data-criterion="${focus}"]`)
    el?.scrollIntoView?.({ block: 'center' })
  }, [focus, editing])

  if (editing) {
    return (
      <details className="disclosure" ref={box} open>
        <summary>
          <span className="verdict-name">{r.id}</span>
          <span className="small muted">version {r.version}</span>
          <span className="badge badge-accent">Editing</span>
        </summary>
        <div className="disclosure-body">
          <RubricEditor
            item={item}
            focus={focus}
            onSaved={res => {
              setSaved(res)
              setEditing(false)
              onSaved(res)
            }}
            onCancel={() => setEditing(false)}
            onReload={() => {
              setEditing(false)
              onReload()
            }}
          />
        </div>
      </details>
    )
  }

  return (
    <details className="disclosure" ref={box}>
      <summary>
        <span className="verdict-name">{r.id}</span>
        <span className="small muted">version {r.version}</span>
        <span className="small muted">{plural(r.criteria.length, 'criterion', 'criteria')}, {plural(r.anchors.length, 'anchor')}</span>
      </summary>
      <div className="disclosure-body stack">
        {saved ? (
          <Banner kind="success" title={`Saved as version ${saved.version}.`} role="status">
            The change is in <span className="mono break">{saved.item.relativeFile}</span>. Review it with git diff like any other change.
            {saved.labelImpact.filter(x => x.labels > 0).map(x => <LabelImpactLine key={x.criterion} {...x} />)}
          </Banner>
        ) : null}
        {saved ? <Warnings items={saved.warnings} /> : null}
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <dl className="facts" style={{ margin: 0 }}>
            <dt>File</dt><dd className="break" title={item.file}>{item.relativeFile}</dd>
            <dt>Used by</dt><dd>{item.usedBy.length === 0 ? 'No scenario' : item.usedBy.join(', ')}</dd>
          </dl>
          <button type="button" className="btn btn-ghost btn-sm" aria-label={`Edit ${r.id}`} onClick={() => { setSaved(null); setEditing(true) }}>Edit</button>
        </div>
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
              <div className={`verdict-item${focus === c.id ? ' highlight' : ''}`} key={c.id} data-criterion={c.id}>
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
                <div className={`card-sm${focus !== undefined && a.criterion === focus ? ' highlight' : ''}`} key={i}>
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
const isTab = (t: string | null | undefined): t is Tab => t === 'scenarios' || t === 'rubrics' || t === 'validation'

/** What the address asked for: `#/scenarios?tab=rubrics&rubric=<id>&criterion=<id>`. */
export interface ScenariosLink {
  tab?: string | null
  rubric?: string | null
  criterion?: string | null
}

const linkTab = (link: ScenariosLink): Tab | null => (isTab(link.tab) ? link.tab : link.rubric || link.criterion ? 'rubrics' : null)

export function ScenariosPage({ link = {} }: { link?: ScenariosLink } = {}) {
  const scenarios = useAsync(() => api.scenarios(), [])
  const rubrics = useAsync(() => api.rubrics(), [])
  const [tab, setTab] = useState<Tab>(() => linkTab(link) ?? 'scenarios')

  // A new deep link while the page is open.
  useEffect(() => {
    const t = linkTab(link)
    if (t) setTab(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link.tab, link.rubric, link.criterion])

  // The rubric a link points at: by id, or the first that has the criterion.
  const items = rubrics.data?.rubrics ?? []
  const criterion = link.criterion || undefined
  const target = link.rubric ? items.find(i => i.rubric.id === link.rubric) : criterion ? items.find(i => i.rubric.criteria.some(c => c.id === criterion)) : undefined
  const linkProblem = !rubrics.data || (!link.rubric && !criterion)
    ? null
    : !target
      ? link.rubric ? `There is no rubric "${link.rubric}".` : `No rubric has a criterion "${criterion}".`
      : criterion && !target.rubric.criteria.some(c => c.id === criterion)
        ? `Rubric "${target.rubric.id}" has no criterion "${criterion}".`
        : null

  const onSaved = (res: RubricUpdateResponse) =>
    rubrics.setData(prev => (prev ? { ...prev, rubrics: prev.rubrics.map(i => (i.file === res.item.file ? res.item : i)) } : prev))

  const problemCount = (scenarios.data?.validation.errors.length ?? 0) + (rubrics.data?.problems.length ?? 0)
  const warningCount = scenarios.data?.validation.warnings.length ?? 0

  return (
    <>
      <PageHead
        title="Scenarios"
        sub="The scenarios and rubrics the server reads. They are files in your repository. Edits to a rubric made here write to that file, so they show up in git diff for review like any other change."
      />
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
            <div className="stack-sm">
              {linkProblem ? <Banner kind="info" role="status">{linkProblem}</Banner> : null}
              {items.map(i => (
                <RubricCard
                  key={i.file + i.rubric.id}
                  item={i}
                  focus={i === target && criterion && i.rubric.criteria.some(c => c.id === criterion) ? criterion : undefined}
                  onSaved={onSaved}
                  onReload={rubrics.reload}
                />
              ))}
            </div>
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
