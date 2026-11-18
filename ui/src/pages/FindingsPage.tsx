import { useState } from 'react'
import type {
  CriterionFindings, FindingsFilters, FindingsResponse, FindingsSummaryPreviewResponse, FindingsSummaryRecord, FindingsSummaryRequest,
} from '../../../src/ui/api-types'
import { ApiFailure, api, describeError } from '../api/client'
import { useAsync } from '../api/useAsync'
import { Banner, ConfirmDialog, CriticalMarker, EmptyState, ErrorState, Loading, PageHead, Warnings } from '../components/ui'
import { fullDate, plural, shortDate, tokens, usd } from '../lib/format'
import { criterionHref, href, runHref } from '../lib/router'
import { LaunchError } from './LaunchPage'

// The findings report: every reply a person labelled fail, with their critique,
// grouped by criterion, for the developers fixing the assistant. Judge failures
// nobody has reviewed are counted and left out. The optional AI draft ("Suggest
// fixes") never runs on one click: the server previews it (findings, model,
// estimated cost) and a dialog asks before the one model call is made.

/** The filters in words, the same way the Markdown says them. */
export function filtersText(f: FindingsFilters): string {
  return [
    f.since ? `runs since ${f.since.slice(0, 10)}` : 'all saved runs',
    f.rubric ? `rubric ${f.rubric}` : 'every rubric',
    f.criterion ? `criterion ${f.criterion}` : 'every criterion',
  ].join(', ')
}

const clean = (f: FindingsSummaryRequest): FindingsSummaryRequest => ({
  ...(f.since ? { since: f.since } : {}),
  ...(f.rubric ? { rubric: f.rubric } : {}),
  ...(f.criterion ? { criterion: f.criterion } : {}),
})

function saveText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function Draft({ draft }: { draft: NonNullable<FindingsResponse['summary']> }) {
  const r: FindingsSummaryRecord = draft.record
  return (
    <section className="card stack" aria-label="Suggested fixes">
      <div className="row">
        <h2 className="section-title" style={{ margin: 0 }}>Suggested fixes (AI draft, review before use)</h2>
        <span className="badge badge-warning">Draft</span>
      </div>
      <p className="small muted">
        Drafted by {r.model.model} on {fullDate(r.at)} from {plural(r.findings, 'finding')}, for {usd(r.usage.costUsd)}. This is a draft: check each proposal against the findings below before anyone acts on it.
      </p>
      {draft.current ? null : (
        <Banner kind="warning" role="status">The findings changed since this draft was written. Suggest fixes again for a draft that matches them.</Banner>
      )}
      <Warnings items={r.warnings} title="Notes on this draft" />
      {r.fixes.length === 0 ? <p className="small">The draft has no proposals.</p> : null}
      {r.fixes.map(fix => (
        <article key={fix.criterion} className="card-sm">
          <h3 className="sub-title mono">{fix.criterion}</h3>
          <p><strong>Pattern.</strong> {fix.pattern}</p>
          <p><strong>Proposed change.</strong> {fix.proposedChange}</p>
          {fix.itemIds.length > 0 ? <p className="small muted break">Based on: {fix.itemIds.join(', ')}</p> : null}
        </article>
      ))}
    </section>
  )
}

function CriterionSection({ c }: { c: CriterionFindings }) {
  return (
    <details className="disclosure" open aria-label={`Findings for ${c.criterion}`}>
      <summary>
        <span className="mono">{c.criterion}</span> {c.critical ? <CriticalMarker /> : null}{' '}
        <span className="small muted">{c.failed} of {plural(c.labelled, 'labelled reply', 'labelled replies')} failed</span>
      </summary>
      <div className="disclosure-body stack">
        <div className="crit-box">
          <h4>Rule{c.rubricId ? ` (rubric ${c.rubricId}, version ${c.rubricVersion})` : ''}</h4>
          {c.text ?? <span className="muted">No loaded rubric has this criterion, so its wording is not shown.</span>}
        </div>
        <a className="small" href={criterionHref(c.criterion, c.rubricId)}>View or edit this criterion</a>
        {c.findings.map((f, i) => (
          <article key={f.itemId} className="card-sm stack" aria-label={`Finding ${i + 1} for ${c.criterion}`}>
            <div className="row">
              <strong>{i + 1}. {f.scenarioId}</strong>
              <span className="small muted">run of {shortDate(f.startedAt)}</span>
              {f.revised ? <span className="badge badge-accent" title="Changed after the first label, possibly after seeing the judge">Revised</span> : null}
              <a className="small" href={runHref(f.runId)} style={{ marginLeft: 'auto' }}>Open the run</a>
            </div>
            <div className="crit-box"><h4>User message</h4>{f.userMessage || <span className="muted">None</span>}</div>
            <blockquote className="crit-box finding-reply"><h4>Assistant reply</h4>{f.output}</blockquote>
            <div className="crit-box"><h4>Critique by {f.labeler}, {shortDate(f.labelledAt)}</h4>{f.critique}</div>
          </article>
        ))}
      </div>
    </details>
  )
}

