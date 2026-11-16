import { useState } from 'react'
import type { CalibratePreviewResponse, CalibrateRequest, CalibrationRecord, CalibrationReport } from '../../../src/ui/api-types'
import { ApiFailure, api } from '../api/client'
import { useAsync } from '../api/useAsync'
import { IntervalBar } from '../components/charts'
import { PreviewPanel, scopeSentence } from '../components/PreviewPanel'
import { Banner, ConfirmDialog, Disclosure, EmptyState, ErrorState, Loading, PageHead, StatusBadge, Warnings } from '../components/ui'
import { fullDate, percent, plural, tokens, usd } from '../lib/format'
import { criterionHref } from '../lib/router'
import { useHealth } from '../state/HealthContext'
import { useRunStream } from '../state/RunStreamProvider'
import { LaunchError } from './LaunchPage'

// ------------------------------------------------------------- the report

type Rate = CalibrationReport['metrics']['tnr']

function RateBlock({ title, caption, rate, classLabel, primary }: { title: string; caption: string; rate: Rate; classLabel: string; primary?: boolean }) {
  return (
    <section className={`rate-block ${primary ? 'primary' : 'secondary'}`} aria-label={title}>
      <div className="rate-title">{title}</div>
      <div className="rate-big" data-testid={primary ? 'tnr-value' : 'tpr-value'}>{percent(rate.rate)}</div>
      <p className="small" style={{ margin: '0.5rem 0' }}>{caption}</p>
      <p className="small">
        {rate.n === 0 ? (
          <>No {classLabel} labels were measured, so this rate cannot be computed.</>
        ) : (
          <>
            <span className="num">{rate.successes} of {rate.n}</span> {classLabel} labels.{' '}
            {rate.interval ? (
              <>
                95 percent interval: <span className="num">{percent(rate.interval[0])} to {percent(rate.interval[1])}</span>.
              </>
            ) : null}
          </>
        )}
      </p>
      <div style={{ marginTop: '0.6rem' }}>
        <IntervalBar rate={rate.rate} interval={rate.interval} label={title} />
      </div>
      <p className="small muted" style={{ marginTop: '0.4rem' }}>n = {rate.n} {classLabel} labels</p>
    </section>
  )
}

function HowToRead() {
  return (
    <Disclosure title="How to read this">
      <p><strong>This is a measurement.</strong> It reports how closely the judge agrees with the expert labels. Low rates are a result to act on and they stop nothing.</p>
      <ul>
        <li><strong>True negative rate.</strong> Of the outputs the expert marked fail, the share the judge also failed. Read this first. A low value means the judge lets bad output through, and that is the dangerous mistake.</li>
        <li><strong>True positive rate.</strong> Of the outputs the expert marked pass, the share the judge also passed. A low value means the judge fails good output. That costs review time and is the safer mistake.</li>
        <li><strong>The interval.</strong> The 95 percent range of rates that fit the labels. A wide bar means the sample is small. Judge the result by the whole bar, and use the single number as a midpoint.</li>
        <li><strong>n per class.</strong> How many labels each rate rests on. A class with under 30 labels, or under 60 labels in total, is flagged as an insufficient sample.</li>
        <li><strong>Confusion matrix.</strong> Rows are what the expert said, columns what the judge said. The bottom-left cell in red is the dangerous one: the expert failed it and the judge passed it.</li>
        <li><strong>Prevalence and accuracy.</strong> Accuracy looks high when almost everything passes. Read it next to the share of labels the expert passed.</li>
        <li><strong>Kappa.</strong> Agreement beyond chance. It swings widely on small or lopsided samples, so treat it as secondary.</li>
        <li><strong>Random or all.</strong> Random uses only randomly sampled labels, which can estimate the judge's accuracy. All adds labels picked because they looked like trouble, and then the rates describe the sample reviewed.</li>
      </ul>
      <p>Disagreements are listed with both critiques side by side. Reading them is the point of the exercise: they show what the judge misses and where the rubric is unclear.</p>
      <p>For each one, first decide whether the judge misread the rubric or followed a rule you disagree with. The second is fixed in the rubric: open the criterion, change its wording and its worked examples together, then measure again on dev.</p>
    </Disclosure>
  )
}

