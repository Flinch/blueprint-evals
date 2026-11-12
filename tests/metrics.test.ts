import { describe, expect, it } from 'vitest'
import { cohensKappa, computeMetrics, wilsonInterval } from '../src/index.js'
import type { Verdict } from '../src/index.js'

const pairs = (spec: [Verdict, Verdict, number][]) =>
  spec.flatMap(([expert, judge, n]) => Array.from({ length: n }, () => ({ expert, judge })))

describe('wilsonInterval', () => {
  it('matches known values', () => {
    const [lo, hi] = wilsonInterval(8, 10)!
    expect(lo).toBeCloseTo(0.4902, 3)
    expect(hi).toBeCloseTo(0.9433, 3)
    const [lo2, hi2] = wilsonInterval(50, 100)!
    expect(lo2).toBeCloseTo(0.4038, 3)
    expect(hi2).toBeCloseTo(0.5962, 3)
  })
  it('stays inside 0 and 1 and is not degenerate at the extremes', () => {
    const [lo, hi] = wilsonInterval(10, 10)!
    expect(hi).toBe(1)
    expect(lo).toBeGreaterThan(0.6)
    expect(wilsonInterval(0, 10)![0]).toBe(0)
    expect(wilsonInterval(0, 10)![1]).toBeGreaterThan(0.1)
  })
  it('narrows as the sample grows', () => {
    const width = (s: number, n: number) => { const [a, b] = wilsonInterval(s, n)!; return b - a }
    expect(width(90, 100)).toBeLessThan(width(9, 10))
  })
  it('is null when there is nothing to measure', () => {
    expect(wilsonInterval(0, 0)).toBeNull()
  })
})

describe('computeMetrics', () => {
  it('counts the confusion matrix and the two rates from the right classes', () => {
    const m = computeMetrics(pairs([['pass', 'pass', 40], ['pass', 'fail', 10], ['fail', 'fail', 30], ['fail', 'pass', 20]]))
    expect(m.confusion).toEqual({ tp: 40, fn: 10, tn: 30, fp: 20 })
    expect(m.tpr).toMatchObject({ rate: 0.8, successes: 40, n: 50 })
    expect(m.tnr).toMatchObject({ rate: 0.6, successes: 30, n: 50 })
    expect(m.accuracy).toBe(0.7)
    expect(m.prevalencePass).toBe(0.5)
    expect(m.n).toBe(100)
  })

  it('gives each rate an interval that contains it', () => {
    const m = computeMetrics(pairs([['pass', 'pass', 40], ['pass', 'fail', 10], ['fail', 'fail', 30], ['fail', 'pass', 20]]))
    for (const r of [m.tpr, m.tnr]) {
      expect(r.interval![0]).toBeLessThan(r.rate!)
      expect(r.interval![1]).toBeGreaterThan(r.rate!)
    }
  })

  it('exposes a judge that always passes: high accuracy, zero true negative rate, no kappa', () => {
    // 95 percent of cases pass. A judge that says "pass" to everything agrees 95 percent of the time.
    const m = computeMetrics(pairs([['pass', 'pass', 95], ['fail', 'pass', 5]]))
    expect(m.accuracy).toBe(0.95)
    expect(m.tnr.rate).toBe(0)
    expect(m.kappa).toBe(0)
    expect(m.warnings.join(' ')).toMatch(/accuracy is misleading when one class dominates/)
  })

  it('flags a small sample and says which part is poorly measured', () => {
    const m = computeMetrics(pairs([['pass', 'pass', 20], ['fail', 'fail', 10]]))
    expect(m.insufficient).toBe(true)
    const w = m.warnings.join(' ')
    expect(w).toMatch(/Only 30 labels/)
    expect(w).toMatch(/Only 20 expert-pass/)
    expect(w).toMatch(/Only 10 expert-fail/)
  })

  it('is not flagged once every class has 30 and the total is 60', () => {
    const m = computeMetrics(pairs([['pass', 'pass', 28], ['pass', 'fail', 2], ['fail', 'fail', 27], ['fail', 'pass', 3]]))
    expect(m.insufficient).toBe(false)
    expect(m.warnings).toEqual([])
  })

  it('handles no labels and a single class without inventing numbers', () => {
    const none = computeMetrics([])
    expect(none).toMatchObject({ n: 0, accuracy: null, kappa: null, insufficient: true })
    expect(none.tpr.rate).toBeNull()
    expect(none.warnings).toContain('No labels were measured.')

    const onlyFails = computeMetrics(pairs([['fail', 'fail', 5]]))
    expect(onlyFails.tpr).toMatchObject({ rate: null, n: 0, interval: null })
    expect(onlyFails.tnr.rate).toBe(1)
  })
})

describe('cohensKappa', () => {
  it('is 1 for perfect agreement with both classes present, and 0 for chance', () => {
    expect(cohensKappa({ tp: 10, fn: 0, tn: 10, fp: 0 })).toBe(1)
    expect(cohensKappa({ tp: 5, fn: 5, tn: 5, fp: 5 })).toBe(0)
  })
  it('is null, not a number, when one side only ever gave a single answer', () => {
    expect(cohensKappa({ tp: 10, fn: 0, tn: 0, fp: 0 })).toBeNull()
    expect(cohensKappa({ tp: 0, fn: 0, tn: 0, fp: 0 })).toBeNull()
  })
})