export function FindingsPage({ initial = {}, onFilters }: { initial?: FindingsSummaryRequest; onFilters?(f: FindingsSummaryRequest): void }) {
  const [filters, setFilters] = useState<FindingsSummaryRequest>(() => clean(initial))
  const key = JSON.stringify(filters)
  const report = useAsync(() => api.findings(filters), [key])
  const rubrics = useAsync(() => api.rubrics(), [])
  const [notice, setNotice] = useState<{ kind: 'success' | 'danger'; text: string } | null>(null)
  const [exporting, setExporting] = useState<'download' | 'copy' | null>(null)
  const [preview, setPreview] = useState<{ response: FindingsSummaryPreviewResponse; request: FindingsSummaryRequest } | null>(null)
  const [busy, setBusy] = useState<'preview' | 'start' | null>(null)
  const [changed, setChanged] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const update = (next: FindingsSummaryRequest) => {
    const c = clean(next)
    setFilters(c)
    setNotice(null)
    setError(null)
    onFilters?.(c)
  }

  const allRubrics = rubrics.data?.rubrics ?? []
  const criterionChoices = [...new Set(allRubrics.filter(r => !filters.rubric || r.rubric.id === filters.rubric).flatMap(r => r.rubric.criteria.map(c => c.id)))].sort()

  const exportMarkdown = async (how: 'download' | 'copy') => {
    setExporting(how)
    setNotice(null)
    try {
      const text = await api.findingsMarkdown(filters)
      if (how === 'download') {
        saveText(`findings-${(report.data?.generatedAt ?? new Date().toISOString()).slice(0, 10)}.md`, text)
        setNotice({ kind: 'success', text: 'The report was downloaded as Markdown.' })
      } else {
        await navigator.clipboard.writeText(text)
        setNotice({ kind: 'success', text: 'The report was copied as Markdown.' })
      }
    } catch (e) {
      setNotice({ kind: 'danger', text: how === 'copy' && !(e instanceof ApiFailure) ? 'The browser did not allow copying. Use Download Markdown instead.' : describeError(e) })
    } finally {
      setExporting(null)
    }
  }

  const askToSummarise = async () => {
    setBusy('preview')
    setError(null)
    setChanged(false)
    try {
      const response = await api.findingsSummaryPreview(filters)
      if (!response.anyModelCalls) {
        setNotice({ kind: 'danger', text: 'There are no findings in this filter, so there is nothing to summarise.' })
      } else {
        setPreview({ response, request: filters })
      }
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
    }
  }

  const summarise = async () => {
    if (!preview) return
    setBusy('start')
    try {
      await api.findingsSummary({ ...preview.request, previewToken: preview.response.previewToken, confirm: true })
      setPreview(null)
      setChanged(false)
      setNotice({ kind: 'success', text: 'The draft was written and saved. Review it before anyone acts on it.' })
      report.reload()
    } catch (e) {
      if (e instanceof ApiFailure && e.code === 'preview_token_invalid') {
        try {
          const response = await api.findingsSummaryPreview(preview.request)
          setPreview({ response, request: preview.request })
          setChanged(true)
        } catch (e2) {
          setPreview(null)
          setError(e2)
        }
      } else {
        setPreview(null)
        setError(e)
      }
    } finally {
      setBusy(null)
    }
  }

  const data = report.data
  const pv = preview?.response

  return (
    <>
      <PageHead
        title="Findings"
        sub="Every reply a person labelled fail, with their critique, grouped by rule. Hand it to the developers fixing the assistant. Failures only the judge found are counted and left out until a person reviews them."
      />

      <form className="filters" aria-label="Filter the findings" onSubmit={e => e.preventDefault()}>
        <div className="form-group">
          <label className="form-label" htmlFor="f-since">Runs since</label>
          <input id="f-since" type="date" className="form-input" value={filters.since ?? ''} onChange={e => update({ ...filters, since: e.target.value })} />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="f-rubric">Rubric</label>
          <select id="f-rubric" className="form-select" value={filters.rubric ?? ''} onChange={e => update({ ...filters, rubric: e.target.value, criterion: undefined })}>
            <option value="">Every rubric</option>
            {allRubrics.map(r => <option key={r.rubric.id} value={r.rubric.id}>{r.rubric.id}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="f-criterion">Criterion</label>
          <select id="f-criterion" className="form-select" value={filters.criterion ?? ''} onChange={e => update({ ...filters, criterion: e.target.value })}>
            <option value="">Every criterion</option>
            {filters.criterion && !criterionChoices.includes(filters.criterion) ? <option value={filters.criterion}>{filters.criterion}</option> : null}
            {criterionChoices.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </form>

      <div className="row" style={{ marginBottom: '1rem' }}>
        <button type="button" className="btn btn-ghost" onClick={() => exportMarkdown('download')} disabled={exporting !== null || !data}>
          {exporting === 'download' ? <span className="spinner" aria-hidden="true" /> : null}
          Download Markdown
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => exportMarkdown('copy')} disabled={exporting !== null || !data}>
          {exporting === 'copy' ? <span className="spinner" aria-hidden="true" /> : null}
          Copy as Markdown
        </button>
        <button type="button" className="btn btn-primary" onClick={askToSummarise} disabled={busy !== null || !data || data.criteria.length === 0}>
          {busy === 'preview' ? <span className="spinner" aria-hidden="true" /> : null}
          Suggest fixes
        </button>
        <span className="small muted">Suggest fixes asks the judge model for a draft. You see the cost and confirm first.</span>
      </div>

      {notice ? <div style={{ marginBottom: '1rem' }}><Banner kind={notice.kind} role={notice.kind === 'danger' ? 'alert' : 'status'}>{notice.text}</Banner></div> : null}
      {error ? <div style={{ marginBottom: '1rem' }}><LaunchError error={error} /></div> : null}
      {busy === 'start' ? <div style={{ marginBottom: '1rem' }}><Loading label="Writing the draft. This can take a minute." /></div> : null}

      {report.loading && !data ? <Loading label="Loading the findings" /> : null}
      {report.error && !data ? <ErrorState error={report.error} onRetry={report.reload} title="Could not load the findings" /> : null}

      {data ? (
        <div className="stack">
          <p className="small muted">Showing {filtersText(data.filters)}. {data.totals.failed} of {plural(data.totals.labelled, 'labelled reply', 'labelled replies')} failed.</p>
          {data.unreviewedJudgeFailures > 0 ? (
            <Banner kind="info" role="status">
              {plural(data.unreviewedJudgeFailures, 'failure')} found by the judge {data.unreviewedJudgeFailures === 1 ? 'has' : 'have'} not been reviewed by a person yet, so {data.unreviewedJudgeFailures === 1 ? 'it is' : 'they are'} left out. This report covers verified findings only. <a href={href('/classify')}>Review them in Classify</a>.
            </Banner>
          ) : null}
          {data.notFromSavedRun > 0 ? (
            <p className="small muted">{plural(data.notFromSavedRun, 'label')} {data.notFromSavedRun === 1 ? 'is' : 'are'} for items that are not in the saved runs, so {data.notFromSavedRun === 1 ? 'it is' : 'they are'} left out.</p>
          ) : null}
          <Warnings items={data.warnings} />

          {data.summary ? <Draft draft={data.summary} /> : null}

          {data.criteria.length === 0 ? (
            <div className="card"><EmptyState title="No findings">No reply that a person labelled fail matches these filters.</EmptyState></div>
          ) : (
            <>
              <div className="card" style={{ padding: 0 }}>
                <div className="table-wrap">
                  <table aria-label="Findings by criterion">
                    <thead><tr><th>Criterion</th><th>Critical</th><th>Failed / labelled</th></tr></thead>
                    <tbody>
                      {data.criteria.map(c => (
                        <tr key={`${c.rubricId ?? ''}:${c.criterion}`}>
                          <td className="mono small">{c.criterion}</td>
                          <td>{c.critical ? <CriticalMarker /> : <span className="small muted">No</span>}</td>
                          <td className="num">{c.failed} / {c.labelled}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              {data.criteria.map(c => <CriterionSection key={`${c.rubricId ?? ''}:${c.criterion}`} c={c} />)}
            </>
          )}
        </div>
      ) : null}

      {pv && preview ? (
        <ConfirmDialog
          title="Draft suggested fixes with AI?"
          confirmLabel="Write the draft (1 model call)"
          onConfirm={summarise}
          onCancel={() => { setPreview(null); setChanged(false) }}
          busy={busy === 'start'}
        >
          {changed ? (
            <div style={{ marginBottom: '0.8rem' }}>
              <Banner kind="warning" role="alert">The findings changed since the preview. These are the new numbers. Confirm again to go ahead.</Banner>
            </div>
          ) : null}
          <p>Scope: <strong>{filtersText(pv.filters)}</strong>.</p>
          <dl className="facts">
            <dt>Findings</dt><dd>{pv.findings}{pv.findingsInPrompt !== pv.findings ? ` (${pv.findingsInPrompt} sent, newest first)` : ''}</dd>
            <dt>Criteria</dt><dd>{pv.criteria}</dd>
            <dt>Model</dt><dd>{pv.model.model}, {pv.model.effort}</dd>
            <dt>Estimated cost</dt><dd>{pv.estimatedCostUsd === null ? 'Unknown (no price in the config)' : `up to about ${usd(pv.estimatedCostUsd)}`}</dd>
            <dt>Tokens</dt><dd>about {tokens(pv.estimatedInputTokens)} in, at most {tokens(pv.maxOutputTokens)} out</dd>
          </dl>
          <Warnings items={pv.warnings} />
          <p className="small">This sends the findings to your model provider and spends money. The draft is saved with your runs, and it is a suggestion for a person to review.</p>
        </ConfirmDialog>
      ) : null}
    </>
  )
}
