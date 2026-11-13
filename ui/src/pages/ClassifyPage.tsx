import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Label, LabelStats, QueueItem, QueueStats, RevealResponse } from '../../../src/ui/api-types'
import { api, describeError, isApiFailure } from '../api/client'
import { useAsync } from '../api/useAsync'
import { TurnView } from './RunDetailPage'
import { Banner, CriticalMarker, EmptyState, ErrorState, Loading, PageHead, Tabs, VerdictBadge, Warnings } from '../components/ui'
import { percent, plural, shortDate } from '../lib/format'
import { runHref } from '../lib/router'
import { readStored, writeStored } from '../lib/storage'

// Blind labelling. The queue item has the input, the output being judged and the
// criterion. It does not show the judge's verdict or critique, and it does not
// show the item's `reason` (a targeted reason hints that the judge failed the
// run). The judge's answer comes from the reveal endpoint, which this page only
// calls after the label is saved. See docs/design/0003-ui-and-api.md.

export const LABELER_KEY = 'evals-ui-labeler'
export const MAX_CRITIQUE = 20_000
export const MAX_LABELER = 100
const PAGE_SIZE = 25

export interface FormErrors {
  verdict?: string
  critique?: string
  labeler?: string
}

/** Same rules as the server: a verdict, a critique and a labeler, both text fields non-blank after trimming and within their limits. */
export function validateLabel(v: { verdict: 'pass' | 'fail' | null; critique: string; labeler: string }): FormErrors {
  const errors: FormErrors = {}
  if (v.verdict === null) errors.verdict = 'Choose pass or fail.'
  const critique = v.critique.trim()
  if (critique === '') errors.critique = 'A critique is required on every label.'
  else if (critique.length > MAX_CRITIQUE) errors.critique = `The critique is over ${MAX_CRITIQUE.toLocaleString('en-US')} characters.`
  const labeler = v.labeler.trim()
  if (labeler === '') errors.labeler = 'Enter your name so the label has an author.'
  else if (labeler.length > MAX_LABELER) errors.labeler = `The name is over ${MAX_LABELER} characters.`
  return errors
}

type Phase = 'edit' | 'saving' | 'saved' | 'revealing' | 'revealed'

function isTypingTarget(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}
function isActivatable(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'SUMMARY')
}

// ------------------------------------------------------------------- summary

function QuotaStatus({ stats }: { stats: QueueStats | null }) {
  if (!stats) return null
  const have = stats.labelledRandomShare
  return (
    <div className="card-sm" aria-label="Random sampling quota">
      <div className="row-between">
        <strong style={{ color: 'var(--white)' }}>Random sampling quota</strong>
        {stats.quotaMet ? <span className="badge badge-pass">Met</span> : <span className="badge badge-warning">Behind</span>}
      </div>
      <p className="small" style={{ marginTop: '0.4rem' }}>
        {have === null
          ? `No labels yet. At least ${percent(stats.minRandomShare)} of all labels must come from random sampling.`
          : `${percent(have)} of your ${plural(stats.labelled, 'label')} are random samples. The minimum is ${percent(stats.minRandomShare)}.`}
        {stats.quotaMet ? '' : ' The queue adds randomly sampled items until the share is met.'}
      </p>
      <p className="small muted">Only random labels can measure how often the judge is wrong, so the server keeps this share up.</p>
    </div>
  )
}

function LabelledSummary({ stats }: { stats: LabelStats | null }) {
  if (!stats) return null
  return (
    <div className="card-sm" aria-label="Labelled so far">
      <strong style={{ color: 'var(--white)' }}>Labelled so far</strong>
      <dl className="facts">
        <dt>Labels</dt><dd>{stats.total}</dd>
        <dt>Pass</dt><dd>{stats.byVerdict.pass}</dd>
        <dt>Fail</dt><dd>{stats.byVerdict.fail}</dd>
        <dt>Random</dt><dd>{stats.random}</dd>
      </dl>
    </div>
  )
}

// ---------------------------------------------------------------- reveal view

