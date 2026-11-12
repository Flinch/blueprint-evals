import { describe, expect, it } from 'vitest'
import { aggregateScore, aggregateStatus, bandFor, bandHalfWidth } from '../src/index.js'
import type { CriterionResult, GraderResult } from '../src/index.js'

const crit = (id: string, score: number, threshold = 0.7, weight = 1, critical = false): CriterionResult => ({
  id, score, threshold, weight, critical, band: bandFor(score, threshold), rationale: '',
})
const judge = (...criteria: CriterionResult[]): GraderResult => ({
  grader: 'rubric-judge', status: 'pass', criteria, reason: '',
})
const det = (status: GraderResult['status']): GraderResult => ({ grader: 'tool_called', status, reason: '' })

describe('aggregateStatus', () => {
  it('passes when every criterion is a confident pass', () => {
    expect(aggregateStatus([det('pass'), judge(crit('a', 0.95), crit('b', 0.9))])).toBe('pass')
  })

  it('fails on a confident failure even when another criterion is uncertain (the old collapse)', () => {
    // Old rule: any criterion near its threshold made the whole run borderline.
    expect(aggregateStatus([judge(crit('a', 0.72), crit('b', 0.1))])).toBe('fail')
  })

  it('is uncertain only when nothing has confidently failed', () => {
    expect(aggregateStatus([judge(crit('a', 0.72), crit('b', 0.95))])).toBe('uncertain')
  })

  it('fails on a deterministic failure regardless of the judge', () => {
    expect(aggregateStatus([det('fail'), judge(crit('a', 0.72))])).toBe('fail')
  })

  it('reports an infrastructure error as error, not a verdict', () => {
    expect(aggregateStatus([det('pass'), { grader: 'rubric-judge', status: 'error', reason: 'timeout' }])).toBe('error')
    expect(aggregateStatus([det('fail'), { grader: 'rubric-judge', status: 'error', reason: 'refusal' }])).toBe('error')
  })

  it('does not count a skipped grader as a failure or a pass', () => {
    expect(aggregateStatus([{ grader: 'tool_called', status: 'skipped', reason: 'target reports no tool calls' }])).toBe('pass')
  })
})

describe('aggregateScore', () => {
  it('is the weighted mean of criterion scores', () => {
    expect(aggregateScore([judge(crit('a', 1, 0.7, 2), crit('b', 0, 0.7, 1))])).toBeCloseTo(2 / 3)
  })
  it('is null when there are no criteria', () => {
    expect(aggregateScore([det('pass')])).toBeNull()
  })
})

describe('bands', () => {
  it('keeps the original 0.1 cap at mid thresholds', () => {
    expect(bandHalfWidth(0.7)).toBeCloseTo(0.1)
  })
  it('narrows near an edge so a strong response can still be a confident pass', () => {
    expect(bandHalfWidth(0.9)).toBeCloseTo(0.05)
    expect(bandFor(0.96, 0.9)).toBe('confident_pass')
  })
})
