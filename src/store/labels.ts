import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import {
  checkLabels, itemIdOfLabel, LabelChainError, LabelSchema, MIN_RANDOM_SHARE, parseLabels, resolveLabels, splitOf, type Label, type Split,
} from '../calibration/labels.js'
import { isApplicable } from '../core/aggregate.js'
import type { CriterionResult, CriterionVerdict, RunResult } from '../core/interfaces.js'
import { judgedResponse, type ToolCall, type Turn } from '../core/trace.js'
import { conversationDate, renderTranscript } from '../graders/transcript.js'
import type { SuiteRecord } from './suites.js'

// Label storage and the review queue. See docs/design/0003-ui-and-api.md and
// docs/design/0002-judge-methodology.md ("Sampling").
//
// Two rules shape this file:
//
//  1. Blind labeling. A queue item never carries the judge's verdict or
//     critique, so the person labelling cannot anchor on the judge. Items are
//     built field by field (never by spreading a candidate) so a new judge
//     field cannot leak into one by accident. `revealItem` returns the judge's
//     verdict, and only for an item that already has a human label. The item
//     does carry what the judge was shown: every turn with its tool calls,
//     their arguments and results (the judged reply's own calls included), and
//     the conversation date. The person and the judge see the same evidence.
//  2. Applicable criteria only. A criterion the judge found not applicable (its
//     situation never arose) is never offered: a person cannot pass or fail
//     something that never happened. Such criteria are counted in the stats.
//  3. A random quota. At least MIN_RANDOM_SHARE of all labels are randomly
//     sampled, because only random labels can estimate the judge's accuracy.
//     Filtering the queue to one criterion happens after the plan, so it never
//     changes what is sampled.
//
// The label file may hold revisions (a person changed a label after seeing the
// judge). Everything here counts items, using the current label of each, so a
// revision never changes the queue, the stats' totals or the quota.

// ----------------------------------------------------------- the label file

export class LabelValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LabelValidationError'
  }
}

export class DuplicateLabelError extends Error {
  constructor(readonly id: string) {
    super(`a label with the id "${id}" already exists`)
    this.name = 'DuplicateLabelError'
  }
}

/** Every line of a label file, revisions included. A missing file is an empty list. A file that does not parse throws, naming the line. */
export function listLabels(file: string): Label[] {
  if (!existsSync(file)) return []
  return parseLabels(readFileSync(file, 'utf8'), file)
}

/**
 * Appends one label. The file is only ever appended to: nothing already in it is
 * rewritten. The label is checked with the same schema the calibration reads
 * with, so a line this writes is a line `evals calibrate` accepts. A `split`
 * field is refused (it is derived, never stored) and so is a duplicate id. A
 * revision (`replaces`) must extend a chain cleanly, as `resolveLabels` checks.
 * `at` defaults to now.
 */
