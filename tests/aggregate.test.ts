import { describe, expect, it } from 'vitest'
import { aggregateScore, aggregateStatus, goalAchievedFrom } from '../src/index.js'
import type { CriterionResult, GraderResult } from '../src/index.js'

const crit = (id: string, verdict: 'pass' | 'fail', weight = 1, critical = false): CriterionResult => ({
  id, verdict, weight, critical, critique: '',
})
const judge = (...criteria: CriterionResult[]): GraderResult => ({
  grader: 'rubric-judge', status: criteria.some(c => c.verdict === 'fail') ? 'fail' : 'pass', criteria, reason: '',
})
const det = (status: GraderResult['status']): GraderResult => ({ grader: 'tool_called', status, reason: '' })
const goal = (status: GraderResult['status']): GraderResult => ({ grader: 'goal-check', status, reason: '' })

describe('aggregateStatus', () => {
  it('passes when every check and criterion passes', () => {
    expect(aggregateStatus([det('pass'), judge(crit('a', 'pass'), crit('b', 'pass'))])).toBe('pass')
  })

  it('fails when any criterion fails, however many others pass', () => {
    expect(aggregateStatus([judge(crit('a', 'pass'), crit('b', 'fail'), crit('c', 'pass'))])).toBe('fail')
  })

  it('fails on a deterministic failure regardless of the judge', () => {
    expect(aggregateStatus([det('fail'), judge(crit('a', 'pass'))])).toBe('fail')
  })

  it('fails when the goal was not achieved, even if every criterion passed', () => {
    expect(aggregateStatus([judge(crit('a', 'pass')), goal('fail')])).toBe('fail')
  })

  it('trusts the criteria over a grader that reports pass while one of them failed', () => {
    const inconsistent: GraderResult = { grader: 'rubric-judge', status: 'pass', criteria: [crit('a', 'fail')], reason: '' }
    expect(aggregateStatus([inconsistent])).toBe('fail')
  })

  it('reports an infrastructure error as error, not a verdict, even alongside a failure', () => {
    expect(aggregateStatus([det('pass'), { grader: 'rubric-judge', status: 'error', reason: 'timeout' }])).toBe('error')
    expect(aggregateStatus([det('fail'), { grader: 'rubric-judge', status: 'error', reason: 'refusal' }])).toBe('error')
  })

  it('does not count a skipped grader as a failure or a pass', () => {
    expect(aggregateStatus([{ grader: 'tool_called', status: 'skipped', reason: 'target reports no tool calls' }])).toBe('pass')
  })
})

describe('aggregateScore', () => {
  it('is the weighted share of criteria that passed', () => {
    expect(aggregateScore([judge(crit('a', 'pass', 2), crit('b', 'fail', 1))])).toBeCloseTo(2 / 3)
    expect(aggregateScore([judge(crit('a', 'pass', 1), crit('b', 'pass', 3))])).toBe(1)
    expect(aggregateScore([judge(crit('a', 'fail', 1), crit('b', 'fail', 3))])).toBe(0)
  })
  it('is null when no criteria were judged', () => {
    expect(aggregateScore([det('pass')])).toBeNull()
  })
})

describe('goalAchievedFrom', () => {
  it('reads the headline outcome from the goal check', () => {
    expect(goalAchievedFrom([det('pass'), goal('pass')])).toBe(true)
    expect(goalAchievedFrom([goal('fail')])).toBe(false)
  })
  it('is null, not false, when there is no goal or the check could not run', () => {
    expect(goalAchievedFrom([det('pass')])).toBeNull()
    expect(goalAchievedFrom([goal('skipped')])).toBeNull()
    expect(goalAchievedFrom([goal('error')])).toBeNull()
  })
})