export function RevealView({ reveal }: { reveal: RevealResponse }) {
  const { judge, human } = reveal
  return (
    <div className="stack" aria-label="What the judge said">
      {judge === null ? (
        <Banner kind="info" title="The judge never decided this criterion.">
          {reveal.runError ? <>The run ended with an error first: <span className="break">{reveal.runError}</span></> : 'There is no judge verdict to compare with.'}
        </Banner>
      ) : reveal.agrees ? (
        <Banner kind="success" role="status"><span className="agree-banner">You and the judge agree.</span> Both said {human.verdict}.</Banner>
      ) : (
        <Banner kind="danger" role="status"><span className="agree-banner">You and the judge disagree.</span> You said {human.verdict}, the judge said {judge.verdict}.</Banner>
      )}
      <div className="compare">
        <div className="crit-box">
          <h4>Your label</h4>
          <div className="row" style={{ marginBottom: '0.4rem' }}><VerdictBadge verdict={human.verdict} /><span className="small muted">{human.labeler}</span></div>
          {human.critique}
        </div>
        <div className="crit-box">
          <h4>The judge</h4>
          {judge ? (
            <>
              <div className="row" style={{ marginBottom: '0.4rem' }}>
                <VerdictBadge verdict={judge.verdict} />
                {judge.critical ? <CriticalMarker /> : null}
                <span className="small muted mono">{judge.grader}</span>
              </div>
              {judge.critique}
            </>
          ) : (
            <span className="muted">No verdict.</span>
          )}
        </div>
      </div>
      {reveal.runId ? <a href={runHref(reveal.runId)} className="small">Open the whole run</a> : null}
    </div>
  )
}

// --------------------------------------------------------------- queue screen

