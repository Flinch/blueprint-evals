import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { checkLabels, LabelSchema, MIN_RANDOM_SHARE, parseLabels, splitOf, type Label, type Split } from '../calibration/labels.js'
import type { CriterionResult, RunResult } from '../core/interfaces.js'
import type { Turn } from '../core/trace.js'
import { renderTranscript } from '../graders/transcript.js'
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
//     verdict, and only for an item that already has a human label.
//  2. A random quota. At least MIN_RANDOM_SHARE of all labels are randomly
//     sampled, because only random labels can estimate the judge's accuracy.

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

/** The labels in a file. A missing file is an empty list. A file that does not parse throws, naming the line. */
export function listLabels(file: string): Label[] {
  if (!existsSync(file)) return []
  return parseLabels(readFileSync(file, 'utf8'), file)
}

/**
 * Appends one label. The file is only ever appended to: nothing already in it is
 * rewritten. The label is checked with the same schema the calibration reads
 * with, so a line this writes is a line `evals calibrate` accepts. A `split`
 * field is refused (it is derived, never stored) and so is a duplicate id.
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
  if (parseLabels(text, file).some(l => l.id === label.id)) throw new DuplicateLabelError(label.id)

  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${text !== '' && !text.endsWith('\n') ? '\n' : ''}${JSON.stringify(label)}\n`)
  return label
}

export interface LabelStats {
  total: number
  random: number
  targeted: number
  /** Share of labels that are randomly sampled, or null with no labels. */
  randomShare: number | null
  minRandomShare: number
  byVerdict: { pass: number; fail: number }
  bySplit: Record<Split, number>
  labelers: string[]
  /** The sanity checks `evals validate` runs on a label file. */
  warnings: string[]
}

export function labelStats(labels: Label[]): LabelStats {
  const random = labels.filter(l => l.sampled_by === 'random').length
  const bySplit: Record<Split, number> = { train: 0, dev: 0, test: 0 }
  for (const l of labels) bySplit[splitOf(l)]++
  return {
    total: labels.length,
    random,
    targeted: labels.length - random,
    randomShare: labels.length === 0 ? null : random / labels.length,
    minRandomShare: MIN_RANDOM_SHARE,
    byVerdict: { pass: labels.filter(l => l.verdict === 'pass').length, fail: labels.filter(l => l.verdict === 'fail').length },
    bySplit,
    labelers: [...new Set(labels.map(l => l.labeler))].sort(),
    warnings: checkLabels(labels),
  }
}

// ---------------------------------------------------------------- the queue

export type QueueReason = 'random' | 'targeted-failure' | 'targeted-error'

export interface QueueToolCall {
  name: string
  arguments: Record<string, unknown>
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
  /** Every turn before `output`, for a labeler who needs the whole conversation. */
  context: QueueTurn[]
  /** Turn index of `output`. */
  outputTurn: number
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
  labels: Label[]
  rubricFor?: RubricLookup
  /** Page size. Default 25. */
  limit?: number
  seed?: string
  minRandomShare?: number
}

export interface QueueStats {
  /** Run x criterion items that are not labelled yet. */
  candidates: number
  /** How many of those the plan puts up for review. The rest are passes that were not sampled. */
  pending: number
  queued: number
  labelled: number
  labelledRandom: number
  labelledRandomShare: number | null
  minRandomShare: number
  /** Whether the labels so far meet the random quota. */
  quotaMet: boolean
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

function toQueueTurn(t: Turn): QueueTurn {
  return {
    index: t.index,
    role: t.role,
    content: t.content,
    ...(t.toolCalls && t.toolCalls.length > 0
      ? { toolCalls: t.toolCalls.map(c => ({ name: c.name, arguments: c.arguments, ...(c.error ? { error: c.error } : {}) })) }
      : {}),
  }
}

/** The judged response is the last assistant reply with text. Everything before it is its input. */
function judgedResponse(turns: Turn[]): { output: Turn; before: Turn[] } | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!
    if (t.role === 'assistant' && t.content.trim() !== '') return { output: t, before: turns.slice(0, i) }
  }
  return undefined
}

function inputText(before: Turn[]): string {
  if (before.length === 1 && before[0]!.role === 'user') return before[0]!.content
  return renderTranscript(before)
}

function criteriaOf(result: RunResult): CriterionResult[] {
  return result.graders.flatMap(g => (g.status === 'pass' || g.status === 'fail' ? g.criteria ?? [] : []))
}

