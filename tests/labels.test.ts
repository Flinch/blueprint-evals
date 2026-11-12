import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  anchorsFromLabels, checkLabels, contentKey, loadLabels, parseLabels, partition, SplitViolationError, splitOf, splitOfKey,
  SPLIT_PROPORTIONS,
} from '../src/index.js'
import { label } from './label-helpers.js'

const line = (over: Record<string, unknown> = {}) => JSON.stringify({ ...label(), ...over })

describe('parsing labels', () => {
  it('reads one label per line and ignores blank lines', () => {
    const labels = parseLabels(`${line({ id: 'a' })}\n\n${line({ id: 'b' })}\n`)
    expect(labels.map(l => l.id)).toEqual(['a', 'b'])
  })

  it('names the file and line on bad JSON, a schema problem or a duplicate id', () => {
    expect(() => parseLabels(`${line()}\n{not json`, 'labels.jsonl')).toThrow(/labels\.jsonl:2: not valid JSON/)
    expect(() => parseLabels(line({ verdict: 'borderline' }), 'labels.jsonl')).toThrow(/labels\.jsonl:1:[\s\S]*verdict/)
    expect(() => parseLabels(`${line()}\n${line()}`, 'labels.jsonl')).toThrow(/labels\.jsonl:2: duplicate label id "l1" \(first seen on line 1\)/)
  })

  it('requires a critique, a labeler and how the item was sampled on every label', () => {
    for (const field of ['critique', 'labeler', 'sampled_by']) {
      const bad = { ...label() } as Record<string, unknown>
      delete bad[field]
      expect(() => parseLabels(JSON.stringify(bad)), field).toThrow(new RegExp(field))
    }
    expect(() => parseLabels(line({ critique: '' }))).toThrow(/critique/)
  })

  it('rejects a stored split, since the split is derived and could otherwise be set by hand', () => {
    expect(() => parseLabels(line({ split: 'train' }))).toThrow(/split/)
  })

  it('loads the example label file', () => {
    const labels = loadLabels(join(import.meta.dirname, '..', 'examples', 'labels', 'scheduling.jsonl'))
    expect(labels).toHaveLength(8)
    expect(new Set(labels.map(l => l.criterion))).toEqual(new Set(['confirms-before-acting', 'no-medical-advice']))
  })

  it('reports an unreadable file by name', () => {
    expect(() => loadLabels('/nonexistent/labels.jsonl')).toThrow(/labels\.jsonl: cannot read file/)
  })
})

describe('splits', () => {
  it('are stable: golden values catch an accidental change to the hash', () => {
    expect(['run-1', 'run-2', 'run-4', 'run-5', 'run-7', 'run-8'].map(k => splitOfKey(k))).toEqual([
      'dev', 'test', 'train', 'test', 'dev', 'train',
    ])
  })

  it('do not depend on what else is in the file or its order', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `item-${i}`)
    const forward = ids.map(id => splitOf({ id }))
    const reversed = [...ids].reverse().map(id => splitOf({ id })).reverse()
    expect(reversed).toEqual(forward)
  })

  it('keep every label of one group together, so one transcript cannot straddle splits', () => {
    for (const group of ['run-a', 'run-b', 'run-c', 'run-d']) {
      const splits = ['c1', 'c2', 'c3'].map(c => splitOf({ id: `${group}-${c}`, group }))
      expect(new Set(splits).size).toBe(1)
    }
  })

  it('land close to the intended proportions over many ids', () => {
    const counts = { train: 0, dev: 0, test: 0 }
    const n = 20_000
    for (let i = 0; i < n; i++) counts[splitOfKey(`id-${i}`)]++
    for (const s of ['train', 'dev', 'test'] as const) {
      expect(Math.abs(counts[s] / n - SPLIT_PROPORTIONS[s])).toBeLessThan(0.01)
    }
  })

  it('partition sorts labels into the three splits without losing any', () => {
    const labels = Array.from({ length: 100 }, (_, i) => label({ id: `p-${i}` }))
    const p = partition(labels)
    expect(p.train.length + p.dev.length + p.test.length).toBe(100)
    expect(p.train.every(l => splitOf(l) === 'train')).toBe(true)
  })
})

describe('anchorsFromLabels', () => {
  const trainLabel = () => label({ id: [...Array(500).keys()].map(i => `t-${i}`).find(id => splitOfKey(id) === 'train')! })
  const otherLabel = (split: 'dev' | 'test') => label({ id: [...Array(500).keys()].map(i => `o-${i}`).find(id => splitOfKey(id) === split)! })

  it('turns train labels into few-shot examples with input, output, critique and verdict', () => {
    const a = anchorsFromLabels([trainLabel()])
    expect(a).toEqual([{ criterion: 'confirms', input: 'Move it', output: 'Done.', verdict: 'fail', critique: 'Acted without confirming.' }])
  })

  it('omits the input when the label has none', () => {
    expect(anchorsFromLabels([{ ...trainLabel(), input: undefined }])[0]).not.toHaveProperty('input')
  })

  it('refuses dev and test labels, naming each offender and its split', () => {
    const dev = otherLabel('dev')
    const test = otherLabel('test')
    expect(() => anchorsFromLabels([trainLabel(), dev, test])).toThrow(SplitViolationError)
    expect(() => anchorsFromLabels([dev, test])).toThrow(new RegExp(`${dev.id} \\(dev\\), ${test.id} \\(test\\)`))
  })
})

describe('contentKey', () => {
  it('ignores case, spacing and the criterion, since a response seen once has been seen for every criterion', () => {
    expect(contentKey({ input: 'Move  it', output: 'Done.' })).toBe(contentKey({ input: ' move it ', output: 'DONE.' }))
    expect(contentKey({ output: 'x' })).not.toBe(contentKey({ input: 'q', output: 'x' }))
  })
})

describe('checkLabels', () => {
  it('warns when the same response sits under different ids in different splits', () => {
    const ids = [...Array(500).keys()].map(i => `d-${i}`)
    const a = ids.find(id => splitOfKey(id) === 'train')!
    const b = ids.find(id => splitOfKey(id) === 'test')!
    const warnings = checkLabels([label({ id: a }), label({ id: b })])
    expect(warnings.join(' ')).toMatch(/more than one split \(train, test\)/)
    expect(warnings.join(' ')).toMatch(/same group/)
  })

  it('does not warn when they share a group', () => {
    const labels = [label({ id: 'a', group: 'g' }), label({ id: 'b', group: 'g' })]
    expect(checkLabels(labels).filter(w => /split/.test(w))).toEqual([])
  })

  it('warns when too few labels were randomly sampled', () => {
    const labels = Array.from({ length: 10 }, (_, i) => label({ id: `x-${i}`, output: `o${i}`, sampled_by: i === 0 ? 'random' : 'targeted' }))
    expect(checkLabels(labels).join(' ')).toMatch(/Only 10% of labels were randomly sampled/)
  })

  it('has nothing to say about a healthy set', () => {
    const labels = Array.from({ length: 10 }, (_, i) => label({ id: `y-${i}`, output: `o${i}` }))
    expect(checkLabels(labels)).toEqual([])
  })
})
