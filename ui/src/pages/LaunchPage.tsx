import { useEffect, useMemo, useState } from 'react'
import type { ActiveJob, PreviewData, RunPreviewResponse, RunRequest } from '../../../src/ui/api-types'
import { ApiFailure, api, describeError, isApiFailure } from '../api/client'
import { useAsync } from '../api/useAsync'
import { PreviewPanel, scopeSentence } from '../components/PreviewPanel'
import { RunProgress } from '../components/RunProgress'
import { Banner, ConfirmDialog, EmptyState, ErrorState, Loading, PageHead, TagList } from '../components/ui'
import { plural, usd } from '../lib/format'
import { useHealth } from '../state/HealthContext'
import { useRunStream } from '../state/RunStreamProvider'

/** What changed between two previews of the "same" plan, in words. */
export function describeChanges(before: PreviewData, after: PreviewData): string[] {
  const out: string[] = []
  const a = before.scenarios?.ids ?? []
  const b = after.scenarios?.ids ?? []
  const added = b.filter(x => !a.includes(x))
  const removed = a.filter(x => !b.includes(x))
  if (added.length) out.push(`Scenarios added: ${added.join(', ')}.`)
  if (removed.length) out.push(`Scenarios removed: ${removed.join(', ')}.`)
  if (before.calls.total !== after.calls.total) out.push(`Model calls (at most) went from ${before.calls.total} to ${after.calls.total}.`)
  const capA = before.cap?.usd ?? null
  const capB = after.cap?.usd ?? null
  if (capA !== capB) out.push(`The cost cap went from ${capA === null ? 'none' : usd(capA)} to ${capB === null ? 'none' : usd(capB)}.`)
  const worstA = before.cap?.worstCaseUsd ?? null
  const worstB = after.cap?.worstCaseUsd ?? null
  if (worstA !== worstB) out.push(`The worst case total went from ${worstA === null ? 'none' : usd(worstA)} to ${worstB === null ? 'none' : usd(worstB)}.`)
  for (const role of ['simulator', 'judge'] as const) {
    const x = before.models[role]
    const y = after.models[role]
    if (x?.model !== y?.model || x?.effort !== y?.effort || x?.priced !== y?.priced) {
      out.push(`The ${role} model changed (${x ? `${x.model}, ${x.effort}` : 'none'} to ${y ? `${y.model}, ${y.effort}` : 'none'}).`)
    }
  }
  if (out.length === 0) out.push('The files or prices behind the plan changed, but the numbers above are the same.')
  return out
}

export function LaunchError({ error }: { error: unknown }) {
  if (!isApiFailure(error)) return <ErrorState error={error} title="Could not start" />
  if (error.code === 'plan_invalid') {
    const errors = (error.details as { errors?: string[] } | undefined)?.errors ?? []
    return (
      <Banner kind="danger" title="These scenarios cannot run." role="alert">
        <ul>
          {errors.length === 0 ? <li>{error.message}</li> : errors.map((e, i) => <li key={i} className="break">{e}</li>)}
        </ul>
      </Banner>
    )
  }
  if (error.code === 'run_in_progress') {
    const job = (error.details as { activeJob?: ActiveJob } | undefined)?.activeJob
    return (
      <Banner kind="warning" title="A job is already running." role="alert">
        {job
          ? job.kind === 'run'
            ? `A run of ${plural(job.scenarioIds?.length ?? 0, 'scenario')} is active (${job.finished ?? 0} finished, suite ${job.suiteId ?? 'unknown'}). Its progress is shown below. Start another when it ends.`
            : 'A calibration is running. It cannot be cancelled. Start a run when it ends.'
          : error.message}
      </Banner>
    )
  }
  if (error.code === 'provider_unavailable') {
    return (
      <Banner kind="danger" title="No model provider." role="alert">
        <span className="break">{error.message}</span>
      </Banner>
    )
  }
  return (
    <Banner kind="danger" title="Could not start." role="alert">
      <span className="break">{error.message}</span> <span className="muted small">({error.code})</span>
    </Banner>
  )
}

