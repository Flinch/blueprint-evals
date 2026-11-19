import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Label, LabelMeta, LabelStats, LabelSuggestionsResponse, QueueItem, QueueStats, RevealResponse, RunResponse } from '../../../src/ui/api-types'
import { api, describeError, isApiFailure } from '../api/client'
import { useAsync } from '../api/useAsync'
import { ToolCallView, TurnView } from './RunDetailPage'
import { Banner, CriticalMarker, EmptyState, ErrorState, Loading, PageHead, Tabs, VerdictBadge, Warnings } from '../components/ui'
import { SplitBadge, WorkedExampleAction } from '../components/WorkedExample'
import { percent, plural, shortDate } from '../lib/format'
import { criterionHref, runHref } from '../lib/router'
import { readStored, writeStored } from '../lib/storage'

// Blind labelling. The queue item has the input, the output being judged and the
// criterion, and the same evidence the judge is shown: every turn's tool calls
// with their arguments and results (the judged reply's own included) and the
// date the conversation took place. It does not show the judge's verdict or critique, and it does not
// show the item's `reason` (a targeted reason hints that the judge failed the
// run). The judge's answer comes from the reveal endpoint, which this page only
// calls after the label is saved. See docs/design/0003-ui-and-api.md.
//
// A saved label can be changed later. The change is saved as a new line that
// replaces the current one, and the first, blind label stays in the file. Every
// change is treated as made after seeing the judge.
//
// Two things make labelling faster without touching what is up for review:
// "One criterion at a time" asks the server for one criterion's items (filtered
// after its sampling plan, so the quota, `sampled_by` and the blind order are
// unchanged), and quick critiques offer the person's own earlier critiques for
// the criterion and verdict, which never include anything from the judge.

export const LABELER_KEY = 'evals-ui-labeler'
export const MODE_KEY = 'evals-ui-classify-mode'
export const REVEAL_AFTER_KEY = 'evals-ui-reveal-after-save'
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
export type HumanVerdict = 'pass' | 'fail' | 'not_applicable'

/** What is saved when "Doesn't apply" is chosen with nothing typed. */
export const NOT_APPLICABLE_CRITIQUE = 'Does not apply to this reply.'

/** Whether a criterion's text has a "does not apply" condition. One without it always applies, so nothing going wrong is a pass. */
export function canNotApply(criterionText: string | undefined | null): boolean {
  return criterionText == null || /does not apply|doesn't apply|not applicable/i.test(criterionText)
}