export function appendLabel(file: string, input: unknown, now: Date = new Date()): Label {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new LabelValidationError('a label must be a JSON object')
  if ('split' in input) {
    throw new LabelValidationError('"split" is not a label field. It is derived from the group (or the id) and is never stored.')
  }
  const candidate = { at: now.toISOString(), ...(input as Record<string, unknown>) }
  const parsed = LabelSchema.safeParse(candidate)
  if (!parsed.success) throw new LabelValidationError(z.prettifyError(parsed.error))
  const label = parsed.data

  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const existing = parseLabels(text, file)
  if (existing.some(l => l.id === label.id)) throw new DuplicateLabelError(label.id)
  if (label.replaces !== undefined) {
    try {
      resolveLabels([...existing, label])
    } catch (e) {
      if (e instanceof LabelChainError) throw new LabelValidationError(e.message)
      throw e
    }
  }

  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${text !== '' && !text.endsWith('\n') ? '\n' : ''}${JSON.stringify(label)}\n`)
  return label
}

/** Counts are of items: a revised item counts once, with its current label. */
export interface LabelStats {
  total: number
  random: number
  targeted: number
  /** Share of labels that are randomly sampled, or null with no labels. */
  randomShare: number | null
  minRandomShare: number
  /** `notApplicable` is absent from answers by servers older than the "does not apply" label. */
  byVerdict: { pass: number; fail: number; notApplicable?: number }
  bySplit: Record<Split, number>
  labelers: string[]
  /** Items whose label was changed after it was first saved. */
  revisions: number
  /** The sanity checks `evals validate` runs on a label file. */
  warnings: string[]
}

/** Stats for every line of a label file. Throws LabelChainError for a broken replace chain. */
export function labelStats(all: Label[]): LabelStats {
  const { current: labels, revised } = resolveLabels(all)
  const random = labels.filter(l => l.sampled_by === 'random').length
  const bySplit: Record<Split, number> = { train: 0, dev: 0, test: 0 }
  for (const l of labels) bySplit[splitOf(l)]++
  return {
    total: labels.length,
    random,
    targeted: labels.length - random,
    randomShare: labels.length === 0 ? null : random / labels.length,
    minRandomShare: MIN_RANDOM_SHARE,
    byVerdict: { pass: labels.filter(l => l.verdict === 'pass').length, fail: labels.filter(l => l.verdict === 'fail').length, notApplicable: labels.filter(l => l.verdict === 'not_applicable').length },
    bySplit,
    labelers: [...new Set(labels.map(l => l.labeler))].sort(),
    revisions: revised.size,
    warnings: checkLabels(all),
  }
}

// ---------------------------------------------------------------- the queue

export type QueueReason = 'random' | 'targeted-failure' | 'targeted-error'

export interface QueueToolCall {
  name: string
  arguments: Record<string, unknown>
  /** What the tool returned, as the target reported it. The judge's transcript shows it too (cut to 500 characters there). */
  result?: unknown
  error?: string
}

/** A turn as a labeler sees it: no raw response, no latency. */
export interface QueueTurn {
  index: number
  role: Turn['role']
  content: string
  toolCalls?: QueueToolCall[]
}

export interface QueueItem {
  /** `<runId>:<criterionId>`. Also the id of the label made from it. */
  itemId: string
  suiteId: string
  runId: string
  scenarioId: string
  /** When the run started (ISO time). Lets a person tell several runs of one scenario apart. Says nothing about the judge. */
  startedAt: string
  criterion: {
    id: string
    /** From the scenario's rubric, as it is now. Null when the rubric cannot be found. */
    text: string | null
    critical: boolean | null
  }
  /** What the response was responding to: the preceding user message, or a transcript of everything before it. */
  input: string
  /** The assistant response being judged: the final assistant reply in the run. */
  output: string
  /** The tool calls made in the judged reply's own turn, with their arguments and results. Absent when it made none. */
  outputToolCalls?: QueueToolCall[]
  /** Every turn before `output`, for a labeler who needs the whole conversation. */
  context: QueueTurn[]
  /** Turn index of `output`. */
  outputTurn: number
  /** Any turns after `output` (an assistant turn with tool calls and no text, say). The judge sees them, so the labeler does too. Absent when there are none. */
  after?: QueueTurn[]
  /**
   * The day the conversation took place, worded as the judge is told it, for
   * example "Sunday, 15 November 2026 (America/Toronto)". In the config's
   * timezone. Null when the run's start time is not a valid time.
   */
  conversationDate: string | null
  /** The label's `group`: the run, so one conversation never straddles two splits. */
  group: string
  /** Why this item is in the queue. A UI should not show it before the item is labelled: 'targeted-*' hints that the run failed. */
  reason: QueueReason
}

/** The rubric a scenario's runs are judged against, as the queue needs it. */
export type RubricLookup = (scenarioId: string) => { criteria: { id: string; text: string; critical: boolean }[] } | undefined

export const DEFAULT_QUEUE_SEED = 'blueprint-evals-review-queue-v1'

export interface QueueOptions {
  suites: SuiteRecord[]
  /** Every line of the label file. Revisions are resolved here, so an item counts once. */
  labels: Label[]
  rubricFor?: RubricLookup
  /** IANA timezone for `conversationDate`: the config's `timezone`, as the judge uses. Default: the machine's. */
  timeZone?: string
  /** Page size. Default 25. */
  limit?: number
  seed?: string
  minRandomShare?: number
  /**
   * Only this criterion's items. Applied after the plan and before the page
   * limit, so what is up for review, each item's `reason` and the random quota
   * are the same as without it, and the items keep their blind display order.
   */
  criterion?: string
}

export interface QueueStats {
  /** Run x criterion items that are not labelled yet. Criteria the judge found not applicable are not items. */
  candidates: number
  /** Unlabelled criteria left out of the queue because the judge found them not applicable. */
  notApplicable: number
  /** How many of those the plan puts up for review. The rest are passes that were not sampled. */
  pending: number
  queued: number
  labelled: number
  labelledRandom: number
  labelledRandomShare: number | null
  minRandomShare: number
  /** Whether the labels so far meet the random quota. */
  quotaMet: boolean
  /** Items up for review per criterion, from the whole plan (never the page or a criterion filter), sorted by id. Criteria with none are left out. */
  byCriterion: { id: string; pending: number }[]
}

export interface ReviewQueue {
  items: QueueItem[]
  stats: QueueStats
}

/** An item as the plan knows it: the public item plus what only `reveal` may show. Never serialised. */
interface Candidate {
  item: Omit<QueueItem, 'reason'>
  judged: { verdict: 'pass' | 'fail' } | undefined
  runError: boolean
}

const hex = (...parts: string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex')

const itemIdOf = (runId: string, criterionId: string) => `${runId}:${criterionId}`

// Field by field, like the item itself: a new ToolCall or Turn field (an id, the raw response) stays out until it is
// added here on purpose.
function toQueueToolCall(c: ToolCall): QueueToolCall {
  return {
    name: c.name,
    arguments: c.arguments,
    ...(c.result !== undefined ? { result: c.result } : {}),
    ...(c.error ? { error: c.error } : {}),
  }
}

function toQueueToolCalls(t: Turn): { toolCalls?: QueueToolCall[] } {
  return t.toolCalls && t.toolCalls.length > 0 ? { toolCalls: t.toolCalls.map(toQueueToolCall) } : {}
}

function toQueueTurn(t: Turn): QueueTurn {
  return { index: t.index, role: t.role, content: t.content, ...toQueueToolCalls(t) }
}

function inputText(before: Turn[]): string {
  if (before.length === 1 && before[0]!.role === 'user') return before[0]!.content
  return renderTranscript(before)
}

function criteriaOf(result: RunResult): CriterionResult[] {
  return result.graders.flatMap(g => (g.status === 'pass' || g.status === 'fail' ? g.criteria ?? [] : []))
}

function candidatesOf(suite: SuiteRecord, rubricFor: RubricLookup | undefined, timeZone: string | undefined): { candidates: Candidate[]; notApplicable: string[] } {
  const out: Candidate[] = []
  const notApplicable: string[] = []
  for (const run of suite.results) {
    const found = judgedResponse(run.trace.turns)
    if (!found) continue // nothing to label: LabelSchema needs a non-empty output
    const outputCalls = toQueueToolCalls(found.output).toolCalls
    const after = run.trace.turns.slice(found.before.length + 1).map(toQueueTurn)
    const base = {
      suiteId: suite.suiteId,
      runId: run.trace.runId,
      scenarioId: run.trace.scenario.id,
      startedAt: run.trace.startedAt,
      input: inputText(found.before),
      output: found.output.content,
      ...(outputCalls ? { outputToolCalls: outputCalls } : {}),
      context: found.before.map(toQueueTurn),
      outputTurn: found.output.index,
      ...(after.length > 0 ? { after } : {}),
      conversationDate: conversationDate(run.trace.startedAt, timeZone) ?? null,
      group: run.trace.runId,
    }
    const rubric = rubricFor?.(run.trace.scenario.id)
    const textOf = (id: string) => rubric?.criteria.find(c => c.id === id)

    // Every criterion the judge decided, including the ones it found not applicable: an errored run must not
    // hand those back to a human as "undecided".
    const decided = criteriaOf(run)
    for (const c of decided) {
      if (!isApplicable(c)) {
        notApplicable.push(itemIdOf(base.runId, c.id))
        continue
      }
      const r = textOf(c.id)
      out.push({
        item: { ...base, itemId: itemIdOf(base.runId, c.id), criterion: { id: c.id, text: r?.text ?? null, critical: r?.critical ?? c.critical } },
        judged: { verdict: c.verdict as 'pass' | 'fail' },
        runError: false,
      })
    }
    // A run that errored may have criteria the judge never decided. Those need a human most.
    if (run.status === 'error' && rubric) {
      for (const c of rubric.criteria) {
        if (decided.some(j => j.id === c.id)) continue
        out.push({
          item: { ...base, itemId: itemIdOf(base.runId, c.id), criterion: { id: c.id, text: c.text, critical: c.critical } },
          judged: undefined,
          runError: true,
        })
      }
    }
  }
  return { candidates: out, notApplicable }
}

interface Plan {
  /** Everything up for review, in blind display order, with the reason for each. */
  all: QueueItem[]
  /** Ids of every unlabelled item, whether or not it is up for review. */
  candidateIds: Set<string>
  candidates: number
  notApplicable: number
  labelled: number
  labelledRandom: number
  random: number
}

/**
 * Chooses what is up for review. The rules:
 *
 *  - The population is every run x criterion item not yet labelled.
 *  - Targeted: an item the judge failed, or that a run error left undecided.
 *  - Random: a seeded sample drawn from the WHOLE population, passes and
 *    failures alike, since a random label that could only ever be a judge pass
 *    could not estimate the true negative rate. Items are ranked by a hash of
 *    (seed, id), so the sample is the same on every reload, and an item's
 *    rank only improves as others are labelled.
 *  - The sample size makes the labels, once everything up for review is done,
 *    at least `minRandomShare` random: labelled + candidates = T, and
 *    ceil(share x T) - (random labels so far) items are sampled.
 *  - Display order is a second, independent hash, so position says nothing
 *    about why an item is there.
 */
function plan(options: QueueOptions): Plan {
  const seed = options.seed ?? DEFAULT_QUEUE_SEED
  const share = options.minRandomShare ?? MIN_RANDOM_SHARE
  const { current } = resolveLabels(options.labels)
  const labelledIds = new Set(current.map(itemIdOfLabel))
  const labelled = current.length
  const labelledRandom = current.filter(l => l.sampled_by === 'random').length

  const seen = new Set<string>()
  const skippedNa = new Set<string>()
  const candidates: Candidate[] = []
  for (const suite of options.suites) {
    const found = candidatesOf(suite, options.rubricFor, options.timeZone)
    for (const id of found.notApplicable) if (!labelledIds.has(id)) skippedNa.add(id)
    for (const c of found.candidates) {
      if (labelledIds.has(c.item.itemId) || seen.has(c.item.itemId)) continue
      seen.add(c.item.itemId)
      candidates.push(c)
    }
  }

  const total = labelled + candidates.length
  // Integer arithmetic: ceil(share x total) without floating-point surprises at exact multiples.
  const needed = Math.ceil(Math.round(share * total * 1e6) / 1e6)
  const randomCount = Math.min(candidates.length, Math.max(0, needed - labelledRandom))

  const sampleKey = new Map(candidates.map(c => [c.item.itemId, hex(seed, 'sample', c.item.itemId)]))
  const bySample = [...candidates].sort((a, b) => sampleKey.get(a.item.itemId)!.localeCompare(sampleKey.get(b.item.itemId)!))
  const randomIds = new Set(bySample.slice(0, randomCount).map(c => c.item.itemId))

  const selected: QueueItem[] = []
  for (const c of candidates) {
    const targeted: QueueReason | undefined = c.judged === undefined ? 'targeted-error' : c.judged.verdict === 'fail' ? 'targeted-failure' : undefined
    const reason: QueueReason | undefined = randomIds.has(c.item.itemId) ? 'random' : targeted
    if (reason) selected.push({ ...c.item, reason })
  }
  const orderKey = new Map(selected.map(i => [i.itemId, hex(seed, 'order', i.itemId)]))
  selected.sort((a, b) => orderKey.get(a.itemId)!.localeCompare(orderKey.get(b.itemId)!))
  return { all: selected, candidateIds: seen, candidates: candidates.length, notApplicable: skippedNa.size, labelled, labelledRandom, random: randomCount }
}

/**
 * The review queue: up to `limit` items, never carrying the judge's verdict or
 * critique. With `criterion`, only that criterion's items, filtered from the
 * finished plan. The filter changes which items are on the page and nothing
 * else: what is up for review, each item's reason and the stats stay the same.
 */
export function buildQueue(options: QueueOptions): ReviewQueue {
  const p = plan(options)
  const limit = Math.max(1, Math.floor(options.limit ?? 25))
  const share = options.minRandomShare ?? MIN_RANDOM_SHARE
  const seed = options.seed ?? DEFAULT_QUEUE_SEED
  const filtered = options.criterion === undefined ? p.all : p.all.filter(i => i.criterion.id === options.criterion)

  let page = filtered.slice(0, limit)
  // Each mixed page carries its own share of random items too, not only the queue as a whole. A one-criterion page
  // is not topped up: the plan already holds the quota across the whole queue, and swapping would mean taking items
  // out of that criterion's blind order.
  const wanted = options.criterion === undefined ? Math.min(Math.ceil(share * page.length), p.random) : 0
  let have = page.filter(i => i.reason === 'random').length
  if (have < wanted) {
    const spare = p.all.slice(limit).filter(i => i.reason === 'random')
    const swapOut = [...page].reverse().filter(i => i.reason !== 'random')
    while (have < wanted && spare.length > 0 && swapOut.length > 0) {
      const out = swapOut.shift()!
      page = page.filter(i => i.itemId !== out.itemId)
      page.push(spare.shift()!)
      have++
    }
    const key = new Map(page.map(i => [i.itemId, hex(seed, 'order', i.itemId)]))
    page.sort((a, b) => key.get(a.itemId)!.localeCompare(key.get(b.itemId)!))
  }

  return {
    items: page,
    stats: {
      candidates: p.candidates,
      notApplicable: p.notApplicable,
      pending: p.all.length,
      queued: page.length,
      labelled: p.labelled,
      labelledRandom: p.labelledRandom,
      labelledRandomShare: p.labelled === 0 ? null : p.labelledRandom / p.labelled,
      minRandomShare: share,
      quotaMet: p.labelled === 0 || p.labelledRandom / p.labelled >= share,
      byCriterion: pendingByCriterion(p.all),
    },
  }
}

function pendingByCriterion(items: QueueItem[]): QueueStats['byCriterion'] {
  const counts = new Map<string, number>()
  for (const i of items) counts.set(i.criterion.id, (counts.get(i.criterion.id) ?? 0) + 1)
  return [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, pending]) => ({ id, pending }))
}

// ------------------------------------------------------ critique suggestions

/** At most this many suggestions are returned. */
export const MAX_SUGGESTIONS = 4
/** A critique longer than this is too specific to one item to offer again. */
export const MAX_SUGGESTION_LENGTH = 300

export interface SuggestionQuery {
  criterion: string
  verdict: Label['verdict']
  /** Prefer this person's critiques. Without it, or when they have none, everyone's are used. */
  labeler?: string
  /** An item whose current label is left out (the one being changed, so its own critique is not offered back). */
  exclude?: string
}

export interface Suggestions {
  suggestions: string[]
  /** True when the labeler was named but had no matching critiques, so these come from other people. */
  fromOtherLabelers: boolean
}

const normaliseCritique = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Phrases a person has written before for this criterion and verdict, to offer
 * as one-click critiques. Taken from the current labels only (a revised item
 * counts with its latest critique), never from the judge. Critiques are grouped
 * by their normalised text (trimmed, whitespace collapsed, case ignored),
 * ranked by how often they were written, then by the most recent use, and each
 * is returned as last written. Critiques over MAX_SUGGESTION_LENGTH characters
 * are left out. Throws LabelChainError for a broken replace chain.
 */
export function critiqueSuggestions(all: Label[], query: SuggestionQuery): Suggestions {
  const pool = resolveLabels(all).current.filter(
    l => l.criterion === query.criterion && l.verdict === query.verdict && itemIdOfLabel(l) !== query.exclude && l.critique.trim().length <= MAX_SUGGESTION_LENGTH,
  )
  const labeler = query.labeler?.trim()
  const own = labeler ? pool.filter(l => l.labeler.trim() === labeler) : pool
  const fromOtherLabelers = labeler !== undefined && labeler !== '' && own.length === 0 && pool.length > 0
  const source = own.length > 0 ? own : pool

  const groups = new Map<string, { text: string; count: number; latest: number }>()
  for (const l of source) {
    const text = l.critique.trim()
    if (text === '') continue
    const key = normaliseCritique(text)
    const at = Date.parse(l.at)
    const g = groups.get(key)
    if (!g) groups.set(key, { text, count: 1, latest: at })
    else {
      g.count++
      if (at >= g.latest) {
        g.latest = at
        g.text = text
      }
    }
  }
  const ranked = [...groups.entries()].sort(([ka, a], [kb, b]) => b.count - a.count || b.latest - a.latest || (ka < kb ? -1 : ka > kb ? 1 : 0))
  return { suggestions: ranked.slice(0, MAX_SUGGESTIONS).map(([, g]) => g.text), fromOtherLabelers }
}

export type FoundItem =
  | { status: 'ok'; item: QueueItem; sampledBy: Label['sampled_by'] }
  /** The item exists and is unlabelled, but the plan does not put it up for review (a pass that was not sampled). */
  | { status: 'not_in_queue' }
  /** No such item, or it is already labelled. */
  | { status: 'unknown' }

/**
 * The item with this id, and how it was sampled, as the plan stands now. A label
 * records the answer, so the server decides it and a client cannot claim an item
 * was random or choose which passes to label.
 */
export function findQueueItem(options: QueueOptions, itemId: string): FoundItem {
  const p = plan(options)
  const item = p.all.find(i => i.itemId === itemId)
  if (item) return { status: 'ok', item, sampledBy: item.reason === 'random' ? 'random' : 'targeted' }
  return p.candidateIds.has(itemId) ? { status: 'not_in_queue' } : { status: 'unknown' }
}

// ------------------------------------------------------------------ reveal

export interface Reveal {
  /** The id of the current label line: the item id, or `<itemId>~r<n>` once the label was changed. */
  labelId: string
  runId: string
  suiteId: string | null
  /** The judge's verdict on this criterion. Null when the judge never decided it (the run errored first). */
  judge: { verdict: CriterionVerdict; critique: string; critical: boolean; grader: string } | null
  /** Why the run errored, when it did. */
  runError: string | null
  /** The person's current label for the item. */
  human: { verdict: Label['verdict']; critique: string; labeler: string; at: string }
  /** Whether the judge agrees with the current label. Null when there is no judge verdict to compare with, which includes a judge that found the criterion not applicable. */
  agrees: boolean | null
  /** The first, blind label, when the label was changed later. Null when it never was. */
  original: { verdict: Label['verdict']; critique: string; at: string } | null
  /** How many times the label was changed. */
  revisions: number
  /** Whether the judge agrees with the blind label. Null when `agrees` is. Equal to `agrees` when the label was never changed. */
  blindAgrees: boolean | null
}

export type RunLookup = (runId: string) => { suiteId: string; result: RunResult } | null

/**
 * The judge's verdict and critique for an item that has a human label. The
 * caller passes the current label and, for a changed label, the versions it
 * superseded (oldest first, so the blind label comes first), so an item that
 * was never labelled cannot be revealed. Null when the item id is not a queue
 * item id or its run is gone.
 */
export function revealItem(label: Label, findRun: RunLookup, history: Label[] = []): Reveal | null {
  const itemId = itemIdOfLabel(label)
  const split = itemId.indexOf(':')
  if (split <= 0) return null
  const runId = itemId.slice(0, split)
  const criterionId = itemId.slice(split + 1)
  const found = findRun(runId)
  if (!found) return null

  let judge: Reveal['judge'] = null
  for (const g of found.result.graders) {
    const c = (g.status === 'pass' || g.status === 'fail' ? g.criteria ?? [] : []).find(x => x.id === criterionId)
    if (c) judge = { verdict: c.verdict, critique: c.critique, critical: c.critical, grader: g.grader }
  }
  const graded = judge && judge.verdict !== 'not_applicable' ? judge.verdict : null
  const blind = history[0] ?? label
  return {
    labelId: label.id,
    runId,
    suiteId: found.suiteId,
    judge,
    runError: found.result.error ?? null,
    human: { verdict: label.verdict, critique: label.critique, labeler: label.labeler, at: label.at },
    agrees: graded === null ? null : graded === label.verdict,
    original: history[0] ? { verdict: blind.verdict, critique: blind.critique, at: blind.at } : null,
    revisions: history.length,
    blindAgrees: graded === null ? null : graded === blind.verdict,
  }
}
