import { useEffect, useId, useState } from 'react'
import type { Label, LabelMeta, RubricItem, Split } from '../../../src/ui/api-types'
import { ApiFailure, api, describeError } from '../api/client'
import { criterionHref } from '../lib/router'
import { Banner, ConfirmDialog, Loading, VerdictBadge } from './ui'

// "Use as worked example": one click (and a confirmation) turns a training
// label into a worked example in its rubric, the way the judge is taught. It is
// offered only on labelled items, so nothing about the judge shows before a
// label is saved. Dev and test labels are refused: they are what calibration
// measures the judge on, so the judge must never have seen them.

const SPLIT_TITLE: Record<Split, string> = {
  train: 'Training split. A training label can become a worked example.',
  dev: 'Dev split. Calibration measures the judge on these while you iterate.',
  test: 'Test split. Held back for a final measurement of the judge.',
}

export const NOT_TRAIN_HINT = 'Only training labels can become worked examples, so dev and test stay an honest check of the judge.'

export function SplitBadge({ split }: { split: Split }) {
  return <span className="badge badge-tag" title={SPLIT_TITLE[split]} data-split={split}>{split}</span>
}

/** The version a save makes: a whole number goes up by one. */
export function nextVersion(version: string): string | null {
  return /^\d+$/.test(version) ? String(Number(version) + 1) : null
}

function ExampleDialog({ label, itemId, rubricId, onDone, onCancel }: { label: Label; itemId: string; rubricId: string; onDone(): void; onCancel(): void }) {
  const ids = useId()
  const [rubric, setRubric] = useState<RubricItem | null>(null)
  const [input, setInput] = useState(label.input ?? '')
  const [output, setOutput] = useState(label.output)
  const [critique, setCritique] = useState(label.critique)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const loadRubric = () =>
    api
      .rubrics()
      .then(r => {
        const found = r.rubrics.find(x => x.rubric.id === rubricId) ?? null
        setRubric(found)
        if (!found) setProblem(`Rubric ${rubricId} is not loaded any more.`)
      })
      .catch(e => setProblem(describeError(e)))
  useEffect(() => {
    void loadRubric()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rubricId])

  const blank = output.trim() === '' || critique.trim() === ''
  const confirm = async () => {
    if (busy) return
    if (!rubric) {
      setProblem('The rubric is still being read. Try again in a moment.')
      return
    }
    if (blank) {
      setProblem('The output and the critique cannot be blank.')
      return
    }
    setBusy(true)
    setProblem(null)
    try {
      await api.anchorFromLabel(rubricId, {
        itemId,
        baseHash: rubric.hash,
        ...(input !== (label.input ?? '') ? { input } : {}),
        ...(output !== label.output ? { output } : {}),
        ...(critique !== label.critique ? { critique: critique.trim() } : {}),
      })
      onDone()
    } catch (e) {
      setBusy(false)
      if (e instanceof ApiFailure && e.code === 'stale') {
        setProblem('The rubric file changed on disk since it was read. It has been read again: check the version below and confirm again.')
        void loadRubric()
      } else setProblem(describeError(e))
    }
  }

  const version = rubric ? nextVersion(rubric.rubric.version) : null
  return (
    <ConfirmDialog title="Use as a worked example" confirmLabel="Confirm" onConfirm={confirm} onCancel={onCancel} busy={busy}>
      <div className="example-form stack">
        {rubric ? (
          <p className="small" data-testid="example-impact">
            Adds this to rubric {rubricId} and makes it {version ? `version ${version}` : 'a new version'}. The judge sees every worked example on every grading call, so each call costs slightly more.
          </p>
        ) : problem ? null : (
          <Loading label="Reading the rubric" />
        )}
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label" htmlFor={`${ids}-input`}>Input</label>
          <textarea id={`${ids}-input`} className="form-textarea" value={input} onChange={e => setInput(e.target.value)} />
          <div className="form-hint">Trim a long transcript to the part that matters. Leave it blank for no input.</div>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label" htmlFor={`${ids}-output`}>Output</label>
          <textarea id={`${ids}-output`} className="form-textarea" value={output} onChange={e => setOutput(e.target.value)} />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <div className="form-label">Verdict (from the label)</div>
          <VerdictBadge verdict={label.verdict} />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label" htmlFor={`${ids}-critique`}>Critique</label>
          <textarea id={`${ids}-critique`} className="form-textarea" value={critique} onChange={e => setCritique(e.target.value)} />
        </div>
        <p className="small muted">Your label stays as it is. Only the rubric file changes.</p>
        {problem ? <Banner kind="danger" role="alert">{problem}</Banner> : null}
      </div>
    </ConfirmDialog>
  )
}

/**
 * The control for one labelled item: an Example badge when it already is one,
 * a disabled button with the reason for a dev or test label, and otherwise the
 * button that opens the dialog.
 */
export function WorkedExampleAction({ label, itemId, meta, onAdded }: { label: Label; itemId: string; meta: LabelMeta | undefined; onAdded?(): void }) {
  const hintId = useId()
  const [open, setOpen] = useState(false)
  const [added, setAdded] = useState(false)
  if (!meta) return null
  if (added) {
    return (
      <Banner kind="success" role="status">
        Added as a worked example. <a href={criterionHref(label.criterion, meta.rubricId)}>See it on the Rubrics tab</a>
      </Banner>
    )
  }
  if (meta.isExample) return <span className="badge badge-accent" title={`A worked example in rubric ${meta.rubricId ?? ''}`}>Example</span>
  const reason = meta.split !== 'train' ? NOT_TRAIN_HINT : meta.rubricId === null ? 'No loaded rubric has this criterion, so there is no rubric to add it to.' : null
  return (
    <div className="row">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={reason !== null}
        title={reason ?? undefined}
        aria-describedby={reason ? hintId : undefined}
        onClick={() => setOpen(true)}
      >
        Use as worked example
      </button>
      {reason ? <span id={hintId} className="small muted">{reason}</span> : null}
      {open && meta.rubricId ? (
        <ExampleDialog
          label={label}
          itemId={itemId}
          rubricId={meta.rubricId}
          onCancel={() => setOpen(false)}
          onDone={() => {
            setOpen(false)
            setAdded(true)
            onAdded?.()
          }}
        />
      ) : null}
    </div>
  )
}
