import { useState } from 'react'
import type { Anchor, Rubric, RubricItem, RubricUpdateRequest, RubricUpdateResponse } from '../../../src/ui/api-types'
import { api, describeError, isApiFailure } from '../api/client'
import { useAsync } from '../api/useAsync'
import { href } from '../lib/router'
import { Banner, ConfirmDialog, CriticalMarker, ErrorState, VerdictBadge } from './ui'

// Edits a rubric file from the Scenarios page. The file stays the source of
// truth: saving writes that file through PUT /api/rubrics/:id, so the change is
// reviewed with git diff like any other. Criterion ids are fixed here (labels and
// runs refer to them), and the version goes up on every save.

export interface CriterionDraft {
  id: string
  text: string
  /** As typed, so a half-typed number is not lost. */
  weight: string
  critical: boolean
}

export interface AnchorDraft {
  /** A local key for React and for the example being edited. */
  key: number
  /** Index in the rubric as loaded, or null for an example added here. */
  origin: number | null
  /** '' for the rubric as a whole. */
  criterion: string
  input: string
  output: string
  verdict: 'pass' | 'fail'
  critique: string
}

export interface Draft {
  criteria: CriterionDraft[]
  context: string
  anchors: AnchorDraft[]
  /** The new version, when the current one is not a whole number. */
  version: string
}

let nextKey = 1

export function toDraft(r: Rubric): Draft {
  return {
    criteria: r.criteria.map(c => ({ id: c.id, text: c.text, weight: String(c.weight), critical: c.critical })),
    context: r.context ?? '',
    anchors: r.anchors.map((a, i) => ({ key: nextKey++, origin: i, criterion: a.criterion ?? '', input: a.input ?? '', output: a.output, verdict: a.verdict, critique: a.critique })),
    version: '',
  }
}

/** An example as the file holds it: optional fields only when set. */
export function toAnchor(a: Omit<AnchorDraft, 'key' | 'origin'>): Anchor {
  return {
    ...(a.criterion !== '' ? { criterion: a.criterion } : {}),
    ...(a.input !== '' ? { input: a.input } : {}),
    output: a.output,
    verdict: a.verdict,
    critique: a.critique,
  }
}

const sameAnchor = (a: Anchor, b: Anchor) => a.criterion === b.criterion && a.input === b.input && a.output === b.output && a.verdict === b.verdict && a.critique === b.critique

export const isWholeNumber = (version: string) => /^\d+$/.test(version)

/** The version a save makes: one more for a whole number, otherwise what was typed (null until something new is typed). */
export function nextVersion(current: string, typed: string): string | null {
  if (isWholeNumber(current)) return String(Number(current) + 1)
  const t = typed.trim()
  return t === '' || t === current ? null : t
}

export interface CriterionChange {
  id: string
  text: boolean
  weight: [number, number] | null
  critical: [boolean, boolean] | null
}

export interface ChangeSummary {
  criteria: CriterionChange[]
  added: number
  removed: number
  edited: number
  context: 'added' | 'changed' | 'removed' | null
}

const contextOf = (s: string | undefined) => (s === undefined || s.trim() === '' ? undefined : s)

export function summarize(r: Rubric, d: Draft): ChangeSummary {
  const criteria: CriterionChange[] = []
  r.criteria.forEach((c, i) => {
    const e = d.criteria[i]!
    const weight = Number(e.weight)
    const change: CriterionChange = {
      id: c.id,
      text: e.text !== c.text,
      weight: e.weight.trim() !== '' && weight !== c.weight ? [c.weight, weight] : null,
      critical: e.critical !== c.critical ? [c.critical, e.critical] : null,
    }
    if (change.text || change.weight || change.critical) criteria.push(change)
  })
  const kept = new Set(d.anchors.filter(a => a.origin !== null).map(a => a.origin))
  const before = contextOf(r.context)
  const after = contextOf(d.context)
  return {
    criteria,
    added: d.anchors.filter(a => a.origin === null).length,
    removed: r.anchors.filter((_, i) => !kept.has(i)).length,
    edited: d.anchors.filter(a => a.origin !== null && !sameAnchor(toAnchor(a), r.anchors[a.origin]!)).length,
    context: before === after ? null : before === undefined ? 'added' : after === undefined ? 'removed' : 'changed',
  }
}

export const hasChanges = (s: ChangeSummary) => s.criteria.length > 0 || s.added + s.removed + s.edited > 0 || s.context !== null

/** Same rules as the server: wording not blank, a weight above 0, and a new version when the current one is not a whole number. */
export function validateDraft(r: Rubric, d: Draft): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const c of d.criteria) {
    if (c.text.trim() === '') errors[`text:${c.id}`] = 'The wording cannot be empty.'
    const w = Number(c.weight)
    if (c.weight.trim() === '' || !Number.isFinite(w) || w <= 0) errors[`weight:${c.id}`] = 'Use a number above 0.'
  }
  if (!isWholeNumber(r.version) && nextVersion(r.version, d.version) === null) {
    errors.version = `Name the new version. It must differ from "${r.version}".`
  }
  return errors
}

