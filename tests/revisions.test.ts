import { describe, expect, it } from 'vitest'
import {
  checkLabels, contaminationProblem, evaluateJudge, formatReport, itemIdOfLabel, LabelChainError, parseLabels, partition, resolveLabels,
  revisionId, splitOf,
} from '../src/index.js'
import type { Label, LabelJudge, LabelJudgement } from '../src/index.js'
import { idInSplit, label, syntheticLabels } from './label-helpers.js'

// A changed label is a new line that replaces the current one. The blind label
// stays. See "Changing a label after seeing the judge" in 0002.

const rev = (of: Label, n: number, over: Partial<Label> = {}): Label => {
  const { replaces: _r, ...rest } = of
  return { ...rest, id: `${itemIdOfLabel(of)}~r${n}`, replaces: of.id, at: `2026-11-13T10:00:0${n}Z`, ...over }
}

describe('itemIdOfLabel and revisionId', () => {
  it('strips the revision suffix only from a revision', () => {
    expect(itemIdOfLabel({ id: 'run-1:c~r2', replaces: 'run-1:c~r1' })).toBe('run-1:c')
    expect(itemIdOfLabel({ id: 'run-1:c' })).toBe('run-1:c')
    // A hand-written original whose id happens to end like a revision keeps its id.
    expect(itemIdOfLabel({ id: 'odd~r1' })).toBe('odd~r1')
    expect(revisionId('run-1:c', 0)).toBe('run-1:c~r1')
    expect(revisionId('run-1:c', 2)).toBe('run-1:c~r3')
  })

  it('puts a revision in the same split as its original, with or without a group', () => {
    for (let i = 0; i < 40; i++) {
      const original = label({ id: `split-${i}` })
      expect(splitOf(rev(original, 1))).toBe(splitOf(original))
      expect(splitOf(rev(rev(original, 1), 2))).toBe(splitOf(original))
    }
  })
})

describe('resolveLabels', () => {
  const a = label({ id: 'run-1:c', group: 'run-1', verdict: 'fail' })
  const b = label({ id: 'run-2:c', group: 'run-2', output: 'Other.', verdict: 'pass' })

  it('returns the file unchanged when nothing was revised', () => {
    const r = resolveLabels([a, b])
    expect(r.current).toEqual([a, b])
    expect(r.blind).toEqual([a, b])
    expect(r.revised.size).toBe(0)
    expect(r.history.size).toBe(0)
  })

  it('follows a chain to its end, keeping the original order and the history oldest first', () => {
    const r1 = rev(a, 1, { verdict: 'pass', critique: 'On reflection it did ask.' })
    const r2 = rev(r1, 2, { verdict: 'fail', critique: 'No, it did not.' })
    // File order: the revisions may come after other labels.
    const r = resolveLabels([a, b, r1, r2])
    expect(r.current.map(l => l.id)).toEqual(['run-1:c~r2', 'run-2:c'])
    expect(r.blind.map(l => l.id)).toEqual(['run-1:c', 'run-2:c'])
    expect([...r.revised]).toEqual(['run-1:c'])
    expect(r.history.get('run-1:c')!.map(l => l.id)).toEqual(['run-1:c', 'run-1:c~r1'])
  })

  it('refuses a revision of an id that is not in the file', () => {
    expect(() => resolveLabels([b, rev(a, 1)])).toThrow(LabelChainError)
    expect(() => resolveLabels([b, rev(a, 1)])).toThrow(/"run-1:c~r1" replaces "run-1:c", which is not in the file/)
  })

  it('refuses a fork: two labels replacing the same id', () => {
    expect(() => resolveLabels([a, rev(a, 1), rev(a, 2)])).toThrow(/"run-1:c~r1" and "run-1:c~r2" both replace "run-1:c"/)
  })

  it('refuses a cycle', () => {
    const x = { ...rev(a, 1), replaces: 'run-1:c~r2' }
    const y = { ...rev(a, 2), replaces: 'run-1:c~r1' }
    expect(() => resolveLabels([a, x, y])).toThrow(/cycle[\s\S]*"run-1:c~r1", "run-1:c~r2"/)
    const self = { ...rev(a, 1), replaces: 'run-1:c~r1' }
    expect(() => resolveLabels([self])).toThrow(/cycle/)
  })

  it('refuses a revision about another item', () => {
    expect(() => resolveLabels([a, b, { ...rev(a, 1), replaces: 'run-2:c' }])).toThrow(/about another item \("run-2:c"\)/)
    // An id without the suffix is not a revision id of the item it replaces.
    expect(() => resolveLabels([a, { ...rev(a, 1), id: 'something-else' }])).toThrow(/about another item/)
  })

  it('refuses a revision that changes a field the split, the content or the quota depends on', () => {
    for (const [field, value] of [['criterion', 'other'], ['group', 'run-9'], ['output', 'Changed.'], ['input', 'Changed.'], ['sampled_by', 'targeted']] as const) {
      expect(() => resolveLabels([a, rev(a, 1, { [field]: value })]), field).toThrow(new RegExp(`changes "${field}" from the original label "run-1:c"`))
    }
    // Only verdict, critique, labeler and time may change.
    expect(() => resolveLabels([a, rev(a, 1, { verdict: 'pass', critique: 'x', labeler: 'someone else' })])).not.toThrow()
  })

  it('reads back from a file through parseLabels', () => {
    const text = [a, rev(a, 1, { verdict: 'pass' })].map(l => JSON.stringify(l)).join('\n')
    const parsed = parseLabels(text)
    expect(parsed).toHaveLength(2)
    expect(resolveLabels(parsed).current[0]!.verdict).toBe('pass')
  })
})

