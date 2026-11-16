import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Label, LabelStats, QueueItem, QueueStats, RevealResponse } from '../../../src/ui/api-types'
import { api, describeError, isApiFailure } from '../api/client'
import { useAsync } from '../api/useAsync'
import { TurnView } from './RunDetailPage'
import { Banner, CriticalMarker, EmptyState, ErrorState, Loading, PageHead, Tabs, VerdictBadge, Warnings } from '../components/ui'
import { percent, plural, shortDate } from '../lib/format'
import { criterionHref, runHref } from '../lib/router'
import { readStored, writeStored } from '../lib/storage'

// Blind labelling. The queue item has the input, the output being judged and the
// criterion. It does not show the judge's verdict or critique, and it does not
// show the item's `reason` (a targeted reason hints that the judge failed the
// run). The judge's answer comes from the reveal endpoint, which this page only
// calls after the label is saved. See docs/design/0003-ui-and-api.md.
//
// A saved label can be changed later. The change is saved as a new line that
// replaces the current one, and the first, blind label stays in the file. Every
// change is treated as made after seeing the judge.

export const LABELER_KEY = 'evals-ui-labeler'
export const MAX_CRITIQUE = 20_000
export const MAX_LABELER = 100
// The server's largest page. The picker lists the whole queue, so ask for all it will give.
const QUEUE_LIMIT = 200

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

type Phase = 'edit' | 'saving' | 'saved' | 'revealing' | 'revealed' | 'revising'

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

// ------------------------------------------------------------- jump to an item

// The picker lists exactly the items the queue returned, in an order that says
// nothing about the judge: scenario id, then criterion id, then run time. It never
// uses `reason`, the judge's outcome or the queue position, and no entry text
// contains them. The server still decides what may be labelled.

export interface PickerEntry {
  itemId: string
  scenarioId: string
  /** What an option shows under its scenario heading: criterion, critical marker, run and date. */
  label: string
}
export interface PickerGroup {
  scenarioId: string
  entries: PickerEntry[]
}

/** A UUID run id is too long to read, and its first eight characters tell runs apart. */
export function shortRunId(runId: string): string {
  return runId.slice(0, 8)
}