export function QueueView() {
  const queue = useAsync(() => api.queue(PAGE_SIZE), [])
  const labels = useAsync(() => api.labels(), [])
  const [items, setItems] = useState<QueueItem[]>([])
  const [stats, setStats] = useState<QueueStats | null>(null)
  const [labelStats, setLabelStats] = useState<LabelStats | null>(null)
  const [sessionDone, setSessionDone] = useState(0)
  const [verdict, setVerdict] = useState<'pass' | 'fail' | null>(null)
  const [critique, setCritique] = useState('')
  const [labeler, setLabeler] = useState(() => readStored(LABELER_KEY) ?? '')
  const [phase, setPhase] = useState<Phase>('edit')
  const [saved, setSaved] = useState<Label | null>(null)
  const [reveal, setReveal] = useState<RevealResponse | null>(null)
  const [tried, setTried] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [showContext, setShowContext] = useState(false)
  const [skipped, setSkipped] = useState(0)
  const critiqueRef = useRef<HTMLTextAreaElement>(null)

  // Take a fresh page from the server on load and whenever the local page runs out.
  useEffect(() => {
    if (queue.data) {
      setItems(queue.data.items)
      setStats(queue.data.stats)
    }
  }, [queue.data])
  useEffect(() => {
    if (labels.data) setLabelStats(labels.data.stats)
  }, [labels.data])

  const current = items[0] ?? null
  const errors = validateLabel({ verdict, critique, labeler })
  const valid = Object.keys(errors).length === 0

  const resetForm = () => {
    setVerdict(null)
    setCritique('')
    setPhase('edit')
    setSaved(null)
    setReveal(null)
    setTried(false)
    setProblem(null)
    setShowContext(false)
  }

  const next = useCallback(() => {
    setItems(prev => prev.slice(1))
    resetForm()
  }, [])

  // When the local page is empty, ask the server for more (labelling removes items, so there may be more behind them).
  useEffect(() => {
    if (items.length === 0 && queue.data && !queue.loading && sessionDone + skipped > 0) queue.reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length])

  const skip = useCallback(() => {
    if (!current || phase !== 'edit') return
    setItems(prev => [...prev.slice(1), prev[0]!])
    setSkipped(n => n + 1)
    resetForm()
  }, [current, phase])

  const refreshStats = () => {
    api.queue(PAGE_SIZE).then(q => setStats(q.stats)).catch(() => {})
    api.labels().then(l => setLabelStats(l.stats)).catch(() => {})
  }

  const submit = useCallback(async () => {
    if (!current || phase !== 'edit') return
    setTried(true)
    if (!valid || verdict === null) {
      if (errors.critique) critiqueRef.current?.focus()
      return
    }
    setPhase('saving')
    setProblem(null)
    try {
      const res = await api.postLabel({ itemId: current.itemId, labeler: labeler.trim(), verdict, critique: critique.trim() })
      writeStored(LABELER_KEY, labeler.trim())
      setSaved(res.label)
      setPhase('saved')
      setSessionDone(n => n + 1)
      refreshStats()
    } catch (e) {
      setPhase('edit')
      if (isApiFailure(e) && (e.code === 'duplicate_label' || e.code === 'item_not_found' || e.code === 'item_not_in_queue')) {
        setProblem(`${e.message} It is not in your queue any more. Go to the next item.`)
      } else {
        setProblem(describeError(e))
      }
    }
  }, [current, phase, valid, verdict, errors.critique, labeler, critique])

  const doReveal = useCallback(async () => {
    if (!current || phase !== 'saved') return
    setPhase('revealing')
    try {
      const r = await api.reveal(current.itemId)
      setReveal(r)
      setPhase('revealed')
    } catch (e) {
      setPhase('saved')
      setProblem(describeError(e))
    }
  }, [current, phase])

  // Keyboard shortcuts. Plain keys are ignored while typing or when a button has focus; Ctrl/Cmd+Enter submits from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.isComposing) return
      const typing = isTypingTarget(e.target)
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        if (phase === 'edit') {
          e.preventDefault()
          void submit()
        }
        return
      }
      if (e.ctrlKey || e.metaKey || typing) return
      const key = e.key.toLowerCase()
      if (phase === 'edit') {
        if (key === 'p') {
          setVerdict('pass')
          critiqueRef.current?.focus()
          e.preventDefault()
        } else if (key === 'f') {
          setVerdict('fail')
          critiqueRef.current?.focus()
          e.preventDefault()
        } else if (key === 'n') skip()
        else if (key === 'enter' && !isActivatable(e.target)) void submit()
      } else if (phase === 'saved' || phase === 'revealed') {
        if (key === 'r' && phase === 'saved') void doReveal()
        else if (key === 'n' || (key === 'enter' && !isActivatable(e.target))) next()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, submit, skip, doReveal, next])

  const hint = useMemo(
    () =>
      phase === 'edit' ? (
        <>
          <span className="kbd">P</span> pass &middot; <span className="kbd">F</span> fail &middot; <span className="kbd">N</span> skip &middot; <span className="kbd">Enter</span> submit
          &middot; <span className="kbd">Ctrl</span>+<span className="kbd">Enter</span> submits while typing
        </>
      ) : (
        <>
          <span className="kbd">R</span> reveal the judge &middot; <span className="kbd">N</span> or <span className="kbd">Enter</span> next item
        </>
      ),
    [phase],
  )

  if (queue.loading && !queue.data) return <Loading label="Loading the review queue" />
  if (queue.error && !queue.data) return <ErrorState error={queue.error} onRetry={queue.reload} title="Could not load the queue" />

  const total = sessionDone + items.length
  const showErrors = tried

  return (
    <div className="stack">
      <div className="grid-2">
        <QuotaStatus stats={stats} />
        <LabelledSummary stats={labelStats} />
      </div>
      {queue.data?.notes.length ? <Banner kind="info"><ul>{queue.data.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></Banner> : null}

      {!current ? (
        <div className="card">
          <EmptyState title="Nothing to review right now">
            {queue.data?.notes[0] ?? 'Every item that is up for review has a label. New runs add more.'}
          </EmptyState>
        </div>
      ) : (
        <>
          <div>
            <div className="row-between small" style={{ marginBottom: '0.3rem' }}>
              <span aria-live="polite">{sessionDone} labelled this session, {items.length} left in this batch{stats ? `, ${stats.pending} up for review in total` : ''}</span>
              <span className="muted">{hint}</span>
            </div>
            <div className="progress-track" role="progressbar" aria-label="Review progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={sessionDone}>
              <div className="progress-fill" style={{ width: `${total === 0 ? 0 : (sessionDone / total) * 100}%` }} />
            </div>
          </div>

          <article className="review-panel" aria-label="Item to label">
            <div className="review-section">
              <div className="review-label">Criterion to judge</div>
              <div className="criterion-text">{current.criterion.text ?? `(The rubric text is not available. Criterion id: ${current.criterion.id})`}</div>
              <div className="row small muted" style={{ marginTop: '0.4rem' }}>
                <span className="mono">{current.criterion.id}</span>
                {current.criterion.critical ? <CriticalMarker /> : null}
                <span>scenario {current.scenarioId}</span>
              </div>
            </div>
            <div className="review-section">
              <div className="review-label">What the agent was responding to</div>
              <div className="review-text">{current.input}</div>
              {current.context.length > 0 ? (
                <div style={{ marginTop: '0.6rem' }}>
                  <button type="button" className="btn btn-ghost btn-sm" aria-expanded={showContext} onClick={() => setShowContext(s => !s)}>
                    {showContext ? 'Hide the earlier conversation' : `Show the earlier conversation (${plural(current.context.length, 'turn')})`}
                  </button>
                  {showContext ? (
                    <div className="transcript" style={{ marginTop: '0.8rem' }}>
                      {current.context.map(t => <TurnView key={t.index} turn={{ ...t, at: '' }} />)}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="review-section">
              <div className="review-label">The reply being judged (turn [{current.outputTurn}])</div>
              <div className="review-text">{current.output}</div>
            </div>

            {phase === 'edit' || phase === 'saving' ? (
              <form
                className="review-section"
                onSubmit={e => {
                  e.preventDefault()
                  void submit()
                }}
                noValidate
              >
                <div className="form-group">
                  <div className="form-label" id="verdict-label">Your verdict</div>
                  <div className="verdict-toggle" role="group" aria-labelledby="verdict-label">
                    <button type="button" className="btn btn-success" aria-pressed={verdict === 'pass'} onClick={() => setVerdict('pass')}>Pass (P)</button>
                    <button type="button" className="btn btn-danger btn-fail" aria-pressed={verdict === 'fail'} onClick={() => setVerdict('fail')}>Fail (F)</button>
                  </div>
                  {showErrors && errors.verdict ? <div className="form-error" role="alert">{errors.verdict}</div> : null}
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="critique">Critique (required)</label>
                  <textarea
                    id="critique"
                    ref={critiqueRef}
                    className="form-textarea"
                    value={critique}
                    maxLength={MAX_CRITIQUE}
                    aria-required="true"
                    aria-invalid={showErrors && errors.critique ? true : undefined}
                    aria-describedby="critique-hint"
                    placeholder="Say what the agent did and why it does or does not meet the criterion. Cite turn numbers like [3] if it helps."
                    onChange={e => setCritique(e.target.value)}
                  />
                  <div id="critique-hint" className={showErrors && errors.critique ? 'form-error' : 'form-hint'} role={showErrors && errors.critique ? 'alert' : undefined}>
                    {showErrors && errors.critique ? errors.critique : 'Write enough that a new team member could follow your reasoning. Confirmations need a critique too.'}
                  </div>
                </div>
                <div className="form-group" style={{ maxWidth: 320 }}>
                  <label className="form-label" htmlFor="labeler">Your name</label>
                  <input
                    id="labeler"
                    className="form-input"
                    value={labeler}
                    maxLength={MAX_LABELER}
                    autoComplete="name"
                    aria-invalid={showErrors && errors.labeler ? true : undefined}
                    onChange={e => setLabeler(e.target.value)}
                    onBlur={() => labeler.trim() && writeStored(LABELER_KEY, labeler.trim())}
                  />
                  {showErrors && errors.labeler ? <div className="form-error" role="alert">{errors.labeler}</div> : <div className="form-hint">Saved in this browser so you do not retype it.</div>}
                </div>
                {problem ? <div style={{ marginBottom: '0.8rem' }}><Banner kind="danger" role="alert">{problem}</Banner></div> : null}
                <div className="row">
                  <button type="submit" className="btn btn-primary" disabled={!valid || phase === 'saving'}>
                    {phase === 'saving' ? <span className="spinner" aria-hidden="true" /> : null}
                    Save label
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={skip} disabled={phase === 'saving'}>Skip (N)</button>
                  {!valid ? <span className="small muted">Choose pass or fail and write a critique to save.</span> : null}
                  {problem && !valid ? null : problem ? <button type="button" className="btn btn-ghost" onClick={next}>Next item</button> : null}
                </div>
              </form>
            ) : (
              <div className="review-section stack" aria-label="After saving">
                <Banner kind="success" title="Label saved." role="status">
                  You said <strong>{saved?.verdict}</strong>. The server recorded it as a {saved?.sampled_by} sample.
                </Banner>
                <div className="crit-box"><h4>Your critique</h4>{saved?.critique}</div>
                {problem ? <Banner kind="danger" role="alert">{problem}</Banner> : null}
                {phase === 'revealed' && reveal ? (
                  <RevealView reveal={reveal} />
                ) : (
                  <div>
                    <button type="button" className="btn btn-primary" onClick={doReveal} disabled={phase === 'revealing'}>
                      {phase === 'revealing' ? <span className="spinner" aria-hidden="true" /> : null}
                      Reveal what the judge said
                    </button>
                    <p className="small muted" style={{ marginTop: '0.4rem' }}>Optional. Your label is already saved, so this cannot change it.</p>
                  </div>
                )}
                <div className="row">
                  <button type="button" className="btn btn-primary" onClick={next}>Next item</button>
                </div>
              </div>
            )}
          </article>
        </>
      )}
    </div>
  )
}

// -------------------------------------------------------------- labels screen

export function LabelsView() {
  const labels = useAsync(() => api.labels(), [])
  const [verdict, setVerdict] = useState('')
  const [sampled, setSampled] = useState('')
  const [labeler, setLabeler] = useState('')
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [reveals, setReveals] = useState<Record<string, RevealResponse | string>>({})

  const all = labels.data?.labels ?? []
  const rows = useMemo(() => {
    const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return all
      .filter(l => (verdict === '' || l.verdict === verdict) && (sampled === '' || l.sampled_by === sampled) && (labeler === '' || l.labeler === labeler))
      .filter(l => {
        const hay = `${l.id} ${l.criterion} ${l.critique} ${l.output} ${l.input ?? ''}`.toLowerCase()
        return words.every(w => hay.includes(w))
      })
      .sort((a, b) => b.at.localeCompare(a.at))
  }, [all, verdict, sampled, labeler, search])

  const doReveal = async (id: string) => {
    try {
      const r = await api.reveal(id)
      setReveals(prev => ({ ...prev, [id]: r }))
    } catch (e) {
      setReveals(prev => ({ ...prev, [id]: describeError(e) }))
    }
  }

  if (labels.loading && !labels.data) return <Loading label="Loading labels" />
  if (labels.error && !labels.data) return <ErrorState error={labels.error} onRetry={labels.reload} title="Could not load labels" />
  if (!labels.data) return null
  const stats = labels.data.stats

  return (
    <div className="stack">
      <div className="stats-row" style={{ marginBottom: 0 }}>
        <div className="stat-card"><div className="stat-num">{stats.total}</div><div className="stat-label">Labels</div></div>
        <div className="stat-card"><div className="stat-num">{stats.byVerdict.pass} / {stats.byVerdict.fail}</div><div className="stat-label">Pass / fail</div></div>
        <div className="stat-card">
          <div className="stat-num">{percent(stats.randomShare)}</div>
          <div className="stat-label">Random share</div>
          <div className="stat-sub">{stats.random} random, {stats.targeted} targeted. Minimum {percent(stats.minRandomShare)}.</div>
        </div>
        <div className="stat-card">
          <div className="stat-num">{stats.bySplit.dev} / {stats.bySplit.test}</div>
          <div className="stat-label">Dev / test</div>
          <div className="stat-sub">{stats.bySplit.train} in train</div>
        </div>
      </div>
      <Warnings items={stats.warnings} title="Label set warnings" />
      <div className="small muted">File: <span className="mono break">{labels.data.file}</span></div>

      <form className="filters" role="search" onSubmit={e => e.preventDefault()}>
        <div className="form-group wide">
          <label className="form-label" htmlFor="l-search">Search</label>
          <input id="l-search" type="search" className="form-input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Criterion, critique, text" />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="l-verdict">Verdict</label>
          <select id="l-verdict" className="form-select" value={verdict} onChange={e => setVerdict(e.target.value)}>
            <option value="">All</option><option value="pass">Pass</option><option value="fail">Fail</option>
          </select>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="l-sampled">Sampled</label>
          <select id="l-sampled" className="form-select" value={sampled} onChange={e => setSampled(e.target.value)}>
            <option value="">All</option><option value="random">Random</option><option value="targeted">Targeted</option>
          </select>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="l-labeler">Labeler</label>
          <select id="l-labeler" className="form-select" value={labeler} onChange={e => setLabeler(e.target.value)}>
            <option value="">Everyone</option>
            {stats.labelers.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
      </form>

      {all.length === 0 ? (
        <div className="card"><EmptyState title="No labels yet">Label items in the review queue and they are listed here.</EmptyState></div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="run-list-head"><span className="run-list-count" aria-live="polite">{plural(rows.length, 'label')}{rows.length !== all.length ? ` of ${all.length}` : ''}</span></div>
          {rows.length === 0 ? (
            <EmptyState title="No labels match">Change the filters to see more.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Verdict</th><th>Criterion</th><th>Sampled</th><th>Labeler</th><th>When</th><th><span className="sr-only">Details</span></th></tr></thead>
                <tbody>
                  {rows.map(l => {
                    const isOpen = open === l.id
                    const rv = reveals[l.id]
                    return (
                      <Fragment key={l.id}>
                        <tr>
                          <td><VerdictBadge verdict={l.verdict} /></td>
                          <td><div className="mono small break">{l.criterion}</div><div className="small muted break">{l.id}</div></td>
                          <td className="small">{l.sampled_by}</td>
                          <td className="small">{l.labeler}</td>
                          <td className="small">{shortDate(l.at)}</td>
                          <td><button type="button" className="btn btn-ghost btn-sm" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : l.id)}>{isOpen ? 'Hide' : 'Details'}</button></td>
                        </tr>
                        {isOpen ? (
                          <tr>
                            <td colSpan={6} style={{ background: 'var(--bg2)' }}>
                              <div className="stack">
                                {l.input ? <div className="crit-box"><h4>Input</h4>{l.input}</div> : null}
                                <div className="crit-box"><h4>Output</h4>{l.output}</div>
                                <div className="crit-box"><h4>Critique by {l.labeler}</h4>{l.critique}</div>
                                {l.group ? <div className="small muted">Group: <span className="mono">{l.group}</span></div> : null}
                                {rv === undefined ? (
                                  <div><button type="button" className="btn btn-ghost btn-sm" onClick={() => doReveal(l.id)}>Reveal what the judge said</button></div>
                                ) : typeof rv === 'string' ? (
                                  <Banner kind="info">{rv}</Banner>
                                ) : (
                                  <RevealView reveal={rv} />
                                )}
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ the page

export function ClassifyPage({ tab, onTab }: { tab: 'queue' | 'labels'; onTab(t: 'queue' | 'labels'): void }) {
  return (
    <>
      <PageHead
        title="Classify"
        sub="Label outputs pass or fail with a critique, before you see what the judge said. Your labels are what the judge is measured against."
      />
      <Tabs<'queue' | 'labels'>
        label="Classify views"
        value={tab}
        onChange={onTab}
        tabs={[
          { id: 'queue', label: 'Review queue' },
          { id: 'labels', label: 'All labels' },
        ]}
      />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'queue' ? <QueueView /> : <LabelsView />}
      </div>
    </>
  )
}