describe('checkLabels with revisions', () => {
  it('runs on the current labels, so a revision is not a duplicate response', () => {
    const labels = Array.from({ length: 10 }, (_, i) => label({ id: `y-${i}`, output: `o${i}` }))
    expect(checkLabels([...labels, rev(labels[0]!, 1, { verdict: 'pass' })])).toEqual([])
  })

  it('reports a broken chain', () => {
    expect(checkLabels([label({ id: 'a' }), rev(label({ id: 'gone' }), 1)]).join(' ')).toMatch(/replaces "gone", which is not in the file/)
  })
})

describe('evaluateJudge with revised labels', () => {
  const judgeOf = (fn: (l: Label) => LabelJudgement): LabelJudge & { seen: string[] } => {
    const seen: string[] = []
    return { name: 'fake-judge', anchors: [], seen, judge: async l => (seen.push(l.id), fn(l)) }
  }

  it('measures the current labels, and recomputes the rates on the blind labels with the same judge answers', async () => {
    const labels = syntheticLabels(400)
    const devRandom = partition(labels).dev.filter(l => l.sampled_by === 'random')
    // The judge says the opposite of the blind label on three items, and the person then changes to the judge's answer.
    const flipped = devRandom.slice(0, 3)
    const revisions = flipped.map(l => rev(l, 1, { verdict: l.verdict === 'pass' ? 'fail' : 'pass', critique: 'Changed my mind.' }))
    const flippedIds = new Set(flipped.map(l => l.id))
    const judge = judgeOf(l => ({ verdict: flippedIds.has(itemIdOfLabel(l)) ? (l.replaces ? l.verdict : l.verdict === 'pass' ? 'fail' : 'pass') : l.verdict }))

    const r = await evaluateJudge([...labels, ...revisions], judge, { split: 'dev' })
    // One judge call per item, never one per line.
    expect(judge.seen).toHaveLength(devRandom.length)
    expect(r.metrics.n).toBe(devRandom.length)
    // Against the current (changed) labels the judge agrees everywhere.
    expect(r.metrics.accuracy).toBe(1)
    expect(r.disagreements).toEqual([])
    expect(r.revisions).toMatchObject({ revised: 3, verdictChanged: 3 })
    // Against the blind labels it missed those three.
    const blind = r.revisions!.blindMetrics!
    expect(blind.n).toBe(devRandom.length)
    expect(blind.confusion.fn + blind.confusion.fp).toBe(3)
    expect(blind.accuracy).toBeCloseTo((devRandom.length - 3) / devRandom.length)
    // Items are named by item id, and carry the blind verdict when it differs.
    const item = r.items.find(i => i.id === flipped[0]!.id)!
    expect(item.blindExpert).toBe(flipped[0]!.verdict)
    expect(item.expert).not.toBe(flipped[0]!.verdict)
    expect(r.items.filter(i => i.blindExpert !== undefined)).toHaveLength(3)
    expect(r.warnings.join(' ')).toMatch(/3 of the measured labels were changed after the judge's answer was available/)
    expect(formatReport(r)).toMatch(/Changed after seeing the judge: 3 of these labels \(3 changed the verdict\)/)
  })

  it('reports no blind metrics when nothing in the selection was revised', async () => {
    const labels = syntheticLabels(100)
    // A revision of a train label is outside the dev selection.
    const train = labels.find(l => splitOf(l) === 'train')!
    const r = await evaluateJudge([...labels, rev(train, 1, { verdict: train.verdict === 'pass' ? 'fail' : 'pass' })], judgeOf(l => ({ verdict: l.verdict })), { split: 'dev' })
    expect(r.revisions).toEqual({ revised: 0, verdictChanged: 0, blindMetrics: null })
  })

  it('counts a critique-only change as revised, with the verdict unchanged', async () => {
    const id = idInSplit('dev', 'crit')
    const original = label({ id })
    const r = await evaluateJudge([original, rev(original, 1, { critique: 'Better words.' })], judgeOf(l => ({ verdict: l.verdict })), { split: 'dev' })
    expect(r.revisions).toMatchObject({ revised: 1, verdictChanged: 0 })
    expect(r.revisions!.blindMetrics!.accuracy).toBe(1)
    expect(r.items[0]!.expertCritique).toBe('Better words.')
  })

  it('refuses a broken chain before any judge call', async () => {
    const judge = judgeOf(l => ({ verdict: l.verdict }))
    await expect(evaluateJudge([rev(label({ id: idInSplit('dev') }), 1)], judge, { split: 'dev' })).rejects.toThrow(LabelChainError)
    expect(judge.seen).toEqual([])
  })

  it('names a contaminated item once, whichever lines are passed', () => {
    const id = idInSplit('dev', 'cont')
    const original = label({ id, output: 'Shown in the prompt.' })
    const anchors = [{ input: original.input, output: 'Shown in the prompt.', verdict: 'fail' as const, critique: 'x' }]
    const problem = contaminationProblem([original, rev(original, 1, { verdict: 'pass' })], anchors)!
    expect(problem.match(new RegExp(id.replace(/[-]/g, '\\-'), 'g'))).toHaveLength(1)
  })
})