export function toRequest(item: RubricItem, d: Draft): RubricUpdateRequest {
  return {
    baseHash: item.hash,
    criteria: d.criteria.map(c => ({ id: c.id, text: c.text, weight: Number(c.weight), critical: c.critical })),
    context: contextOf(d.context) ?? null,
    anchors: d.anchors.map(toAnchor),
    ...(isWholeNumber(item.rubric.version) ? {} : { version: d.version.trim() }),
  }
}

/** "3 labels were made against the old wording of x. If the meaning changed, review them in Classify." */
export function LabelImpactLine({ criterion, labels }: { criterion: string; labels: number }) {
  return (
    <p className="small" data-testid="label-impact">
      {labels === 1 ? '1 label was' : `${labels} labels were`} made against the old wording of <span className="mono">{criterion}</span>. If the meaning changed, review them in{' '}
      <a href={href('/classify/labels')}>Classify</a>.
    </p>
  )
}

function changeLines(s: ChangeSummary): string[] {
  const lines = s.criteria.map(c => {
    const parts: string[] = []
    if (c.text) parts.push('new wording')
    if (c.weight) parts.push(`weight ${c.weight[0]} to ${c.weight[1]}`)
    if (c.critical) parts.push(c.critical[1] ? 'now critical' : 'no longer critical')
    return `Criterion ${c.id}: ${parts.join(', ')}.`
  })
  const examples = [s.added ? `${s.added} added` : '', s.edited ? `${s.edited} edited` : '', s.removed ? `${s.removed} removed` : ''].filter(Boolean)
  if (examples.length > 0) lines.push(`Worked examples: ${examples.join(', ')}.`)
  if (s.context) lines.push(`Reference facts ${s.context}.`)
  return lines
}

// ------------------------------------------------------------ one example

