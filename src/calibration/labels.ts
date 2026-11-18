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
    /**
     * Set on a revision: the id of the label line this one supersedes. A
     * revision's id is `<itemId>~r<n>`, and it keeps the original's group,
     * criterion, input, output and sampled_by, so its split and its place in the
     * random quota never change. The original stays in the file. See "Changing a
     * label after seeing the judge" in 0002.
     */
    replaces: z.string().min(1).optional(),
  })
  // `split` is deliberately not a field. It is derived from the id, and a stored
  // value would let an example be moved to the wrong side by hand.
  .strict()
export type Label = z.infer<typeof LabelSchema>

// ---------------------------------------------------------------- loading

/**
 * Every line of a label file, revisions included, in file order. Each line is
 * checked on its own. Replace chains are checked by `resolveLabels`, which every
 * reader of "the person's answer" calls.
 */
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

// -------------------------------------------------------------- revisions
// A person who labelled an item blind and then saw the judge may change their
// mind. The blind label is evidence, so it is never rewritten: the change is a
// new line that names the line it replaces. Every reader that means "the
// person's answer" uses the end of each chain (`current`). The originals
// (`blind`) stay available, because a revision was made with the judge's answer
// in view and may have drifted toward it.

export class LabelChainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LabelChainError'
  }
}

const REVISION_SUFFIX = /~r\d+$/

/**
 * The item a label is about. For an original label that is its id. For a
 * revision it is the id without the trailing `~r<n>`. Only a revision is
 * stripped, so a hand-written original whose id happens to end in `~r1` keeps it.
 */
export function itemIdOfLabel(label: Pick<Label, 'id' | 'replaces'>): string {
  return label.replaces === undefined ? label.id : label.id.replace(REVISION_SUFFIX, '')
}

/** The id the next revision of an item gets, given how many revisions it has. */
export function revisionId(itemId: string, revisionsSoFar: number): string {
  return `${itemId}~r${revisionsSoFar + 1}`
}

export interface ResolvedLabels {
  /** One label per item: the end of each replace chain, in the order the originals appear in the file. */
  current: Label[]
  /** The labels without `replaces`: what each person said before any revision. One per item, same order. */
  blind: Label[]
  /** Item ids that have at least one revision. */
  revised: Set<string>
  /** For each revised item, the superseded versions oldest first (the blind label, then any earlier revisions). */
  history: Map<string, Label[]>
}

/** The fields a revision may not change, because they decide the split, the content key or the random quota. */
const FIXED_FIELDS = ['group', 'criterion', 'input', 'output', 'sampled_by'] as const

/**
 * Follows every replace chain in a label file. Throws LabelChainError, naming
 * the ids involved, for a revision of an id that is not in the file, two labels
 * replacing the same id (a fork), a cycle, a revision whose item differs from
 * the label it replaces, or a revision that changes a fixed field.
 */
export function resolveLabels(labels: Label[]): ResolvedLabels {
  const byId = new Map(labels.map(l => [l.id, l]))
  const replacedBy = new Map<string, Label>()
  for (const l of labels) {
    if (l.replaces === undefined) continue
    const target = byId.get(l.replaces)
    if (!target) throw new LabelChainError(`Label "${l.id}" replaces "${l.replaces}", which is not in the file.`)
    const other = replacedBy.get(l.replaces)
    if (other) throw new LabelChainError(`Labels "${other.id}" and "${l.id}" both replace "${l.replaces}". A label can be replaced once; revise the latest version instead.`)
    if (itemIdOfLabel(l) !== itemIdOfLabel(target)) {
      throw new LabelChainError(`Label "${l.id}" replaces "${l.replaces}", which is about another item ("${itemIdOfLabel(target)}"). A revision's id is "<itemId>~r<n>".`)
    }
    replacedBy.set(l.replaces, l)
  }

  const current: Label[] = []
  const blind: Label[] = []
  const revised = new Set<string>()
  const history = new Map<string, Label[]>()
  const reached = new Set<string>()
  for (const original of labels) {
    if (original.replaces !== undefined) continue
    blind.push(original)
    reached.add(original.id)
    const chain: Label[] = [original]
    let next = replacedBy.get(original.id)
    while (next) {
      for (const field of FIXED_FIELDS) {
        if (next[field] !== original[field]) {
          throw new LabelChainError(`Label "${next.id}" changes "${field}" from the original label "${original.id}". A revision may change only the verdict, critique, labeler and time.`)
        }
      }
      reached.add(next.id)
      chain.push(next)
      next = replacedBy.get(next.id)
    }
    current.push(chain[chain.length - 1]!)
    if (chain.length > 1) {
      const itemId = itemIdOfLabel(original)
      revised.add(itemId)
      history.set(itemId, chain.slice(0, -1))
    }
  }
  // A revision no original leads to is part of a cycle, or hangs off one.
  const stranded = labels.filter(l => !reached.has(l.id))
  if (stranded.length > 0) {
    throw new LabelChainError(`These labels replace one another in a cycle, with no original label to start from: ${stranded.map(l => `"${l.id}"`).join(', ')}.`)
  }
  return { current, blind, revised, history }
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

/** The split of a label: by its group, or by its item id when it has none, so a revision always lands with its original. */
export function splitOf(label: Pick<Label, 'id' | 'group' | 'replaces'>, seed = ''): Split {
  return splitOfKey(label.group ?? itemIdOfLabel(label), seed)
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

/**
 * Whether a worked example was made from this label. The same content key is a
 * match whatever the criterion, because the judge has then seen the response.
 * An example whose input or output was trimmed before it was added still counts
 * as the label's when it is about the same criterion, has the same verdict, and
 * its output (and input, when it has one) is part of the label's.
 */
export function isExampleOf(anchor: Anchor, label: Pick<Label, 'criterion' | 'input' | 'output' | 'verdict'>): boolean {
  if (contentKey(anchor) === contentKey(label)) return true
  if (anchor.criterion !== label.criterion || anchor.verdict !== label.verdict) return false
  const output = normalise(anchor.output)
  if (output === '' || !normalise(label.output).includes(output)) return false
  return anchor.input === undefined || normalise(label.input ?? '').includes(normalise(anchor.input))
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
 * in the prompt would mean grading the judge on examples it was shown. Pass the
 * current labels (`resolveLabels(file).current`), so a revised item contributes
 * its latest verdict once.
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

/**
 * Problems with a label set that do not stop evaluation but weaken what it
 * shows. Takes every line of a file: the checks run on the current label of
 * each item. A broken replace chain is reported first, and the rest of the
 * checks then run on the original labels.
 */
export function checkLabels(all: Label[]): string[] {
  const warnings: string[] = []
  let labels: Label[]
  try {
    labels = resolveLabels(all).current
  } catch (e) {
    if (!(e instanceof LabelChainError)) throw e
    warnings.push(e.message)
    labels = all.filter(l => l.replaces === undefined)
  }

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