export function LaunchPage() {
  const { health } = useHealth()
  const { state, seedJob } = useRunStream()
  const scenarios = useAsync(() => api.scenarios(), [])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [cap, setCap] = useState('')
  const [preview, setPreview] = useState<{ response: RunPreviewResponse; request: RunRequest } | null>(null)
  const [changes, setChanges] = useState<string[]>([])
  const [busy, setBusy] = useState<'preview' | 'start' | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [confirming, setConfirming] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)

  useEffect(() => {
    seedJob(health.activeJob)
  }, [health.activeJob, seedJob])
  useEffect(() => {
    if (state.activeJob === null) setCancelling(false)
  }, [state.activeJob])

  const items = scenarios.data?.scenarios ?? []
  const order = useMemo(() => items.map(i => i.scenario.id), [items])
  const tags = useMemo(() => [...new Set(items.flatMap(i => i.scenario.tags))].sort(), [items])

  const capNumber = cap.trim() === '' ? undefined : Number(cap)
  const capInvalid = capNumber !== undefined && (!Number.isFinite(capNumber) || capNumber <= 0)
  const request: RunRequest = {
    only: order.filter(id => selected.has(id)),
    ...(capNumber !== undefined && !capInvalid ? { maxCostUsd: capNumber } : {}),
  }

  const activeJob = state.activeJob
  const jobBusy = activeJob !== null
  const canPreview = !jobBusy && busy === null && selected.size > 0 && !capInvalid && health.configFile !== null

  // A different selection or cap is a different plan: the old preview and its token must not be reused.
  const invalidate = () => {
    setPreview(null)
    setChanges([])
    setError(null)
  }
  const toggle = (id: string) => {
    invalidate()
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleTag = (tag: string) => {
    invalidate()
    const ids = items.filter(i => i.scenario.tags.includes(tag)).map(i => i.scenario.id)
    setSelected(prev => {
      const allIn = ids.every(id => prev.has(id))
      const next = new Set(prev)
      for (const id of ids) {
        if (allIn) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }
  const tagSelected = (tag: string) => {
    const ids = items.filter(i => i.scenario.tags.includes(tag)).map(i => i.scenario.id)
    return ids.length > 0 && ids.every(id => selected.has(id))
  }

  const runPreview = async () => {
    setBusy('preview')
    setError(null)
    setChanges([])
    const sent = request
    try {
      const response = await api.runPreview(sent)
      setPreview({ response, request: sent })
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
      // The token is only ever sent with the exact request it was issued for.
      await api.runStart({ ...preview.request, previewToken: preview.response.previewToken, confirm: true })
      setConfirming(false)
      setPreview(null)
      setChanges([])
    } catch (e) {
      setConfirming(false)
      if (e instanceof ApiFailure && e.code === 'preview_token_invalid') {
        // The plan moved under us. Preview again and say what changed. Nothing starts without a new click.
        const before = preview.response.preview
        try {
          const response = await api.runPreview(preview.request)
          setPreview({ response, request: preview.request })
          setChanges(describeChanges(before, response.preview))
          setError(new ApiFailure(412, 'preview_token_invalid', 'The plan changed since you previewed it. Read the new preview, then confirm again.'))
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

  const cancel = async () => {
    setCancelling(true)
    setCancelError(null)
    try {
      await api.runCancel()
    } catch (e) {
      setCancelling(false)
      setCancelError(describeError(e))
    }
  }

  const previewData = preview?.response.preview

  return (
    <>
      <PageHead title="Run scenarios" sub="Pick scenarios, preview what the run can cost, then confirm. Nothing that can call a model starts on one click." />

      {health.configFile === null ? (
        <Banner kind="warning" title="No config file.">
          The server was started without one, so runs are off. Start it from a directory that has evals.config.yaml, or pass --config.
        </Banner>
      ) : null}

      {jobBusy ? (
        <div style={{ marginBottom: '1rem' }}>
          <Banner kind="info" title={activeJob.kind === 'run' ? 'A run is active.' : 'A calibration is running.'} role="status">
            {activeJob.kind === 'run'
              ? `${activeJob.finished ?? 0} of ${activeJob.scenarioIds?.length ?? 0} scenarios finished. Starting another is off until it ends.`
              : 'It cannot be cancelled. Starting a run is off until it ends.'}
          </Banner>
        </div>
      ) : null}

      {scenarios.loading && !scenarios.data ? <Loading label="Loading scenarios" /> : null}
      {scenarios.error && !scenarios.data ? <ErrorState error={scenarios.error} onRetry={scenarios.reload} title="Could not load scenarios" /> : null}

      {scenarios.data ? (
        items.length === 0 ? (
          <div className="card">
            <EmptyState title="No scenarios found" commands={'npx evals validate ./scenarios'}>
              {scenarios.data.path ? 'The scenarios path has no scenario files.' : 'The server has no scenarios path. Start it with a path, or from a directory that has ./scenarios.'}
            </EmptyState>
          </div>
        ) : (
          <div className="stack">
            {scenarios.data.validation.errors.length > 0 ? (
              <Banner kind="danger" title="Validation problems." role="alert">
                <ul>{scenarios.data.validation.errors.map((e, i) => <li key={i} className="break">{e}</li>)}</ul>
                <span className="small">See the Scenarios page for details.</span>
              </Banner>
            ) : null}

            <fieldset className="card" disabled={jobBusy} style={{ border: '1px solid var(--border)' }}>
              <legend className="section-title" style={{ padding: '0 0.4rem' }}>1. Choose scenarios</legend>
              <div className="row" style={{ marginBottom: '0.75rem' }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { invalidate(); setSelected(new Set(order)) }}>Select all</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { invalidate(); setSelected(new Set()) }}>Clear</button>
                <span className="small muted" aria-live="polite">{selected.size} of {items.length} selected</span>
              </div>
              {tags.length > 0 ? (
                <div className="row" style={{ marginBottom: '0.75rem', gap: '0.4rem' }} role="group" aria-label="Select by tag">
                  <span className="small muted">By tag:</span>
                  {tags.map(t => (
                    <button key={t} type="button" className="tag-chip" aria-pressed={tagSelected(t)} onClick={() => toggleTag(t)}>{t}</button>
                  ))}
                </div>
              ) : null}
              <div style={{ border: '1px solid var(--border)' }}>
                {items.map(i => {
                  const id = i.scenario.id
                  const calls = i.needs.simulatorCalls + i.needs.rubricCalls + i.needs.goalCalls
                  return (
                    <label className="check-row" key={id}>
                      <input type="checkbox" checked={selected.has(id)} onChange={() => toggle(id)} />
                      <span className="grow">
                        <span className="verdict-name">{id}</span> <span className="small muted">v{i.scenario.version}</span>
                        <span className="row" style={{ marginTop: '0.25rem', gap: '0.4rem' }}>
                          {i.needsModel ? <span className="badge badge-warning">Up to {plural(calls, 'model call')}</span> : <span className="badge badge-pass">Checks only, no model</span>}
                          <TagList tags={i.scenario.tags} />
                        </span>
                      </span>
                    </label>
                  )
                })}
              </div>
            </fieldset>

            <fieldset className="card" disabled={jobBusy} style={{ border: '1px solid var(--border)' }}>
              <legend className="section-title" style={{ padding: '0 0.4rem' }}>2. Optional cost cap</legend>
              <div className="form-group" style={{ maxWidth: 320, marginBottom: 0 }}>
                <label className="form-label" htmlFor="cap">Cost cap per scenario, in US dollars</label>
                <input
                  id="cap"
                  className="form-input"
                  inputMode="decimal"
                  placeholder="Use the config default"
                  value={cap}
                  aria-invalid={capInvalid}
                  aria-describedby="cap-hint"
                  onChange={e => { invalidate(); setCap(e.target.value) }}
                />
                <div id="cap-hint" className={capInvalid ? 'form-error' : 'form-hint'}>
                  {capInvalid ? 'Enter a number above zero, or leave it empty.' : 'A scenario that reaches the cap stops with an error result. Empty uses the config value, if any.'}
                </div>
              </div>
            </fieldset>

            <div className="row">
              <button type="button" className="btn btn-primary" onClick={runPreview} disabled={!canPreview}>
                {busy === 'preview' ? <span className="spinner" aria-hidden="true" /> : null}
                3. Preview the cost
              </button>
              {selected.size === 0 ? <span className="small muted">Select at least one scenario.</span> : null}
            </div>

            {error ? <LaunchError error={error} /> : null}
            {changes.length > 0 ? (
              <Banner kind="warning" title="What changed:" role="alert">
                <ul>{changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
              </Banner>
            ) : null}

            {preview && previewData ? (
              <>
                <PreviewPanel preview={previewData} lines={preview.response.lines} warnings={preview.response.warnings}>
                  <p className="small muted">Preview valid until {new Date(preview.response.expiresAt).toLocaleTimeString('en-US', { hour12: false })}. It covers exactly this selection and cap.</p>
                </PreviewPanel>
                <div className="row">
                  <button type="button" className="btn btn-primary btn-lg" onClick={() => setConfirming(true)} disabled={jobBusy || busy !== null}>
                    Review and start
                  </button>
                  <span className="small muted">A confirmation comes next. Nothing starts yet.</span>
                </div>
              </>
            ) : null}
          </div>
        )
      ) : null}

      {confirming && preview && previewData ? (
        <ConfirmDialog
          title={previewData.anyModelCalls ? 'Start this run?' : 'Start this run? It makes no model calls.'}
          confirmLabel={previewData.anyModelCalls ? `Start (up to ${plural(previewData.calls.total, 'model call')})` : 'Start the run'}
          onConfirm={start}
          onCancel={() => setConfirming(false)}
          busy={busy === 'start'}
        >
          <p>
            You are about to run <strong>{scopeSentence(previewData)}</strong>
          </p>
          <dl className="facts">
            <dt>Scenarios</dt>
            <dd>{previewData.scenarios?.selected ?? 0}</dd>
            <dt>Model calls, at most</dt>
            <dd>{previewData.calls.total}</dd>
            <dt>Cap per scenario</dt>
            <dd>{previewData.cap ? usd(previewData.cap.usd) : 'None'}</dd>
            <dt>Worst case total</dt>
            <dd>{previewData.cap ? usd(previewData.cap.worstCaseUsd) : 'No limit'}</dd>
          </dl>
          {previewData.anyModelCalls ? (
            <p className="small">This can spend money with your model provider. The numbers are upper bounds from the preview you just read.</p>
          ) : (
            <p className="small">No model is called, so this costs nothing.</p>
          )}
          {previewData.warnings.length + preview.response.warnings.length > 0 ? (
            <Banner kind="warning">
              {plural(previewData.warnings.length + preview.response.warnings.length, 'warning')} in the preview. Read them first.
            </Banner>
          ) : null}
        </ConfirmDialog>
      ) : null}

      {cancelError ? <div style={{ marginTop: '1rem' }}><Banner kind="danger" role="alert">{cancelError}</Banner></div> : null}

      {state.suite ? (
        <div style={{ marginTop: '2rem' }}>
          <RunProgress
            suite={state.suite}
            activeJob={activeJob}
            connection={state.connection}
            announcement={state.announcement}
            onCancel={cancel}
            cancelling={cancelling && activeJob !== null}
          />
        </div>
      ) : null}
    </>
  )
}