function AnchorForm({
  initial, criteria, idPrefix, label, onDone, onCancel,
}: {
  initial: AnchorDraft
  label: string
  criteria: string[]
  idPrefix: string
  onDone(a: AnchorDraft): void
  onCancel(): void
}) {
  const [a, setA] = useState(initial)
  const [tried, setTried] = useState(false)
  const errors = { output: a.output.trim() === '' ? 'Add the reply this example judges.' : undefined, critique: a.critique.trim() === '' ? 'A critique is required on every example.' : undefined }
  const valid = !errors.output && !errors.critique
  const id = (f: string) => `${idPrefix}-${f}`
  const set = (patch: Partial<AnchorDraft>) => setA(prev => ({ ...prev, ...patch }))
  return (
    <div className="card-sm" role="group" aria-label={label}>
      <div className="grid-2">
        <div className="form-group">
          <label className="form-label" htmlFor={id('criterion')}>Criterion</label>
          <select id={id('criterion')} className="form-select" value={a.criterion} onChange={e => set({ criterion: e.target.value })}>
            <option value="">Whole rubric</option>
            {criteria.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor={id('verdict')}>Verdict</label>
          <select id={id('verdict')} className="form-select" value={a.verdict} onChange={e => set({ verdict: e.target.value as 'pass' | 'fail' })}>
            <option value="pass">Pass</option>
            <option value="fail">Fail</option>
          </select>
        </div>
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor={id('input')}>Input (optional)</label>
        <textarea id={id('input')} className="form-textarea" value={a.input} onChange={e => set({ input: e.target.value })} placeholder="What the agent was responding to" />
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor={id('output')}>Output</label>
        <textarea id={id('output')} className="form-textarea" value={a.output} aria-invalid={tried && errors.output ? true : undefined} onChange={e => set({ output: e.target.value })} placeholder="The reply being judged" />
        {tried && errors.output ? <div className="form-error" role="alert">{errors.output}</div> : null}
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor={id('critique')}>Critique</label>
        <textarea id={id('critique')} className="form-textarea" value={a.critique} aria-invalid={tried && errors.critique ? true : undefined} onChange={e => set({ critique: e.target.value })} placeholder="Why the reply passes or fails, as the judge should reason" />
        {tried && errors.critique ? <div className="form-error" role="alert">{errors.critique}</div> : null}
      </div>
      <div className="row">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => (valid ? onDone(a) : setTried(true))}>Done</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

// ------------------------------------------------------------- the editor

export function RubricEditor({
  item, focus, onSaved, onCancel, onReload,
}: {
  item: RubricItem
  /** A criterion to highlight, from a deep link. */
  focus?: string
  onSaved(res: RubricUpdateResponse): void
  onCancel(): void
  /** Throws the draft away and loads the file again. */
  onReload(): void
}) {
  const r = item.rubric
  const labels = useAsync(() => api.labels(), [])
  const [draft, setDraft] = useState<Draft>(() => toDraft(r))
  // The example open in a form: an existing one by key, or a new one.
  const [open, setOpen] = useState<number | null>(null)
  const [adding, setAdding] = useState<AnchorDraft | null>(null)
  const formOpen = open !== null || adding !== null
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<unknown>(null)
  const [stale, setStale] = useState<string | null>(null)

  const summary = summarize(r, draft)
  const changed = hasChanges(summary)
  const errors = validateDraft(r, draft)
  const invalid = Object.keys(errors).length > 0
  const version = nextVersion(r.version, draft.version)
  const ids = r.criteria.map(c => c.id)
  const p = `edit-${r.id}`

  const setCriterion = (i: number, patch: Partial<CriterionDraft>) =>
    setDraft(d => ({ ...d, criteria: d.criteria.map((c, j) => (j === i ? { ...c, ...patch } : c)) }))

  const impact = summary.criteria.filter(c => c.text).map(c => ({ criterion: c.id, labels: (labels.data?.labels ?? []).filter(l => l.criterion === c.id).length }))

  const save = async () => {
    setSaving(true)
    setProblem(null)
    try {
      const res = await api.updateRubric(r.id, toRequest(item, draft))
      setSaving(false)
      setConfirming(false)
      onSaved(res)
    } catch (e) {
      setSaving(false)
      setConfirming(false)
      if (isApiFailure(e) && e.code === 'stale') setStale(e.message)
      else setProblem(e)
    }
  }

  return (
    <div className="stack" aria-label={`Edit rubric ${r.id}`}>
      <Banner kind="info">
        Saving writes to <span className="mono break">{item.relativeFile}</span>, so the change shows in git diff for review. Criterion ids stay as they are, because labels and runs refer to them.
      </Banner>

      <section>
        <div className="review-label">Criteria</div>
        <div className="verdict-list">
          {draft.criteria.map((c, i) => (
            <div className={`verdict-item${focus === c.id ? ' highlight' : ''}`} key={c.id} data-criterion={c.id}>
              <div className="verdict-top">
                <span className="verdict-name">{c.id}</span>
                {c.critical ? <CriticalMarker /> : null}
              </div>
              <div className="form-group" style={{ marginTop: '0.5rem' }}>
                <label className="form-label" htmlFor={`${p}-text-${c.id}`}>Wording of {c.id}</label>
                <textarea
                  id={`${p}-text-${c.id}`}
                  className="form-textarea"
                  value={c.text}
                  aria-invalid={errors[`text:${c.id}`] ? true : undefined}
                  onChange={e => setCriterion(i, { text: e.target.value })}
                />
                {errors[`text:${c.id}`] ? <div className="form-error" role="alert">{errors[`text:${c.id}`]}</div> : null}
              </div>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <div className="form-group" style={{ maxWidth: 160, marginBottom: 0 }}>
                  <label className="form-label" htmlFor={`${p}-weight-${c.id}`}>Weight</label>
                  <input
                    id={`${p}-weight-${c.id}`}
                    type="number"
                    min="0"
                    step="any"
                    className="form-input"
                    value={c.weight}
                    aria-invalid={errors[`weight:${c.id}`] ? true : undefined}
                    onChange={e => setCriterion(i, { weight: e.target.value })}
                  />
                  {errors[`weight:${c.id}`] ? <div className="form-error" role="alert">{errors[`weight:${c.id}`]}</div> : null}
                </div>
                <label className="check-row" style={{ marginTop: '1.4rem' }}>
                  <input type="checkbox" checked={c.critical} onChange={e => setCriterion(i, { critical: e.target.checked })} />
                  <span>Critical (a failure blocks a release)</span>
                </label>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="form-group" style={{ marginBottom: 0 }}>
        <label className="form-label" htmlFor={`${p}-context`}>Reference facts (shown to the judge as ground truth)</label>
        <textarea id={`${p}-context`} className="form-textarea" style={{ minHeight: 160 }} value={draft.context} onChange={e => setDraft(d => ({ ...d, context: e.target.value }))} />
        <div className="form-hint">Facts the judge may check the agent's claims against. Leave this empty to remove them.</div>
      </div>

      <section>
        <div className="review-label">Worked examples (few-shot examples shown to the judge)</div>
        <div className="stack-sm">
          {draft.anchors.length === 0 ? <p className="small muted">None.</p> : null}
          {draft.anchors.map((a, i) =>
            open === a.key ? (
              <AnchorForm
                key={a.key}
                initial={a}
                criteria={ids}
                idPrefix={`${p}-anchor-${a.key}`}
                label={`Edit example ${i + 1}`}
                onDone={next => {
                  setDraft(d => ({ ...d, anchors: d.anchors.map(x => (x.key === a.key ? next : x)) }))
                  setOpen(null)
                }}
                onCancel={() => setOpen(null)}
              />
            ) : (
              <div className={`card-sm${focus !== undefined && a.criterion === focus ? ' highlight' : ''}`} key={a.key}>
                <div className="row" style={{ marginBottom: '0.4rem' }}>
                  <VerdictBadge verdict={a.verdict} />
                  <span className="small mono">{a.criterion || 'whole rubric'}</span>
                  <span className="row" style={{ marginLeft: 'auto', gap: '0.4rem' }}>
                    <button type="button" className="btn btn-ghost btn-sm" aria-label={`Edit example ${i + 1}`} disabled={formOpen} onClick={() => setOpen(a.key)}>Edit</button>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      aria-label={`Delete example ${i + 1}`}
                      disabled={formOpen}
                      onClick={() => setDraft(d => ({ ...d, anchors: d.anchors.filter(x => x.key !== a.key) }))}
                    >
                      Delete
                    </button>
                  </span>
                </div>
                {a.input ? <div className="crit-box" style={{ marginBottom: '0.4rem' }}><h4>Input</h4>{a.input}</div> : null}
                <div className="crit-box" style={{ marginBottom: '0.4rem' }}><h4>Output</h4>{a.output}</div>
                <div className="crit-box"><h4>Critique</h4>{a.critique}</div>
              </div>
            ),
          )}
          {adding ? (
            <AnchorForm
              initial={adding}
              criteria={ids}
              idPrefix={`${p}-anchor-new`}
              label="New example"
              onDone={a => {
                setDraft(d => ({ ...d, anchors: [...d.anchors, a] }))
                setAdding(null)
              }}
              onCancel={() => setAdding(null)}
            />
          ) : (
            <div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={formOpen}
                onClick={() => setAdding({ key: nextKey++, origin: null, criterion: focus && ids.includes(focus) ? focus : '', input: '', output: '', verdict: 'fail', critique: '' })}
              >
                Add example
              </button>
            </div>
          )}
        </div>
      </section>

      {isWholeNumber(r.version) ? null : (
        <div className="form-group" style={{ maxWidth: 320, marginBottom: 0 }}>
          <label className="form-label" htmlFor={`${p}-version`}>New version</label>
          <input id={`${p}-version`} className="form-input" value={draft.version} aria-invalid={errors.version ? true : undefined} onChange={e => setDraft(d => ({ ...d, version: e.target.value }))} />
          <div className={errors.version ? 'form-error' : 'form-hint'}>
            {errors.version ?? 'This rubric\'s version is not a whole number, so the new one needs a name.'}
          </div>
        </div>
      )}

      {stale ? (
        <Banner kind="danger" title="Not saved." role="alert">
          {stale} Reloading throws away the edits on this page, so copy anything you want to keep first.
          <div style={{ marginTop: '0.6rem' }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onReload}>Reload the rubric</button>
          </div>
        </Banner>
      ) : null}
      {problem ? <ErrorState error={problem} title="Could not save the rubric" /> : null}

      <div className="row">
        <button type="button" className="btn btn-primary" disabled={!changed || invalid || formOpen || stale !== null} onClick={() => setConfirming(true)}>
          Review and save
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel editing</button>
        <span className="small muted">
          {!changed ? 'Change something to save.' : invalid ? 'Fix the fields marked above to save.' : formOpen ? 'Finish the example you are editing first.' : ''}
        </span>
      </div>

      {confirming ? (
        <ConfirmDialog title={`Save changes to ${r.id}?`} confirmLabel="Save to the file" cancelLabel="Back to editing" busy={saving} onConfirm={save} onCancel={() => setConfirming(false)}>
          <p>
            This writes to <span className="mono break">{item.relativeFile}</span>.
          </p>
          <ul className="small" style={{ margin: '0.6rem 0 0.8rem 1.2rem' }}>
            {changeLines(summary).map(l => <li key={l}>{l}</li>)}
          </ul>
          <p>Saving makes this version {version}. Past runs and calibrations keep showing the version they used.</p>
          {impact.length > 0 ? (
            labels.loading && !labels.data ? (
              <p className="small muted">Counting the labels made against the old wording.</p>
            ) : labels.error && !labels.data ? (
              <p className="small muted">The labels could not be counted: {describeError(labels.error)}</p>
            ) : (
              impact.filter(x => x.labels > 0).map(x => <LabelImpactLine key={x.criterion} {...x} />)
            )
          ) : null}
        </ConfirmDialog>
      ) : null}
    </div>
  )
}