/**
 * Labels changed after the judge's answer was available may have drifted toward
 * it, so the agreement on the original, blind labels is shown next to the
 * headline numbers. Reports saved before revisions existed have no block.
 */
function RevisionNote({ report }: { report: CalibrationReport }) {
  const rv = report.revisions
  if (!rv || rv.revised === 0 || !rv.blindMetrics) return null
  const b = rv.blindMetrics
  return (
    <section className="card-sm" aria-label="Labels changed after seeing the judge">
      <p className="small" data-testid="revision-note">
        {rv.revised === 1 ? '1 of these labels was' : `${rv.revised} of these labels were`} changed after seeing the judge
        {rv.verdictChanged !== rv.revised ? ` (${rv.verdictChanged} changed the verdict)` : ''}. Agreement on your original, blind labels: {percent(b.accuracy)}, against {percent(report.metrics.accuracy)} with the changes.
      </p>
      <p className="small muted">
        On the blind labels the true negative rate is {percent(b.tnr.rate)} and the true positive rate is {percent(b.tpr.rate)}. When agreement is higher with the changes, the changes moved toward the judge, so read the blind numbers as the safer estimate. Many changes toward the judge can also mean the rubric wording is unclear.
      </p>
    </section>
  )
}

export function CalibrationReportView({ record }: { record: CalibrationRecord }) {
  const r = record.report
  const m = r.metrics
  return (
    <div className="stack" aria-label="Calibration report">
      <div className="card-sm">
        <dl className="facts" style={{ margin: 0 }}>
          <dt>Judge</dt><dd>{r.judge}</dd>
          <dt>Rubric</dt><dd>{record.rubricId} version {record.rubricVersion}</dd>
          <dt>Split</dt><dd>{r.split}</dd>
          <dt>Selection</dt><dd>{r.selection === 'random' ? 'random labels only' : 'all labels, including targeted'}</dd>
          <dt>Measured</dt><dd>{m.n} of {r.inSplit} labels in the split{r.excludedTargeted > 0 ? `, ${r.excludedTargeted} targeted left out` : ''}</dd>
          <dt>Saved</dt><dd>{fullDate(record.at)}</dd>
          <dt>Labels file</dt><dd className="break">{record.labelsFile}</dd>
        </dl>
      </div>

      {m.insufficient ? (
        <Banner kind="danger" title="Insufficient sample. Do not rely on these numbers." role="alert">
          The sample is too small to trust. A class with under 30 labels, or under 60 labels in total, cannot support a firm conclusion.
        </Banner>
      ) : (
        <Banner kind="success">The sample size is adequate by the 30 per class and 60 in total rule of thumb.</Banner>
      )}
      <Warnings items={r.warnings} title="Warnings from this measurement" />
      <RevisionNote report={r} />

      <div className="cols-2">
        <RateBlock
          primary
          title="True negative rate"
          rate={m.tnr}
          classLabel="expert-fail"
          caption="Of the outputs the expert failed, how many the judge caught. This is the number that matters most."
        />
        <RateBlock
          title="True positive rate"
          rate={m.tpr}
          classLabel="expert-pass"
          caption="Of the outputs the expert passed, how many the judge confirmed."
        />
      </div>

      <div className="cols-2">
        <section className="card-sm" aria-label="Confusion matrix">
          <h3 className="sub-title">Confusion matrix</h3>
          <div className="confusion">
            <div className="hd" />
            <div className="hd">Judge: pass</div>
            <div className="hd">Judge: fail</div>
            <div className="hd">Expert: pass</div>
            <div className="good"><span className="cellnum">{m.confusion.tp}</span><div className="small muted">agree</div></div>
            <div><span className="cellnum">{m.confusion.fn}</span><div className="small muted">judge too strict</div></div>
            <div className="hd">Expert: fail</div>
            <div className="bad"><span className="cellnum">{m.confusion.fp}</span><div className="small muted">judge passed it</div></div>
            <div className="good"><span className="cellnum">{m.confusion.tn}</span><div className="small muted">agree</div></div>
          </div>
        </section>
        <section className="card-sm" aria-label="Prevalence and accuracy">
          <h3 className="sub-title">Prevalence, accuracy, kappa</h3>
          <dl className="facts">
            <dt>Prevalence</dt><dd>{percent(m.prevalencePass)} expert-pass</dd>
            <dt>Accuracy</dt><dd>{percent(m.accuracy)}</dd>
            <dt>Kappa</dt><dd>{m.kappa === null ? 'n/a' : m.kappa.toFixed(2)}</dd>
          </dl>
          <p className="small muted">Accuracy only means something next to prevalence. Kappa is unstable on small samples.</p>
        </section>
      </div>

      <section aria-label="Disagreements">
        <div className="section-header" style={{ marginTop: '0.5rem' }}>
          <h3 className="section-title">Disagreements ({r.disagreements.length})</h3>
          <span className="section-note">Expert critique on the left, judge critique on the right.</span>
        </div>
        {r.disagreements.length === 0 ? (
          <div className="card-sm muted">The judge agreed with the expert on every measured label.</div>
        ) : (
          <div className="stack">
            {r.disagreements.map(d => (
              <article className="card-sm" key={d.id}>
                <div className="row" style={{ marginBottom: '0.6rem' }}>
                  <span className="verdict-name">{d.id}</span>
                  <span className="badge badge-tag">{d.criterion}</span>
                  <span className="small">Expert <StatusBadge status={d.expert} /></span>
                  <span className="small">Judge <StatusBadge status={d.judge} /></span>
                  {d.expert === 'fail' && d.judge === 'pass' ? <span className="badge badge-critical">Judge passed a failure</span> : null}
                  <a className="small" href={criterionHref(d.criterion, record.rubricId)} style={{ marginLeft: 'auto' }}>View or edit this criterion</a>
                </div>
                <div className="compare">
                  <div className="crit-box"><h4>Expert critique</h4>{d.expertCritique}</div>
                  <div className="crit-box"><h4>Judge critique</h4>{d.judgeCritique ?? <span className="muted">The judge gave no critique.</span>}</div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {r.errors.length > 0 ? (
        <section aria-label="Items that could not be judged">
          <div className="section-header" style={{ marginTop: '0.5rem' }}>
            <h3 className="section-title">Could not be judged ({r.errors.length})</h3>
            <span className="section-note">These are left out of the rates. Fix the cause before trusting the numbers.</span>
          </div>
          <div className="verdict-list">
            {r.errors.map(e => (
              <div className="verdict-item" key={e.id}>
                <div className="verdict-top"><StatusBadge status="error" /><span className="verdict-name">{e.id}</span></div>
                <div className="verdict-body">{e.reason}</div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="small muted">
        Judge spend: {usd(r.usage.costUsd)} ({tokens(r.usage.inputTokens)} tokens in, {tokens(r.usage.outputTokens)} out)
        {r.usage.costUsd === null ? '. The cost is unknown because a model has no price in the config.' : '.'}
      </div>

      <HowToRead />
    </div>
  )
}

// ------------------------------------------------------------------- page

export function CalibrationPage() {
  const { health } = useHealth()
  const { state } = useRunStream()
  const rubrics = useAsync(() => api.rubrics(), [])
  const latest = useAsync(() => api.calibration(), [])

  const [rubricId, setRubricId] = useState('')
  const [split, setSplit] = useState<'dev' | 'test'>('dev')
  const [selection, setSelection] = useState<'random' | 'all'>('random')
  const [preview, setPreview] = useState<{ response: CalibratePreviewResponse; request: CalibrateRequest } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState<'preview' | 'start' | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [fresh, setFresh] = useState<CalibrationRecord | null>(null)

  const items = rubrics.data?.rubrics ?? []
  const chosen = rubricId || items[0]?.rubric.id || ''
  const jobBusy = state.activeJob !== null
  const request: CalibrateRequest = { rubricId: chosen, split, selection }

  const reset = () => {
    setPreview(null)
    setError(null)
  }

  const runPreview = async () => {
    setBusy('preview')
    setError(null)
    try {
      setPreview({ response: await api.calibratePreview(request), request })
    } catch (e) {
      setPreview(null)
      setError(e)
    } finally {
      setBusy(null)
    }
  }

  const start = async () => {
    if (!preview) return
    setBusy('start')
    try {
      const res = await api.calibrateStart({ ...preview.request, previewToken: preview.response.previewToken, confirm: true })
      setFresh(res.record)
      setPreview(null)
      setConfirming(false)
      latest.reload()
    } catch (e) {
      setConfirming(false)
      if (e instanceof ApiFailure && e.code === 'preview_token_invalid') {
        try {
          setPreview({ response: await api.calibratePreview(preview.request), request: preview.request })
          setError(new ApiFailure(412, 'preview_token_invalid', 'The labels, rubric or prices changed since you previewed. Read the new preview, then confirm again.'))
        } catch (e2) {
          setPreview(null)
          setError(e2)
        }
      } else {
        setError(e)
      }
    } finally {
      setBusy(null)
    }
  }

  const shown = fresh ?? latest.data?.latest ?? null
  const pv = preview?.response
  const contaminated = pv?.contamination != null

  return (
    <>
      <PageHead title="Calibration" sub="Measure the judge against your labels. The true negative rate leads, because a judge that passes a bad agent is the dangerous error." />

      <div className="card stack">
        <h2 className="section-title">Measure a judge</h2>
        {rubrics.loading && !rubrics.data ? <Loading label="Loading rubrics" /> : null}
        {rubrics.error && !rubrics.data ? <ErrorState error={rubrics.error} onRetry={rubrics.reload} title="Could not load rubrics" /> : null}
        {rubrics.data ? (
          items.length === 0 ? (
            <EmptyState title="No rubrics found">The scenarios path has no rubric files, so there is no judge to measure.</EmptyState>
          ) : (
            <>
              <Warnings items={rubrics.data.problems} title="Rubric problems" />
              <fieldset disabled={jobBusy || busy !== null} style={{ border: 'none' }} className="stack">
                <div className="form-group" style={{ maxWidth: 420, marginBottom: 0 }}>
                  <label className="form-label" htmlFor="rubric">Rubric</label>
                  <select id="rubric" className="form-select" value={chosen} onChange={e => { setRubricId(e.target.value); reset() }}>
                    {items.map(i => (
                      <option key={i.rubric.id} value={i.rubric.id}>{i.rubric.id} (version {i.rubric.version}, {plural(i.rubric.criteria.length, 'criterion', 'criteria')})</option>
                    ))}
                  </select>
                </div>
                <div className="form-group" style={{ maxWidth: 420, marginBottom: 0 }}>
                  <label className="form-label" htmlFor="split">Split</label>
                  <select id="split" className="form-select" value={split} onChange={e => { setSplit(e.target.value as 'dev' | 'test'); reset() }}>
                    <option value="dev">dev (for iterating on the prompt)</option>
                    <option value="test">test (score once per judge version)</option>
                  </select>
                  <div className="form-hint">The train split is refused: its labels may appear in the judge's prompt.</div>
                </div>
                <div role="radiogroup" aria-labelledby="sel-label">
                  <div className="form-label" id="sel-label">Which labels</div>
                  <label className="check-row" style={{ border: '1px solid var(--border)' }}>
                    <input type="radio" name="selection" checked={selection === 'random'} onChange={() => { setSelection('random'); reset() }} />
                    <span><strong>Random only</strong> (default). Targeted labels were picked because they looked like trouble, so they would bias the rates.</span>
                  </label>
                  <label className="check-row" style={{ border: '1px solid var(--border)', borderTop: 'none' }}>
                    <input type="radio" name="selection" checked={selection === 'all'} onChange={() => { setSelection('all'); reset() }} />
                    <span><strong>All labels.</strong> The report then says the rates describe only the sample reviewed.</span>
                  </label>
                </div>
              </fieldset>
              {jobBusy ? <Banner kind="info" role="status">A job is running on the server. Starting a calibration is off until it ends.</Banner> : null}
              <div className="row">
                <button type="button" className="btn btn-primary" onClick={runPreview} disabled={jobBusy || busy !== null || chosen === ''}>
                  {busy === 'preview' ? <span className="spinner" aria-hidden="true" /> : null}
                  Preview the cost
                </button>
                <span className="small muted">Labels file: <span className="mono break">{health.labelsFile}</span></span>
              </div>
            </>
          )
        ) : null}

        {error ? <LaunchError error={error} /> : null}

        {pv && preview ? (
          <>
            {contaminated ? (
              <Banner kind="danger" title="This judge is contaminated. Start is blocked." role="alert">
                <span className="break">{pv.contamination}</span>
              </Banner>
            ) : null}
            <PreviewPanel preview={pv.preview} lines={pv.lines} warnings={pv.warnings} />
            <div className="row">
              <button type="button" className="btn btn-primary btn-lg" onClick={() => setConfirming(true)} disabled={contaminated || jobBusy || busy !== null}>
                Review and start
              </button>
              <span className="small muted">A confirmation comes next. Nothing starts yet.</span>
            </div>
          </>
        ) : null}
      </div>

      {confirming && pv ? (
        <ConfirmDialog
          title="Start this calibration?"
          confirmLabel={pv.preview.anyModelCalls ? `Start (${plural(pv.preview.calls.judge, 'judge call')})` : 'Start'}
          onConfirm={start}
          onCancel={() => setConfirming(false)}
          busy={busy === 'start'}
        >
          <p>You are about to measure <strong>{scopeSentence(pv.preview)}</strong></p>
          <dl className="facts">
            <dt>Rubric</dt><dd>{preview?.request.rubricId}</dd>
            <dt>Split</dt><dd>{preview?.request.split}</dd>
            <dt>Labels to judge</dt><dd>{pv.preview.judgements?.count ?? 0}</dd>
            <dt>Judge calls, exactly</dt><dd>{pv.preview.calls.judge}</dd>
            <dt>Judge model</dt><dd>{pv.preview.models.judge ? `${pv.preview.models.judge.model}, ${pv.preview.models.judge.effort}` : 'None'}</dd>
          </dl>
          {pv.preview.anyModelCalls ? (
            <p className="small">This spends money with your model provider. It is one long request and cannot be cancelled once it starts.</p>
          ) : (
            <p className="small">No label needs judging, so no model is called and this costs nothing.</p>
          )}
        </ConfirmDialog>
      ) : null}

      {busy === 'start' ? (
        <div style={{ marginTop: '1.5rem' }} role="status" aria-live="polite">
          <Loading label="Measuring the judge. This can take several minutes. Keep this page open." />
        </div>
      ) : null}

      <div className="section-header">
        <h2 className="section-title">{fresh ? 'Result' : 'Latest saved calibration'}</h2>
        {fresh ? <span className="badge badge-pass">Just measured</span> : null}
      </div>
      {latest.loading && !shown ? <Loading label="Loading the latest calibration" /> : null}
      {latest.error && !shown ? <ErrorState error={latest.error} onRetry={latest.reload} title="Could not load the latest calibration" /> : null}
      {!latest.loading && !shown && !latest.error ? (
        <div className="card"><EmptyState title="No calibration yet">Preview and start one above. The report appears here and is saved with your runs.</EmptyState></div>
      ) : null}
      {shown ? <CalibrationReportView record={shown} /> : null}
    </>
  )
}