export function pickerLabel(item: QueueItem): string {
  const parts = [item.criterion.id + (item.criterion.critical ? ' (Critical)' : ''), `run ${shortRunId(item.runId)}`]
  if (item.startedAt) parts.push(shortDate(item.startedAt))
  return parts.join(' \u00b7 ')
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Scenario id, criterion id, run time, then run id and item id so equal times still sort the same way every time. */
export function sortForPicker(items: QueueItem[]): QueueItem[] {
  return [...items].sort(
    (a, b) =>
      cmp(a.scenarioId, b.scenarioId) || cmp(a.criterion.id, b.criterion.id) || cmp(a.startedAt ?? '', b.startedAt ?? '') || cmp(a.runId, b.runId) || cmp(a.itemId, b.itemId),
  )
}

/**
 * The picker's entries grouped by scenario. A filter keeps entries whose scenario or label contains every word,
 * and `keepId` (the current item) stays in whatever the filter says, so the select always has its own value.
 */
export function pickerGroups(items: QueueItem[], filter = '', keepId?: string): PickerGroup[] {
  const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const groups: PickerGroup[] = []
  for (const item of sortForPicker(items)) {
    const label = pickerLabel(item)
    const hay = `${item.scenarioId} ${label}`.toLowerCase()
    if (item.itemId !== keepId && !words.every(w => hay.includes(w))) continue
    let g = groups[groups.length - 1]
    if (!g || g.scenarioId !== item.scenarioId) {
      g = { scenarioId: item.scenarioId, entries: [] }
      groups.push(g)
    }
    g.entries.push({ itemId: item.itemId, scenarioId: item.scenarioId, label })
  }
  return groups
}

/** "Item N of M": the item's place in the picker's order among the loaded items, or null when it is not loaded. */
export function pickerPosition(items: QueueItem[], itemId: string): { n: number; of: number } | null {
  const i = sortForPicker(items).findIndex(x => x.itemId === itemId)
  return i < 0 ? null : { n: i + 1, of: items.length }
}

/** The item with this id first and the others in their order. The same list when the id is not in it. */
export function moveToFront(items: QueueItem[], itemId: string): QueueItem[] {
  const i = items.findIndex(x => x.itemId === itemId)
  if (i <= 0) return items
  return [items[i]!, ...items.slice(0, i), ...items.slice(i + 1)]
}

/** `#/classify?item=<id>` opens the queue with that item current when it is in the loaded list. */
export function applyDeepLink(items: QueueItem[], itemId: string | undefined | null): { items: QueueItem[]; found: boolean } {
  if (!itemId) return { items, found: false }
  if (!items.some(x => x.itemId === itemId)) return { items, found: false }
  return { items: moveToFront(items, itemId), found: true }
}

/** Something typed or chosen that switching items would throw away. */
export function hasDraft(v: { verdict: 'pass' | 'fail' | null; critique: string }): boolean {
  return v.verdict !== null || v.critique.trim() !== ''
}

function ItemPicker({
  items, currentId, disabled, capped, onPick,
}: {
  items: QueueItem[]
  currentId: string
  disabled: boolean
  capped: { shown: number; pending: number } | null
  onPick(itemId: string): void
}) {
  const [filter, setFilter] = useState('')
  const groups = useMemo(() => pickerGroups(items, filter, currentId), [items, filter, currentId])
  const others = groups.reduce((n, g) => n + g.entries.filter(e => e.itemId !== currentId).length, 0)
  const showFilter = items.length > 12
  return (
    <div className="card-sm" role="group" aria-label="Jump to an item">
      <div className="filters" style={{ marginBottom: 0 }}>
        <div className="form-group wide">
          <label className="form-label" htmlFor="item-picker">Jump to an item</label>
          <select id="item-picker" className="form-select" value={currentId} disabled={disabled} onChange={e => onPick(e.target.value)}>
            {groups.map(g => (
              <optgroup key={g.scenarioId} label={g.scenarioId}>
                {g.entries.map(e => <option key={e.itemId} value={e.itemId}>{e.label}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
        {showFilter ? (
          <div className="form-group">
            <label className="form-label" htmlFor="item-filter">Filter the list</label>
            <input id="item-filter" type="search" className="form-input" value={filter} onChange={e => setFilter(e.target.value)} placeholder="Scenario, criterion, run" />
          </div>
        ) : null}
      </div>
      <p className="form-hint" aria-live="polite">
        Listed by scenario, then criterion, then run time.{' '}
        {filter.trim() !== '' ? `${others} other ${others === 1 ? 'item matches' : 'items match'} the filter. ` : ''}
        {capped ? `The list shows ${capped.shown} of the ${capped.pending} items up for review. The rest load when this batch is done.` : ''}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------- reveal view

const verdictWord = (v: 'pass' | 'fail') => (v === 'pass' ? 'Pass' : 'Fail')

/**
 * Opens the criterion on the Scenarios page, where the rubric can be edited. The
 * rubric's text is the question, never the judge's answer, so showing the link
 * before the label is saved keeps the labelling blind. A new tab keeps an
 * unsaved label in this one.
 */
export function CriterionLink({ criterion, rubricId }: { criterion: string; rubricId?: string | null }) {
  return (
    <a className="small" href={criterionHref(criterion, rubricId)} target="_blank" rel="noopener noreferrer" title="Opens in a new tab">
      View or edit this criterion
    </a>
  )
}

/** One sentence about a label that was changed after the first save, or null when it never was. */
export function revisionNote(reveal: Pick<RevealResponse, 'original' | 'human' | 'revisions'>): string | null {
  const { original, human } = reveal
  if (!original || reveal.revisions === 0) return null
  return original.verdict !== human.verdict
    ? `You changed this from ${verdictWord(original.verdict)} to ${verdictWord(human.verdict)} after seeing the judge.`
    : `You changed your critique after seeing the judge. The verdict is still ${verdictWord(human.verdict)}.`
}

export function RevealView({ reveal, criterion }: { reveal: RevealResponse; criterion?: { id: string; rubricId?: string | null } }) {
  const { judge, human } = reveal
  const note = revisionNote(reveal)
  return (
    <div className="stack" aria-label="What the judge said">
      {judge === null ? (
        <Banner kind="info" title="The judge never decided this criterion.">
          {reveal.runError ? <>The run ended with an error first: <span className="break">{reveal.runError}</span></> : 'There is no judge verdict to compare with.'}
        </Banner>
      ) : judge.verdict === 'not_applicable' ? (
        <Banner kind="info" title="The judge found this criterion not applicable.">
          Its situation never arose in the run, so the judge did not grade it and there is no verdict to compare with.
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
      {note && reveal.original ? (
        <div className="crit-box" aria-label="Your first label">
          <h4>Your first label, made blind</h4>
          <div className="row" style={{ marginBottom: '0.4rem' }}><VerdictBadge verdict={reveal.original.verdict} /><span className="small muted">{shortDate(reveal.original.at)}</span></div>
          {reveal.original.critique}
          <p className="small muted" style={{ marginTop: '0.5rem', whiteSpace: 'normal' }} role="status">{note}</p>
        </div>
      ) : null}
      {reveal.runId || criterion ? (
        <div className="row">
          {reveal.runId ? <a href={runHref(reveal.runId)} className="small">Open the whole run</a> : null}
          {criterion ? <CriterionLink criterion={criterion.id} rubricId={criterion.rubricId} /> : null}
        </div>
      ) : null}
    </div>
  )
}

// --------------------------------------------------------- changing a label

/**
 * Changes a saved label. Pre-filled with the current label. Saving appends a
 * new line that replaces it, and the first, blind label stays in the file.
 */
export function ReviseForm({
  itemId, current, idPrefix, onSaved, onCancel,
}: {
  itemId: string
  current: Pick<Label, 'verdict' | 'critique' | 'labeler'>
  /** Keeps element ids unique when more than one form can be on the page. */
  idPrefix: string
  onSaved(label: Label): void
  onCancel(): void
}) {
  const [verdict, setVerdict] = useState<'pass' | 'fail' | null>(current.verdict)
  const [critique, setCritique] = useState(current.critique)
  const [labeler, setLabeler] = useState(() => readStored(LABELER_KEY) ?? current.labeler)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const errors = validateLabel({ verdict, critique, labeler })
  const unchanged = verdict === current.verdict && critique.trim() === current.critique.trim()
  const valid = Object.keys(errors).length === 0 && !unchanged
  const ids = { verdict: `${idPrefix}-verdict`, critique: `${idPrefix}-critique`, labeler: `${idPrefix}-labeler` }

  const save = async () => {
    if (!valid || verdict === null || saving) return
    setSaving(true)
    setProblem(null)
    try {
      const res = await api.revise(itemId, { verdict, critique: critique.trim(), labeler: labeler.trim() })
      writeStored(LABELER_KEY, labeler.trim())
      onSaved(res.label)
    } catch (e) {
      setSaving(false)
      setProblem(describeError(e))
    }
  }

  return (
    <form
      className="card-sm"
      aria-label="Change the label"
      onSubmit={e => {
        e.preventDefault()
        void save()
      }}
      onKeyDown={e => {
        if (e.key === 'Escape' && !saving) {
          e.preventDefault()
          onCancel()
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          void save()
        }
      }}
      noValidate
    >
      <p className="small muted" style={{ marginBottom: '0.8rem' }}>
        Your first label stays on file. The change is saved as a new version, marked as made after seeing the judge.
      </p>
      <div className="form-group">
        <div className="form-label" id={ids.verdict}>Your verdict</div>
        <div className="verdict-toggle" role="group" aria-labelledby={ids.verdict}>
          <button type="button" className="btn btn-success" aria-pressed={verdict === 'pass'} onClick={() => setVerdict('pass')}>Pass</button>
          <button type="button" className="btn btn-danger btn-fail" aria-pressed={verdict === 'fail'} onClick={() => setVerdict('fail')}>Fail</button>
        </div>
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor={ids.critique}>Critique (required)</label>
        <textarea
          id={ids.critique}
          className="form-textarea"
          autoFocus
          value={critique}
          maxLength={MAX_CRITIQUE}
          aria-required="true"
          aria-invalid={errors.critique ? true : undefined}
          onChange={e => setCritique(e.target.value)}
        />
        {errors.critique ? <div className="form-error" role="alert">{errors.critique}</div> : <div className="form-hint">Say what changed your mind, so the reason is on file too.</div>}
      </div>
      <div className="form-group" style={{ maxWidth: 320 }}>
        <label className="form-label" htmlFor={ids.labeler}>Your name</label>
        <input id={ids.labeler} className="form-input" value={labeler} maxLength={MAX_LABELER} autoComplete="name" aria-invalid={errors.labeler ? true : undefined} onChange={e => setLabeler(e.target.value)} />
        {errors.labeler ? <div className="form-error" role="alert">{errors.labeler}</div> : null}
      </div>
      {problem ? <div style={{ marginBottom: '0.8rem' }}><Banner kind="danger" role="alert">{problem}</Banner></div> : null}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={!valid || saving}>
          {saving ? <span className="spinner" aria-hidden="true" /> : null}
          Save the change
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={saving}>Cancel</button>
        {unchanged ? <span className="small muted">Change the verdict or the critique to save.</span> : null}
      </div>
    </form>
  )
}

// --------------------------------------------------------------- queue screen

export function QueueView({ itemId }: { itemId?: string } = {}) {
  const queue = useAsync(() => api.queue(QUEUE_LIMIT), [])
  const labels = useAsync(() => api.labels(), [])
  // Only to link a criterion to its rubric. A failure leaves the link without a rubric id, and the Scenarios page finds it.
  const rubrics = useAsync(() => api.rubrics(), [])
  const rubricOf = (scenarioId: string) => rubrics.data?.rubrics.find(r => r.usedBy.includes(scenarioId))?.rubric.id
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
  const [linkMissing, setLinkMissing] = useState(false)
  const critiqueRef = useRef<HTMLTextAreaElement>(null)
  // The deep-link id that has been acted on, so a reload of the list does not move that item to the front again.
  const linkHandled = useRef<string | undefined>(undefined)

  // Take a fresh page from the server on load and whenever the local page runs out.
  useEffect(() => {
    if (queue.data) {
      let list = queue.data.items
      if (itemId && linkHandled.current !== itemId) {
        const r = applyDeepLink(list, itemId)
        list = r.items
        setLinkMissing(!r.found)
        linkHandled.current = itemId
      }
      setItems(list)
      setStats(queue.data.stats)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Make a listed item the current one. The others keep their order behind it. A typed draft is not thrown away without asking.
  const jumpTo = (id: string) => {
    if (!current || id === current.itemId || phase === 'saving') return
    if (phase === 'edit' && hasDraft({ verdict, critique }) && !window.confirm('Switch to another item? What you chose or typed for this one will be discarded.')) return
    // After a save the current item has its label already, so it leaves the list as it does on Next.
    const labelled = phase !== 'edit'
    setItems(prev => moveToFront(labelled ? prev.filter(x => x.itemId !== current.itemId) : prev, id))
    setLinkMissing(false)
    resetForm()
  }

  // The address changed while the page is open (a new #/classify?item=... link).
  useEffect(() => {
    if (!itemId) {
      linkHandled.current = undefined
      setLinkMissing(false)
      return
    }
    if (!queue.data || linkHandled.current === itemId) return
    linkHandled.current = itemId
    if (applyDeepLink(items, itemId).found) jumpTo(itemId)
    else setLinkMissing(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId])

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
    api.queue(QUEUE_LIMIT).then(q => setStats(q.stats)).catch(() => {})
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

  // Changing the label is offered only once the judge has been revealed, so a change is always on a saved label.
  const startRevise = useCallback(() => {
    if (phase === 'revealed' && saved) setPhase('revising')
  }, [phase, saved])

  const onRevised = async (label: Label) => {
    if (!current) return
    setSaved(label)
    setProblem(null)
    setPhase('revealing')
    refreshStats()
    try {
      setReveal(await api.reveal(current.itemId))
    } catch (e) {
      setProblem(`The change is saved, but the comparison could not be refreshed: ${describeError(e)}`)
    }
    setPhase('revealed')
  }

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
        else if (key === 'e' && phase === 'revealed') {
          e.preventDefault()
          startRevise()
        } else if (key === 'n' || (key === 'enter' && !isActivatable(e.target))) next()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, submit, skip, doReveal, next, startRevise])

  const hint = useMemo(
    () =>
      phase === 'edit' ? (
        <>
          <span className="kbd">P</span> pass &middot; <span className="kbd">F</span> fail &middot; <span className="kbd">N</span> skip &middot; <span className="kbd">Enter</span> submit
          &middot; <span className="kbd">Ctrl</span>+<span className="kbd">Enter</span> submits while typing
        </>
      ) : phase === 'revising' ? (
        <>
          <span className="kbd">Esc</span> cancel the change &middot; <span className="kbd">Ctrl</span>+<span className="kbd">Enter</span> saves while typing
        </>
      ) : phase === 'revealed' || (phase === 'revealing' && reveal) ? (
        <>
          <span className="kbd">E</span> change my label &middot; <span className="kbd">N</span> or <span className="kbd">Enter</span> next item
        </>
      ) : (
        <>
          <span className="kbd">R</span> reveal the judge &middot; <span className="kbd">N</span> or <span className="kbd">Enter</span> next item
        </>
      ),
    [phase, reveal],
  )

  if (queue.loading && !queue.data) return <Loading label="Loading the review queue" />
  if (queue.error && !queue.data) return <ErrorState error={queue.error} onRetry={queue.reload} title="Could not load the queue" />

  const total = sessionDone + items.length
  const showErrors = tried
  const position = current ? pickerPosition(items, current.itemId) : null
  // The server returns at most QUEUE_LIMIT items. More up for review than are loaded means the list is capped.
  const capped = stats && stats.pending > items.length ? { shown: items.length, pending: stats.pending } : null

  return (
    <div className="stack">
      <div className="grid-2">
        <QuotaStatus stats={stats} />
        <LabelledSummary stats={labelStats} />
      </div>
      {queue.data?.notes.length ? <Banner kind="info"><ul>{queue.data.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></Banner> : null}

      {linkMissing ? (
        <Banner kind="info" role="status">
          That item is not in the review queue. It may already have a label, or it is not up for review.
          {capped ? ` Only the first ${plural(capped.shown, 'item')} of the queue are listed, so it may be further down.` : ''} Showing the normal first item instead.
        </Banner>
      ) : null}

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
              <span aria-live="polite">{position ? `Item ${position.n} of ${position.of} \u00b7 ` : ''}{sessionDone} labelled this session, {items.length} left in this batch{stats ? `, ${stats.pending} up for review in total` : ''}</span>
              <span className="muted">{hint}</span>
            </div>
            <div className="progress-track" role="progressbar" aria-label="Review progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={sessionDone}>
              <div className="progress-fill" style={{ width: `${total === 0 ? 0 : (sessionDone / total) * 100}%` }} />
            </div>
          </div>

          <ItemPicker items={items} currentId={current.itemId} disabled={phase === 'saving'} capped={capped} onPick={jumpTo} />

          <article className="review-panel" aria-label="Item to label">
            <div className="review-section">
              <div className="review-label">Criterion to judge</div>
              <div className="criterion-text">{current.criterion.text ?? `(The rubric text is not available. Criterion id: ${current.criterion.id})`}</div>
              <div className="row small muted" style={{ marginTop: '0.4rem' }}>
                <span className="mono">{current.criterion.id}</span>
                {current.criterion.critical ? <CriticalMarker /> : null}
                <span>scenario {current.scenarioId}</span>
                <CriterionLink criterion={current.criterion.id} rubricId={rubricOf(current.scenarioId)} />
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
                {saved?.replaces ? (
                  <Banner kind="success" title="Label changed." role="status">
                    You now say <strong>{saved.verdict}</strong>. Your first, blind label is kept on file.
                  </Banner>
                ) : (
                  <Banner kind="success" title="Label saved." role="status">
                    You said <strong>{saved?.verdict}</strong>. The server recorded it as a {saved?.sampled_by} sample.
                  </Banner>
                )}
                <div className="crit-box"><h4>Your critique</h4>{saved?.critique}</div>
                {problem ? <Banner kind="danger" role="alert">{problem}</Banner> : null}
                {reveal ? (
                  <>
                    <RevealView reveal={reveal} criterion={{ id: current.criterion.id, rubricId: rubricOf(current.scenarioId) }} />
                    {phase === 'revising' && saved ? (
                      <ReviseForm itemId={current.itemId} current={saved} idPrefix="revise-current" onSaved={onRevised} onCancel={() => setPhase('revealed')} />
                    ) : (
                      <div>
                        <button type="button" className="btn btn-ghost" onClick={startRevise} disabled={phase !== 'revealed'}>
                          {phase === 'revealing' ? <span className="spinner" aria-hidden="true" /> : null}
                          Change my label (E)
                        </button>
                        <p className="small muted" style={{ marginTop: '0.4rem' }}>Your first label stays on file, and the change is marked as made after seeing the judge.</p>
                      </div>
                    )}
                  </>
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

/** The item a label is about: a changed label's id ends in `~r<n>`. */
export function itemIdOf(label: Pick<Label, 'id' | 'replaces'>): string {
  return label.replaces === undefined ? label.id : label.id.replace(/~r\d+$/, '')
}

export function LabelsView() {
  const labels = useAsync(() => api.labels(), [])
  const [verdict, setVerdict] = useState('')
  const [sampled, setSampled] = useState('')
  const [labeler, setLabeler] = useState('')
  const [search, setSearch] = useState('')
  // Keyed by item id, which stays the same when a label is changed.
  const [open, setOpen] = useState<string | null>(null)
  const [revising, setRevising] = useState<string | null>(null)
  const [reveals, setReveals] = useState<Record<string, RevealResponse | string>>({})

  const all = labels.data?.labels ?? []
  const history = labels.data?.history ?? {}
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

  const doReveal = async (itemId: string) => {
    try {
      const r = await api.reveal(itemId)
      setReveals(prev => ({ ...prev, [itemId]: r }))
    } catch (e) {
      setReveals(prev => ({ ...prev, [itemId]: describeError(e) }))
    }
  }

  const onRevised = (itemId: string) => {
    setRevising(null)
    labels.reload()
    // A comparison already on screen is fetched again, so it shows the new label.
    if (reveals[itemId] !== undefined) void doReveal(itemId)
  }

  if (labels.loading && !labels.data) return <Loading label="Loading labels" />
  if (labels.error && !labels.data) return <ErrorState error={labels.error} onRetry={labels.reload} title="Could not load labels" />
  if (!labels.data) return null
  const stats = labels.data.stats

  return (
    <div className="stack">
      <div className="stats-row" style={{ marginBottom: 0 }}>
        <div className="stat-card">
          <div className="stat-num">{stats.total}</div>
          <div className="stat-label">Labels</div>
          {stats.revisions > 0 ? <div className="stat-sub">{stats.revisions} changed after the first label</div> : null}
        </div>
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
                    const itemId = itemIdOf(l)
                    const isOpen = open === itemId
                    const rv = reveals[itemId]
                    const earlier = history[itemId] ?? []
                    const first = earlier[0]
                    return (
                      <Fragment key={itemId}>
                        <tr>
                          <td>
                            <div className="row" style={{ gap: '0.4rem' }}>
                              <VerdictBadge verdict={l.verdict} />
                              {first ? <span className="badge badge-accent" title="Changed after the first label">Revised</span> : null}
                            </div>
                          </td>
                          <td><div className="mono small break">{l.criterion}</div><div className="small muted break">{itemId}</div></td>
                          <td className="small">{l.sampled_by}</td>
                          <td className="small">{l.labeler}</td>
                          <td className="small">{shortDate(l.at)}</td>
                          <td><button type="button" className="btn btn-ghost btn-sm" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : itemId)}>{isOpen ? 'Hide' : 'Details'}</button></td>
                        </tr>
                        {isOpen ? (
                          <tr>
                            <td colSpan={6} style={{ background: 'var(--bg2)' }}>
                              <div className="stack">
                                {l.input ? <div className="crit-box"><h4>Input</h4>{l.input}</div> : null}
                                <div className="crit-box"><h4>Output</h4>{l.output}</div>
                                <div className="crit-box"><h4>Critique by {l.labeler}</h4>{l.critique}</div>
                                {first ? (
                                  <div className="crit-box">
                                    <h4>First label, made blind, by {first.labeler}</h4>
                                    <div className="row" style={{ marginBottom: '0.4rem' }}><VerdictBadge verdict={first.verdict} /><span className="small muted">{shortDate(first.at)}</span></div>
                                    {first.critique}
                                    <p className="small muted" style={{ marginTop: '0.5rem', whiteSpace: 'normal' }}>Changed {plural(earlier.length, 'time')} since.</p>
                                  </div>
                                ) : null}
                                {l.group ? <div className="small muted">Group: <span className="mono">{l.group}</span></div> : null}
                                {revising === itemId ? (
                                  <ReviseForm itemId={itemId} current={l} idPrefix="revise-list" onSaved={() => onRevised(itemId)} onCancel={() => setRevising(null)} />
                                ) : null}
                                {rv === undefined ? (
                                  <div className="row">
                                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => doReveal(itemId)}>Reveal what the judge said</button>
                                    {revising === itemId ? null : <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRevising(itemId)}>Change label</button>}
                                  </div>
                                ) : (
                                  <>
                                    {typeof rv === 'string' ? <Banner kind="info">{rv}</Banner> : <RevealView reveal={rv} criterion={{ id: l.criterion }} />}
                                    {revising === itemId ? null : <div><button type="button" className="btn btn-ghost btn-sm" onClick={() => setRevising(itemId)}>Change label</button></div>}
                                  </>
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

export function ClassifyPage({ tab, onTab, itemId }: { tab: 'queue' | 'labels'; onTab(t: 'queue' | 'labels'): void; itemId?: string }) {
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
        {tab === 'queue' ? <QueueView itemId={itemId} /> : <LabelsView />}
      </div>
    </>
  )
}