function candidatesOf(suite: SuiteRecord, rubricFor: RubricLookup | undefined): Candidate[] {
  const out: Candidate[] = []
  for (const run of suite.results) {
    const found = judgedResponse(run.trace.turns)
    if (!found) continue // nothing to label: LabelSchema needs a non-empty output
    const base = {
      suiteId: suite.suiteId,
      runId: run.trace.runId,
      scenarioId: run.trace.scenario.id,
      input: inputText(found.before),
      output: found.output.content,
      context: found.before.map(toQueueTurn),
      outputTurn: found.output.index,
      group: run.trace.runId,
    }
    const rubric = rubricFor?.(run.trace.scenario.id)
    const textOf = (id: string) => rubric?.criteria.find(c => c.id === id)

    const judged = criteriaOf(run)
    for (const c of judged) {
      const r = textOf(c.id)
      out.push({
        item: { ...base, itemId: itemIdOf(base.runId, c.id), criterion: { id: c.id, text: r?.text ?? null, critical: r?.critical ?? c.critical } },
        judged: { verdict: c.verdict },
        runError: false,
      })
    }
    // A run that errored may have criteria the judge never decided. Those need a human most.
    if (run.status === 'error' && rubric) {
      for (const c of rubric.criteria) {
        if (judged.some(j => j.id === c.id)) continue
        out.push({
          item: { ...base, itemId: itemIdOf(base.runId, c.id), criterion: { id: c.id, text: c.text, critical: c.critical } },
          judged: undefined,
          runError: true,
        })
      }
    }
  }
  return out
}

interface Plan {
  /** Everything up for review, in blind display order, with the reason for each. */
  all: QueueItem[]
  /** Ids of every unlabelled item, whether or not it is up for review. */
  candidateIds: Set<string>
  candidates: number
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
  const labelledIds = new Set(options.labels.map(l => l.id))
  const labelled = options.labels.length
  const labelledRandom = options.labels.filter(l => l.sampled_by === 'random').length

  const seen = new Set<string>()
  const candidates: Candidate[] = []
  for (const suite of options.suites) {
    for (const c of candidatesOf(suite, options.rubricFor)) {
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
  return { all: selected, candidateIds: seen, candidates: candidates.length, labelled, labelledRandom, random: randomCount }
}

/** The review queue: up to `limit` items, never carrying the judge's verdict or critique. */
export function buildQueue(options: QueueOptions): ReviewQueue {
  const p = plan(options)
  const limit = Math.max(1, Math.floor(options.limit ?? 25))
  const share = options.minRandomShare ?? MIN_RANDOM_SHARE
  const seed = options.seed ?? DEFAULT_QUEUE_SEED

  let page = p.all.slice(0, limit)
  // Each page carries its own share of random items too, not only the queue as a whole.
  const wanted = Math.min(Math.ceil(share * page.length), p.random)
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
      pending: p.all.length,
      queued: page.length,
      labelled: p.labelled,
      labelledRandom: p.labelledRandom,
      labelledRandomShare: p.labelled === 0 ? null : p.labelledRandom / p.labelled,
      minRandomShare: share,
      quotaMet: p.labelled === 0 || p.labelledRandom / p.labelled >= share,
    },
  }
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
  labelId: string
  runId: string
  suiteId: string | null
  /** The judge's verdict on this criterion. Null when the judge never decided it (the run errored first). */
  judge: { verdict: 'pass' | 'fail'; critique: string; critical: boolean; grader: string } | null
  /** Why the run errored, when it did. */
  runError: string | null
  human: { verdict: Label['verdict']; critique: string; labeler: string; at: string }
  /** Null when there is no judge verdict to compare with. */
  agrees: boolean | null
}

export type RunLookup = (runId: string) => { suiteId: string; result: RunResult } | null

/**
 * The judge's verdict and critique for an item that has a human label. The
 * caller passes the label, so an item that was never labelled cannot be
 * revealed. Null when the label's id is not a queue item id or its run is gone.
 */
export function revealItem(label: Label, findRun: RunLookup): Reveal | null {
  const split = label.id.indexOf(':')
  if (split <= 0) return null
  const runId = label.id.slice(0, split)
  const criterionId = label.id.slice(split + 1)
  const found = findRun(runId)
  if (!found) return null

  let judge: Reveal['judge'] = null
  for (const g of found.result.graders) {
    const c = (g.status === 'pass' || g.status === 'fail' ? g.criteria ?? [] : []).find(x => x.id === criterionId)
    if (c) judge = { verdict: c.verdict, critique: c.critique, critical: c.critical, grader: g.grader }
  }
  return {
    labelId: label.id,
    runId,
    suiteId: found.suiteId,
    judge,
    runError: found.result.error ?? null,
    human: { verdict: label.verdict, critique: label.critique, labeler: label.labeler, at: label.at },
    agrees: judge ? judge.verdict === label.verdict : null,
  }
}
