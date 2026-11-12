import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { Anchor } from '../core/scenario.js'

// Human labels, and the rules that keep a judge honest about them. See
// docs/design/0002-judge-methodology.md, Part B.
//
// A label is one expert verdict on one response against one criterion, with a
// written critique. Labels are stored one JSON object per line. The same format
// is produced by a review screen, a CLI, or a hand-edited file.

export const LabelSchema = z
  .object({
    /** Unique within a label file. */
    id: z.string().min(1),
    /**
     * The conversation or run this label belongs to. Every label with the same
     * group lands in the same split, so one transcript can never be a few-shot
     * example for one criterion and a test case for another. Defaults to `id`.
     */
    group: z.string().min(1).optional(),
    /** The rubric criterion the verdict is about. */
    criterion: z.string().min(1),
    /** What the response was responding to. A response is often only wrong relative to this. */
    input: z.string().optional(),
    output: z.string().min(1),
    verdict: z.enum(['pass', 'fail']),
    /** Required on every label, not only on disagreements: confirmations with a critique are the training material. */
    critique: z.string().min(1),
    labeler: z.string().min(1),
    /**
     * How the item reached the labeler. Accuracy metrics use random labels only:
     * targeted review (failures, disagreements) finds bugs but cannot estimate
     * how accurate the judge is.
     */
    sampled_by: z.enum(['random', 'targeted']),
    at: z.iso.datetime(),
  })
  // `split` is deliberately not a field. It is derived from the id, and a stored
  // value would let an example be moved to the wrong side by hand.
  .strict()
export type Label = z.infer<typeof LabelSchema>

// ---------------------------------------------------------------- loading

export function parseLabels(text: string, source = 'labels'): Label[] {
  const labels: Label[] = []
  const seen = new Map<string, number>()
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim()
    if (line === '') return
    const where = `${source}:${i + 1}`
    let json: unknown
    try {
      json = JSON.parse(line)
    } catch {
      throw new Error(`${where}: not valid JSON`)
    }
    const parsed = LabelSchema.safeParse(json)
    if (!parsed.success) throw new Error(`${where}:\n${z.prettifyError(parsed.error)}`)
    const prior = seen.get(parsed.data.id)
    if (prior !== undefined) throw new Error(`${where}: duplicate label id "${parsed.data.id}" (first seen on line ${prior})`)
    seen.set(parsed.data.id, i + 1)
    labels.push(parsed.data)
  })
  return labels
}

export function loadLabels(file: string): Label[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    throw new Error(`${file}: cannot read file (${e instanceof Error ? e.message : String(e)})`)
  }
  return parseLabels(text, file)
}

// ----------------------------------------------------------------- splits

export type Split = 'train' | 'dev' | 'test'

/** Roughly 15 percent train, and 42.5 percent each for dev and test. */
export const SPLIT_PROPORTIONS = { train: 0.15, dev: 0.425, test: 0.425 } as const

/**
 * The split for a key, by a stable hash: the same key always lands in the same
 * split, whatever else is in the file and whatever order it is in, so an item
 * never moves between splits as labels are added. The optional seed exists for
 * tests. A real label set uses no seed.
 */
export function splitOfKey(key: string, seed = ''): Split {
  const h = createHash('sha256').update(`${seed}\u0000${key}`).digest()
  const fraction = h.readUInt32BE(0) / 2 ** 32
  if (fraction < SPLIT_PROPORTIONS.train) return 'train'
  if (fraction < SPLIT_PROPORTIONS.train + SPLIT_PROPORTIONS.dev) return 'dev'
  return 'test'
}

export function splitOf(label: Pick<Label, 'id' | 'group'>, seed = ''): Split {
  return splitOfKey(label.group ?? label.id, seed)
}

export function partition(labels: Label[]): Record<Split, Label[]> {
  const out: Record<Split, Label[]> = { train: [], dev: [], test: [] }
  for (const l of labels) out[splitOf(l)].push(l)
  return out
}

// ---------------------------------------------------- content and anchors

const normalise = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * What identifies an example for contamination purposes: the input and output,
 * ignoring the criterion. If the judge has seen a response, it has seen it for
 * every criterion.
 */
export function contentKey(x: { input?: string; output: string }): string {
  return `${normalise(x.input ?? '')}\u0000${normalise(x.output)}`
}

export class SplitViolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SplitViolationError'
  }
}

/**
 * Few-shot examples for a judge's prompt, built from labels. Only train labels
 * are allowed. Anything else throws, naming the offenders: a dev or test label
 * in the prompt would mean grading the judge on examples it was shown.
 */
export function anchorsFromLabels(labels: Label[]): Anchor[] {
  const offenders = labels.map(l => ({ l, split: splitOf(l) })).filter(x => x.split !== 'train')
  if (offenders.length > 0) {
    throw new SplitViolationError(
      `Only train labels can become few-shot examples. Not allowed: ${offenders.map(o => `${o.l.id} (${o.split})`).join(', ')}.`,
    )
  }
  return labels.map(l => ({
    criterion: l.criterion,
    ...(l.input !== undefined ? { input: l.input } : {}),
    output: l.output,
    verdict: l.verdict,
    critique: l.critique,
  }))
}

// ------------------------------------------------------------ sanity checks

/** The share of labels that should be randomly sampled, per 0002. */
export const MIN_RANDOM_SHARE = 0.3

/** Problems with a label set that do not stop evaluation but weaken what it shows. */
export function checkLabels(labels: Label[]): string[] {
  const warnings: string[] = []

  // The same response under different ids, spread across splits, leaks through the content.
  const byContent = new Map<string, Label[]>()
  for (const l of labels) {
    const key = contentKey(l)
    byContent.set(key, [...(byContent.get(key) ?? []), l])
  }
  for (const group of byContent.values()) {
    const splits = new Set(group.map(l => splitOf(l)))
    if (splits.size > 1) {
      warnings.push(
        `The same input and output appear in more than one split (${[...splits].join(', ')}): ${group.map(l => l.id).join(', ')}. Give them the same group so they share a split.`,
      )
    }
  }

  if (labels.length > 0) {
    const share = labels.filter(l => l.sampled_by === 'random').length / labels.length
    if (share < MIN_RANDOM_SHARE) {
      warnings.push(
        `Only ${Math.round(share * 100)}% of labels were randomly sampled (${Math.round(MIN_RANDOM_SHARE * 100)}% or more recommended). Accuracy metrics use random labels only.`,
      )
    }
  }
  return warnings
}