/** Same rules as the server: a verdict, a critique and a labeler, both text fields non-blank after trimming and within their limits. "Doesn't apply" needs no typed critique. */
export function validateLabel(v: { verdict: HumanVerdict | null; critique: string; labeler: string }): FormErrors {
  const errors: FormErrors = {}
  if (v.verdict === null) errors.verdict = 'Choose pass, fail or doesn\'t apply.'
  const critique = v.critique.trim()
  if (critique === '' && v.verdict !== 'not_applicable') errors.critique = 'A critique is required on every label.'
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
        {stats.byVerdict.notApplicable ? <><dt>Doesn't apply</dt><dd>{stats.byVerdict.notApplicable}</dd></> : null}
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
/** "3 turns, 2 tool calls": what "Show the earlier conversation" will show. */
export function earlierSummary(turns: QueueItem['context']): string {
  const calls = turns.reduce((n, t) => n + (t.toolCalls?.length ?? 0), 0)
  return calls > 0 ? `${plural(turns.length, 'turn')}, ${plural(calls, 'tool call')}` : plural(turns.length, 'turn')
}

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
export function hasDraft(v: { verdict: HumanVerdict | null; critique: string }): boolean {
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

// ------------------------------------------------------ one criterion at a time

export type QueueMode = 'mixed' | 'criterion'

/** The mode remembered in this browser. Anything else, or storage that throws, is mixed. */
export function storedMode(): QueueMode {
  return readStored(MODE_KEY) === 'criterion' ? 'criterion' : 'mixed'
}

/** The criterion of an item id (`<runId>:<criterionId>`), or null when the id has no colon. */
export function criterionOfItem(itemId: string | undefined | null): string | null {
  if (!itemId) return null
  const i = itemId.indexOf(':')
  return i <= 0 || i === itemId.length - 1 ? null : itemId.slice(i + 1)
}

export interface CriterionOption {
  id: string
  pending: number
  label: string
}

/** The criterion select: every criterion with items left, by id, plus the chosen one (at 0) when it has none, so the select keeps its value. */
export function criterionOptions(byCriterion: QueueStats['byCriterion'], chosen: string | null): CriterionOption[] {
  const list = byCriterion.filter(c => c.pending > 0).map(c => ({ ...c }))
  if (chosen !== null && !list.some(c => c.id === chosen)) list.push({ id: chosen, pending: 0 })
  return list.sort((a, b) => cmp(a.id, b.id)).map(c => ({ ...c, label: `${c.id} (${c.pending} left)` }))
}

/** The criterion to offer when one runs out: the next by id that has items left, wrapping round, or null when none has. */
export function nextCriterion(byCriterion: QueueStats['byCriterion'], current: string | null): { id: string; pending: number } | null {
  const left = byCriterion.filter(c => c.pending > 0 && c.id !== current).sort((a, b) => cmp(a.id, b.id))
  if (current === null) return left[0] ?? null
  return left.find(c => c.id > current) ?? left[0] ?? null
}

function ModeBar({
  mode, chosen, byCriterion, disabled, onMode, onCriterion,
}: {
  mode: QueueMode
  chosen: string | null
  byCriterion: QueueStats['byCriterion']
  disabled: boolean
  onMode(m: QueueMode): void
  onCriterion(id: string): void
}) {
  const options = criterionOptions(byCriterion, chosen)
  return (
    <div className="card-sm">
      <div className="filters" style={{ marginBottom: 0 }}>
        <div className="form-group">
          <div className="form-label" id="mode-label">Labelling mode</div>
          <div className="mode-toggle" role="group" aria-labelledby="mode-label">
            <button type="button" className="btn btn-ghost btn-sm" aria-pressed={mode === 'mixed'} disabled={disabled} onClick={() => onMode('mixed')}>Mixed</button>
            <button type="button" className="btn btn-ghost btn-sm" aria-pressed={mode === 'criterion'} disabled={disabled} onClick={() => onMode('criterion')}>One criterion at a time</button>
          </div>
        </div>
        {mode === 'criterion' && options.length > 0 ? (
          <div className="form-group wide">
            <label className="form-label" htmlFor="criterion-picker">Criterion</label>
            <select id="criterion-picker" className="form-select" value={chosen ?? ''} disabled={disabled} onChange={e => onCriterion(e.target.value)}>
              {chosen === null ? <option value="" disabled>Choose a criterion</option> : null}
              {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>
        ) : null}
      </div>
      <p className="form-hint">
        {mode === 'mixed'
          ? 'Items from every criterion, in the queue’s own order.'
          : 'Only this criterion’s items, in the queue’s own order. What is up for review and the random quota stay the same.'}
      </p>
    </div>
  )
}

/** The criterion being labelled, pinned to the top of the page in one-criterion mode, so it is not repeated for every item. */
function PinnedCriterion({ id, item, rubricId }: { id: string; item: QueueItem | null; rubricId?: string | null }) {
  const c = item && item.criterion.id === id ? item.criterion : null
  return (
    <section className="card-sm criterion-pin" aria-label="Criterion to judge">
      <div className="review-label">Criterion to judge</div>
      {c ? <div className="criterion-text">{c.text ?? `(The rubric text is not available. Criterion id: ${c.id})`}</div> : null}
      <div className="row small muted" style={{ marginTop: c ? '0.4rem' : 0 }}>
        <span className="mono">{id}</span>
        {c?.critical ? <CriticalMarker /> : null}
        <CriterionLink criterion={id} rubricId={rubricId} />
      </div>
    </section>
  )
}

// ------------------------------------------------------------ quick critiques

/** How many characters of a suggestion fit on its button. The full text is in the title. */
export const CHIP_LENGTH = 60

export function chipText(s: string): string {
  return s.length <= CHIP_LENGTH ? s : `${s.slice(0, CHIP_LENGTH - 1).trimEnd()}…`
}

/** A chip fills an empty critique box. With text already there, the phrase goes on a new line after it, so nothing is lost. */
export function insertSuggestion(current: string, phrase: string): string {
  return current.trim() === '' ? phrase : `${current.replace(/\s+$/, '')}\n${phrase}`
}

/** The person's earlier critiques for a criterion and verdict, fetched once a verdict is chosen. Null while loading, with no verdict, or on any error. */
export function useSuggestions(q: { criterion: string | null; verdict: HumanVerdict | null; labeler: string; exclude?: string }): LabelSuggestionsResponse | null {
  const [data, setData] = useState<LabelSuggestionsResponse | null>(null)
  const labeler = q.labeler.trim()
  useEffect(() => {
    setData(null)
    if (q.criterion === null || q.verdict === null) return
    let live = true
    api
      .suggestions({ criterion: q.criterion, verdict: q.verdict, ...(labeler ? { labeler } : {}), ...(q.exclude ? { exclude: q.exclude } : {}) })
      .then(r => live && setData(r))
      .catch(() => {}) // No chips. Labelling works the same without them.
    return () => {
      live = false
    }
  }, [q.criterion, q.verdict, labeler, q.exclude])
  return data
}

/**
 * Up to four one-click critiques under the critique box. Keys 1 to 4 insert one
 * while focus is outside a text field, so typing a digit in the box still types it.
 */
export function QuickCritiques({ data, disabled = false, onPick }: { data: LabelSuggestionsResponse | null; disabled?: boolean; onPick(text: string): void }) {
  const list = data?.suggestions ?? []
  useEffect(() => {
    if (list.length === 0 || disabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.isComposing || isTypingTarget(e.target)) return
      if (!/^[1-4]$/.test(e.key)) return
      const text = list[Number(e.key) - 1]
      if (text === undefined) return
      e.preventDefault()
      onPick(text)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [list, disabled, onPick])
  if (list.length === 0) return null
  return (
    <div className="quick-critiques" role="group" aria-label="Quick critiques">
      <span className="small muted">{data?.fromOtherLabelers ? 'Earlier critiques from other labelers:' : 'Your earlier critiques:'}</span>
      {list.map((s, i) => (
        <button key={i} type="button" className="critique-chip" title={s} aria-label={s} disabled={disabled} onClick={() => onPick(s)}>
          <span className="kbd" aria-hidden="true">{i + 1}</span>
          {chipText(s)}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- reveal view

const verdictWord = (v: HumanVerdict) => (v === 'pass' ? 'Pass' : v === 'fail' ? 'Fail' : 'Doesn\'t apply')

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
      ) : human.verdict === 'not_applicable' ? (
        <Banner kind="info" role="status">
          <span className="agree-banner">You said this criterion does not apply.</span> The judge graded it {judge.verdict}. This label is kept out of the agreement rates and counted as a difference in reading the criterion.
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
  itemId, criterion, current, idPrefix, onSaved, onCancel, onSuggestions,
}: {
  itemId: string
  /** For the quick critiques. */
  criterion: string
  current: Pick<Label, 'verdict' | 'critique' | 'labeler'>
  /** Keeps element ids unique when more than one form can be on the page. */
  idPrefix: string
  onSaved(label: Label): void
  onCancel(): void
  /** How many quick critiques are on offer, for a shortcut hint outside the form. */
  onSuggestions?(count: number): void
}) {
  const [verdict, setVerdict] = useState<HumanVerdict | null>(current.verdict)
  const [critique, setCritique] = useState(current.critique)
  const [labeler, setLabeler] = useState(() => readStored(LABELER_KEY) ?? current.labeler)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const critiqueRef = useRef<HTMLTextAreaElement>(null)
  // The item's own current critique is left out: it is already in the box.
  const suggestions = useSuggestions({ criterion, verdict, labeler, exclude: itemId })
  const chipCount = suggestions?.suggestions.length ?? 0
  useEffect(() => {
    onSuggestions?.(chipCount)
  }, [chipCount, onSuggestions])
  useEffect(() => () => onSuggestions?.(0), [onSuggestions])
  const pick = useCallback((text: string) => {
    setCritique(c => insertSuggestion(c, text))
    critiqueRef.current?.focus()
  }, [])
  const errors = validateLabel({ verdict, critique, labeler })
  const unchanged = verdict === current.verdict && critique.trim() === current.critique.trim()
  const valid = Object.keys(errors).length === 0 && !unchanged
  const ids = { verdict: `${idPrefix}-verdict`, critique: `${idPrefix}-critique`, labeler: `${idPrefix}-labeler` }

  const save = async () => {
    if (!valid || verdict === null || saving) return
    setSaving(true)
    setProblem(null)
    try {
      const res = await api.revise(itemId, { verdict, critique: critique.trim() || NOT_APPLICABLE_CRITIQUE, labeler: labeler.trim() })
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
          <button type="button" className="btn btn-ghost" aria-pressed={verdict === 'not_applicable'} onClick={() => setVerdict('not_applicable')}>Doesn't apply</button>
        </div>
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor={ids.critique}>Critique (required)</label>
        <textarea
          id={ids.critique}
          ref={critiqueRef}
          className="form-textarea"
          autoFocus
          value={critique}
          maxLength={MAX_CRITIQUE}
          aria-required="true"
          aria-invalid={errors.critique ? true : undefined}
          onChange={e => setCritique(e.target.value)}
        />
        {errors.critique ? <div className="form-error" role="alert">{errors.critique}</div> : <div className="form-hint">Say what changed your mind, so the reason is on file too.</div>}
        <QuickCritiques data={suggestions} disabled={saving} onPick={pick} />
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

export function QueueView({
  itemId, criterion: linkCriterion, onCriterionLink,
}: {
  itemId?: string
  /** From `#/classify?criterion=<id>`: opens one-criterion mode on it. */
  criterion?: string
  /** Puts the chosen criterion (or none, for mixed) in the address, so a reload keeps it. */
  onCriterionLink?(criterion: string | null): void
} = {}) {
  // An item link wins over a criterion link: the item's own criterion is the one shown, so the item can be current.
  const [mode, setMode] = useState<QueueMode>(() => (linkCriterion ? 'criterion' : storedMode()))
  const [chosen, setChosen] = useState<string | null>(() => criterionOfItem(itemId) ?? linkCriterion ?? null)
  const queryCriterion = mode === 'criterion' ? chosen : null
  // Which criterion a response was for travels with it, so a list for another criterion is never shown as this one's.
  const queue = useAsync(async () => ({ ...(await api.queue(QUEUE_LIMIT, queryCriterion)), for: queryCriterion }), [queryCriterion])
  const fresh = queue.data !== null && queue.data.for === queryCriterion
  const labels = useAsync(() => api.labels(), [])
  // Only to link a criterion to its rubric. A failure leaves the link without a rubric id, and the Scenarios page finds it.
  const rubrics = useAsync(() => api.rubrics(), [])
  const rubricOf = (scenarioId: string) => rubrics.data?.rubrics.find(r => r.usedBy.includes(scenarioId))?.rubric.id
  const [items, setItems] = useState<QueueItem[]>([])
  // The response the local list was taken from. Until the list is taken from the latest one, the page shows it is loading.
  const [itemsFrom, setItemsFrom] = useState<object | null>(null)
  const [stats, setStats] = useState<QueueStats | null>(null)
  const [labelStats, setLabelStats] = useState<LabelStats | null>(null)
  const [sessionDone, setSessionDone] = useState(0)
  const [verdict, setVerdict] = useState<HumanVerdict | null>(null)
  const [critique, setCritique] = useState('')
  const [labeler, setLabeler] = useState(() => readStored(LABELER_KEY) ?? '')
  const [phase, setPhase] = useState<Phase>('edit')
  const [saved, setSaved] = useState<Label | null>(null)
  const [reveal, setReveal] = useState<RevealResponse | null>(null)
  const [tried, setTried] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // Open by default: the criterion is judged on the whole conversation, and a mistake is often in an earlier turn.
  const [showContext, setShowContext] = useState(true)
  const [skipped, setSkipped] = useState(0)
  const [linkMissing, setLinkMissing] = useState(false)
  const [reviseChips, setReviseChips] = useState(0)
  // Off by default: Save moves straight to the next item. On: Save stays on the item and shows the judge's answer.
  const [revealAfter, setRevealAfter] = useState(() => readStored(REVEAL_AFTER_KEY) === 'on')
  // A short note about the label just saved, shown on the next item when Save moved on.
  const [flash, setFlash] = useState<string | null>(null)
  // The saved label's split and example status, fetched after the reveal, so nothing about it shows before labelling.
  const [itemMeta, setItemMeta] = useState<LabelMeta | null>(null)
  const critiqueRef = useRef<HTMLTextAreaElement>(null)
  // The deep-link id that has been acted on, so a reload of the list does not move that item to the front again.
  const linkHandled = useRef<string | undefined>(undefined)
  // One-criterion mode with no criterion yet: the first answer (unfiltered) only says which criteria have items.
  const choosing = mode === 'criterion' && chosen === null

  useEffect(() => {
    writeStored(MODE_KEY, mode)
  }, [mode])

  // Take a fresh page from the server on load and whenever the local page runs out.
  useEffect(() => {
    if (queue.data) setStats(queue.data.stats)
    if (queue.data && fresh && !choosing) {
      let list = queue.data.items
      if (itemId && linkHandled.current !== itemId) {
        const r = applyDeepLink(list, itemId)
        list = r.items
        setLinkMissing(!r.found)
        linkHandled.current = itemId
      }
      setItems(list)
      setItemsFrom(queue.data)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue.data])
  useEffect(() => {
    if (labels.data) setLabelStats(labels.data.stats)
  }, [labels.data])

  // One-criterion mode opened with no criterion named: start with the first, by id, that has items.
  useEffect(() => {
    if (!choosing || !queue.data) return
    const first = nextCriterion(queue.data.stats.byCriterion, null)
    if (first) setChosen(first.id)
  }, [choosing, queue.data])

  const current = items[0] ?? null
  const errors = validateLabel({ verdict, critique, labeler })
  const valid = Object.keys(errors).length === 0
  const suggestions = useSuggestions({ criterion: current?.criterion.id ?? null, verdict, labeler })

  const resetForm = () => {
    setVerdict(null)
    setCritique('')
    setPhase('edit')
    setSaved(null)
    setReveal(null)
    setTried(false)
    setProblem(null)
    setShowContext(true)
    setItemMeta(null)
  }

  /** Whether the current item can be left: never mid-save, and a typed draft only after asking. */
  const mayLeave = () => {
    if (phase === 'saving') return false
    return !(phase === 'edit' && hasDraft({ verdict, critique }) && !window.confirm('Switch to another item? What you chose or typed for this one will be discarded.'))
  }

  // Make a listed item the current one. The others keep their order behind it. A typed draft is not thrown away without asking.
  const jumpTo = (id: string) => {
    if (!current || id === current.itemId || !mayLeave()) return
    // After a save the current item has its label already, so it leaves the list as it does on Next.
    const labelled = phase !== 'edit'
    setItems(prev => moveToFront(labelled ? prev.filter(x => x.itemId !== current.itemId) : prev, id))
    setLinkMissing(false)
    resetForm()
  }

  /** Switches mode or criterion. The new list loads from the server; the one on screen is not reused. */
  const switchTo = (nextMode: QueueMode, nextCriterionId: string | null, fromLink = false) => {
    if (nextMode === mode && (nextMode === 'mixed' || nextCriterionId === chosen)) return
    if (!fromLink && current && !mayLeave()) return
    setMode(nextMode)
    if (nextMode === 'criterion') setChosen(nextCriterionId)
    setItems([])
    setItemsFrom(null)
    setLinkMissing(false)
    resetForm()
    if (!fromLink) onCriterionLink?.(nextMode === 'criterion' ? nextCriterionId : null)
  }
  const chooseMode = (m: QueueMode) => switchTo(m, m === 'criterion' ? chosen ?? nextCriterion((stats ?? queue.data?.stats)?.byCriterion ?? [], null)?.id ?? null : null)
  const chooseCriterion = (id: string) => switchTo('criterion', id)

  // The address named a criterion while the page is open.
  useEffect(() => {
    if (linkCriterion && !criterionOfItem(itemId)) switchTo('criterion', linkCriterion, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkCriterion])

  // The address changed while the page is open (a new #/classify?item=... link).
  useEffect(() => {
    if (!itemId) {
      linkHandled.current = undefined
      setLinkMissing(false)
      return
    }
    if (!queue.data || linkHandled.current === itemId) return
    // In one-criterion mode the item's own criterion is loaded first, and the list effect then applies the link.
    const itemCriterion = criterionOfItem(itemId)
    if (mode === 'criterion' && itemCriterion && itemCriterion !== chosen) {
      switchTo('criterion', itemCriterion, true)
      return
    }
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
    if (items.length === 0 && queue.data && fresh && !queue.loading && sessionDone + skipped > 0) queue.reload()
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

  const pickSuggestion = useCallback((text: string) => {
    setCritique(c => insertSuggestion(c, text))
    critiqueRef.current?.focus()
  }, [])

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
      const res = await api.postLabel({ itemId: current.itemId, labeler: labeler.trim(), verdict, critique: critique.trim() || NOT_APPLICABLE_CRITIQUE })
      writeStored(LABELER_KEY, labeler.trim())
      setSessionDone(n => n + 1)
      refreshStats()
      if (!revealAfter) {
        setFlash(`Saved: ${verdictWord(res.label.verdict).toLowerCase()} for ${current.criterion.id} (scenario ${current.scenarioId}).`)
        next()
        return
      }
      setFlash(null)
      setSaved(res.label)
      setPhase('revealing')
      try {
        setReveal(await api.reveal(current.itemId))
        setPhase('revealed')
        loadItemMeta(current.itemId)
      } catch (e) {
        setPhase('saved')
        setProblem(`Your label is saved, but the judge's answer could not be loaded: ${describeError(e)}`)
      }
    } catch (e) {
      setPhase('edit')
      if (isApiFailure(e) && (e.code === 'duplicate_label' || e.code === 'item_not_found' || e.code === 'item_not_in_queue')) {
        setProblem(`${e.message} It is not in your queue any more. Go to the next item.`)
      } else {
        setProblem(describeError(e))
      }
    }
  }, [current, phase, valid, verdict, errors.critique, labeler, critique, revealAfter, next])

  const loadItemMeta = (itemId: string) => {
    api.labels().then(l => setItemMeta(l.meta?.[itemId] ?? null)).catch(() => setItemMeta(null))
  }

  const doReveal = useCallback(async () => {
    if (!current || phase !== 'saved') return
    setPhase('revealing')
    try {
      const r = await api.reveal(current.itemId)
      setReveal(r)
      setPhase('revealed')
      loadItemMeta(current.itemId)
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
  // Keys 1 to 4 belong to the quick critiques, which listen for them themselves.
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
        } else if (key === 'd') {
          setVerdict('not_applicable')
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

  const editChips = suggestions?.suggestions.length ?? 0
  const chipKeys = (n: number) =>
    n > 0 ? (
      <>
        {' '}&middot; <span className="kbd">1</span>{n > 1 ? <> to <span className="kbd">{n}</span></> : null} quick critique
      </>
    ) : null
  const hint = useMemo(
    () =>
      phase === 'edit' ? (
        <>
          <span className="kbd">P</span> pass &middot; <span className="kbd">F</span> fail &middot; <span className="kbd">D</span> doesn't apply &middot; <span className="kbd">N</span> skip &middot; <span className="kbd">Enter</span> submit
          &middot; <span className="kbd">Ctrl</span>+<span className="kbd">Enter</span> submits while typing{chipKeys(editChips)}
        </>
      ) : phase === 'revising' ? (
        <>
          <span className="kbd">Esc</span> cancel the change &middot; <span className="kbd">Ctrl</span>+<span className="kbd">Enter</span> saves while typing{chipKeys(reviseChips)}
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [phase, reveal, editChips, reviseChips],
  )

  if (queue.loading && !queue.data) return <Loading label="Loading the review queue" />
  if (queue.error && !queue.data) return <ErrorState error={queue.error} onRetry={queue.reload} title="Could not load the queue" />

  const shownStats = stats ?? queue.data?.stats ?? null
  const byCriterion = shownStats?.byCriterion ?? []
  const oneCriterion = mode === 'criterion' && chosen !== null
  // Up for review in what is being shown: one criterion's count in that mode, the whole queue otherwise.
  const pendingHere = shownStats ? (oneCriterion ? byCriterion.find(c => c.id === chosen)?.pending ?? 0 : shownStats.pending) : null
  const listReady = fresh && itemsFrom === queue.data
  const loadingList = choosing ? byCriterion.length > 0 : !listReady || (items.length === 0 && queue.loading)
  const total = sessionDone + items.length
  const showErrors = tried
  const position = current ? pickerPosition(items, current.itemId) : null
  // The server returns at most QUEUE_LIMIT items. More up for review than are loaded means the list is capped.
  const capped = pendingHere !== null && pendingHere > items.length ? { shown: items.length, pending: pendingHere } : null
  const offer = oneCriterion ? nextCriterion(byCriterion, chosen) : null

  return (
    <div className="stack">
      <ModeBar mode={mode} chosen={chosen} byCriterion={byCriterion} disabled={phase === 'saving'} onMode={chooseMode} onCriterion={chooseCriterion} />
      {oneCriterion ? <PinnedCriterion id={chosen} item={current} rubricId={current ? rubricOf(current.scenarioId) : undefined} /> : null}
      <div className="grid-2">
        <QuotaStatus stats={shownStats} />
        <LabelledSummary stats={labelStats} />
      </div>
      {fresh && queue.data?.notes.length ? <Banner kind="info"><ul>{queue.data.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></Banner> : null}

      {linkMissing ? (
        <Banner kind="info" role="status">
          That item is not in the review queue. It may already have a label, or it is not up for review.
          {capped ? ` Only the first ${plural(capped.shown, 'item')} of the queue are listed, so it may be further down.` : ''} Showing the normal first item instead.
        </Banner>
      ) : null}

      {loadingList ? (
        <Loading label="Loading the review queue" />
      ) : !current && oneCriterion ? (
        <div className="card" role="status" aria-label="Criterion done">
          <EmptyState title="Nothing left for this criterion">
            <p>Nothing for <span className="mono">{chosen}</span> is up for review right now.</p>
            {offer ? (
              <div className="row" style={{ justifyContent: 'center', marginTop: '0.8rem' }}>
                <button type="button" className="btn btn-primary" onClick={() => chooseCriterion(offer.id)}>Next criterion: {offer.id} ({offer.pending} left)</button>
                <button type="button" className="btn btn-ghost" onClick={() => chooseMode('mixed')}>Back to mixed</button>
              </div>
            ) : (
              <p>No other criterion has items up for review. New runs add more.</p>
            )}
          </EmptyState>
        </div>
      ) : !current ? (
        <div className="card">
          <EmptyState title="Nothing to review right now">
            {queue.data?.notes[0] ?? 'Every item that is up for review has a label. New runs add more.'}
          </EmptyState>
        </div>
      ) : (
        <>
          <div>
            <div className="row-between small" style={{ marginBottom: '0.3rem' }}>
              <span aria-live="polite">
                {position ? `Item ${position.n} of ${position.of} · ` : ''}{sessionDone} labelled this session, {items.length} left in this batch
                {shownStats ? (oneCriterion ? `, ${pendingHere} up for review for this criterion, ${shownStats.pending} in total` : `, ${shownStats.pending} up for review in total`) : ''}
              </span>
              <span className="muted">{hint}</span>
            </div>
            <div className="progress-track" role="progressbar" aria-label="Review progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={sessionDone}>
              <div className="progress-fill" style={{ width: `${total === 0 ? 0 : (sessionDone / total) * 100}%` }} />
            </div>
          </div>

          <ItemPicker items={items} currentId={current.itemId} disabled={phase === 'saving'} capped={capped} onPick={jumpTo} />
          {flash && phase === 'edit' ? <Banner kind="success" role="status">{flash}</Banner> : null}

          <article className="review-panel" aria-label="Item to label">
            {current.conversationDate ? (
              <div className="review-section date-line" aria-label="Conversation date">The conversation took place on {current.conversationDate}.</div>
            ) : null}
            {oneCriterion ? (
              <div className="review-section row small muted">
                <span>scenario {current.scenarioId}</span>
              </div>
            ) : (
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
            )}
            <div className="review-section">
              <div className="review-label">{current.context.length > 0 ? 'The earlier conversation' : 'What the agent was responding to'}</div>
              {/* The same turns as plain text: shown only when there are no turns to show as a conversation. */}
              {current.context.length === 0 ? <div className="review-text">{current.input}</div> : null}
              {current.context.length > 0 ? (
                <div style={{ marginTop: '0.6rem' }}>
                  <button type="button" className="btn btn-ghost btn-sm" aria-expanded={showContext} onClick={() => setShowContext(s => !s)}>
                    {showContext ? 'Hide the earlier conversation' : `Show the earlier conversation (${earlierSummary(current.context)})`}
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
              <div className="review-label">The last reply (turn [{current.outputTurn}])</div>
              <p className="small muted" style={{ marginBottom: '0.4rem' }}>Judge the whole conversation, not only this reply. A mistake in any earlier turn counts.</p>
              <div className="review-text">{current.output}</div>
              {current.outputToolCalls?.length ? (
                <div aria-label="Tool calls in the reply being judged" style={{ marginTop: '0.5rem' }}>
                  {current.outputToolCalls.map((c, i) => <ToolCallView key={i} call={c} index={current.outputTurn * 100 + i} />)}
                </div>
              ) : null}
            </div>
            {current.after?.length ? (
              <div className="review-section">
                <div className="review-label">After the reply</div>
                <div className="transcript">
                  {current.after.map(t => <TurnView key={t.index} turn={{ ...t, at: '' }} />)}
                </div>
              </div>
            ) : null}

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
                    <button type="button" className="btn btn-ghost" aria-pressed={verdict === 'not_applicable'} onClick={() => setVerdict('not_applicable')}>Doesn't apply (D)</button>
                  </div>
                  {showErrors && errors.verdict ? <div className="form-error" role="alert">{errors.verdict}</div> : null}
                  {verdict === 'not_applicable' ? (
                    canNotApply(current.criterion.text) ? (
                      <div className="form-hint">The situation this criterion is about never came up in this reply. Kept out of the agreement rates and counted as a difference in how you and the judge read the criterion. A critique is optional.</div>
                    ) : (
                      <Banner kind="warning" role="status">
                        This criterion has no "does not apply" condition, so it always applies. If the reply did nothing wrong here, that is a pass.
                      </Banner>
                    )
                  ) : null}
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="critique">{verdict === 'not_applicable' ? 'Critique (optional)' : 'Critique (required)'}</label>
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
                  {verdict !== null ? <QuickCritiques data={suggestions} disabled={phase === 'saving'} onPick={pickSuggestion} /> : null}
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
                <label className="row small" style={{ marginBottom: '0.8rem', gap: '0.4rem', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={revealAfter}
                    onChange={e => {
                      setRevealAfter(e.target.checked)
                      writeStored(REVEAL_AFTER_KEY, e.target.checked ? 'on' : 'off')
                    }}
                  />
                  Show me what the judge said after I save
                </label>
                <div className="row">
                  <button type="submit" className="btn btn-primary" disabled={!valid || phase === 'saving'}>
                    {phase === 'saving' ? <span className="spinner" aria-hidden="true" /> : null}
                    {revealAfter ? 'Save and show the judge' : 'Save and go to next'}
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
                    {itemMeta && saved ? (
                      <div className="row" aria-label="Worked example">
                        <SplitBadge split={itemMeta.split} />
                        <WorkedExampleAction key={saved.id} label={saved} itemId={current.itemId} meta={itemMeta} onAdded={() => loadItemMeta(current.itemId)} />
                      </div>
                    ) : null}
                    {phase === 'revising' && saved ? (
                      <ReviseForm
                        itemId={current.itemId}
                        criterion={current.criterion.id}
                        current={saved}
                        idPrefix="revise-current"
                        onSaved={onRevised}
                        onCancel={() => setPhase('revealed')}
                        onSuggestions={setReviseChips}
                      />
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

/**
 * The saved run a label was made from, as the judge is shown it: the date and
 * every turn, with tool calls, their arguments and results. Fetched only when
 * asked, since a label list can be long.
 */
export function LabelConversation({ runId }: { runId: string }) {
  const [state, setState] = useState<{ status: 'idle' } | { status: 'loading' } | { status: 'ok'; run: RunResponse } | { status: 'error'; message: string }>({ status: 'idle' })
  const load = async () => {
    setState({ status: 'loading' })
    try {
      setState({ status: 'ok', run: await api.run(runId) })
    } catch (e) {
      setState({ status: 'error', message: isApiFailure(e) && e.status === 404 ? 'The run is not saved here any more, so only the label text above is available.' : describeError(e) })
    }
  }
  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <div>
        <button type="button" className="btn btn-ghost btn-sm" disabled={state.status === 'loading'} onClick={() => void load()}>
          {state.status === 'loading' ? <span className="spinner" aria-hidden="true" /> : null}
          Show the whole conversation the judge sees
        </button>
      </div>
    )
  }
  if (state.status === 'error') return <p className="small muted" role="status">{state.message}</p>
  const { run } = state
  return (
    <div className="crit-box" aria-label="The whole conversation">
      <h4>The whole conversation</h4>
      {run.conversationDate ? <p className="date-line" style={{ marginBottom: '0.6rem' }}>The conversation took place on {run.conversationDate}.</p> : null}
      <div className="transcript">
        {run.result.trace.turns.map(t => <TurnView key={t.index} turn={{ index: t.index, role: t.role, content: t.content, toolCalls: t.toolCalls, at: t.at }} />)}
      </div>
    </div>
  )
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
  const meta = labels.data?.meta ?? {}
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
                <thead><tr><th>Verdict</th><th>Criterion</th><th>Split</th><th>Sampled</th><th>Labeler</th><th>When</th><th><span className="sr-only">Details</span></th></tr></thead>
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
                          <td>
                            {meta[itemId] ? (
                              <div className="row" style={{ gap: '0.3rem' }}>
                                <SplitBadge split={meta[itemId].split} />
                                {meta[itemId].isExample ? <span className="badge badge-accent" title="A worked example in its rubric">Example</span> : null}
                              </div>
                            ) : null}
                          </td>
                          <td className="small">{l.sampled_by}</td>
                          <td className="small">{l.labeler}</td>
                          <td className="small">{shortDate(l.at)}</td>
                          <td><button type="button" className="btn btn-ghost btn-sm" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : itemId)}>{isOpen ? 'Hide' : 'Details'}</button></td>
                        </tr>
                        {isOpen ? (
                          <tr>
                            <td colSpan={7} style={{ background: 'var(--bg2)' }}>
                              <div className="stack">
                                {l.input ? <div className="crit-box"><h4>Input</h4>{l.input}</div> : null}
                                <div className="crit-box"><h4>Output</h4>{l.output}</div>
                                {l.group && itemId === `${l.group}:${l.criterion}` ? <LabelConversation key={l.group} runId={l.group} /> : null}
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
                                <WorkedExampleAction key={l.id} label={l} itemId={itemId} meta={meta[itemId]} onAdded={labels.reload} />
                                {revising === itemId ? (
                                  <ReviseForm itemId={itemId} criterion={l.criterion} current={l} idPrefix="revise-list" onSaved={() => onRevised(itemId)} onCancel={() => setRevising(null)} />
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

export function ClassifyPage({
  tab, onTab, itemId, criterion, onCriterionLink,
}: {
  tab: 'queue' | 'labels'
  onTab(t: 'queue' | 'labels'): void
  itemId?: string
  criterion?: string
  onCriterionLink?(criterion: string | null): void
}) {
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
        {tab === 'queue' ? <QueueView itemId={itemId} criterion={criterion} onCriterionLink={onCriterionLink} /> : <LabelsView />}
      </div>
    </>
  )
}

