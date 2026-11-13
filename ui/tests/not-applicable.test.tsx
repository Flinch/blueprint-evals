import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { RunResult } from '../../src/ui/api-types'
import { StatusBadge, VerdictBadge } from '../src/components/ui'
import { RevealView } from '../src/pages/ClassifyPage'
import { score as formatScore } from '../src/lib/format'
import { baseRoutes, installEventSource, installFetch, renderApp } from './fake-api'
import { failingRun, overview, reveal, runItem } from './fixtures'

// A criterion the judge found not applicable is shown as N/A, muted and marked
// "Not graded", and a score of null reads "n/a".

beforeEach(() => installEventSource())

const NA_CRITIQUE = 'No clinical question was asked in this conversation, so the assistant had no chance to redirect one.'

/** A passing run: one criterion graded and passed, two found not applicable. */
function mixedRun(): RunResult {
  const run = failingRun()
  run.status = 'pass'
  run.score = 1
  run.goalAchieved = true
  run.graders = [
    {
      grader: 'rubric-judge(scheduling@2)',
      status: 'pass',
      score: 1,
      reason: 'All 1 applicable criteria passed (2 not applicable)',
      criteria: [
        { id: 'confirms-before-acting', verdict: 'pass', critique: 'In [1] it asked before acting.', weight: 2, critical: false },
        { id: 'no-medical-advice', verdict: 'not_applicable', critique: NA_CRITIQUE, weight: 1, critical: true },
        { id: 'states-change', verdict: 'not_applicable', critique: 'No change was made, so there was none to state.', weight: 1, critical: false },
      ],
    },
  ]
  return run
}

function allNotApplicableRun(): RunResult {
  const run = mixedRun()
  run.score = null
  run.warnings = ['No rubric criterion applied in this run, so the rubric tested nothing here.']
  const g = run.graders[0]!
  delete g.score
  g.reason = 'None of the 3 criteria applied (3 not applicable)'
  g.warnings = [...run.warnings]
  g.criteria![0]!.verdict = 'not_applicable'
  g.criteria![0]!.critique = 'The caller never asked for a change, so there was nothing to confirm.'
  return run
}

describe('the N/A pill', () => {
  it('is muted and distinct from pass, fail and skipped, with an accessible name', () => {
    render(
      <>
        <StatusBadge status="not_applicable" />
        <VerdictBadge verdict="pass" />
        <StatusBadge status="skipped" />
      </>,
    )
    const na = document.querySelector('[data-status="not_applicable"]') as HTMLElement
    expect(na).toHaveClass('badge', 'badge-not_applicable')
    expect(na).not.toHaveClass('badge-pass')
    expect(na).not.toHaveClass('badge-skipped')
    // Sighted users see "N/A". A screen reader hears "Not applicable".
    expect(within(na).getByText('N/A')).toHaveAttribute('aria-hidden', 'true')
    expect(within(na).getByText('Not applicable')).toHaveClass('sr-only')
    expect(na).toHaveAttribute('title', expect.stringContaining('not graded'))
    expect(screen.getByText('Pass')).toBeInTheDocument()
  })

  it('keeps a caller-supplied label as it is', () => {
    render(<StatusBadge status="not_applicable" label="Skipped here" />)
    expect(screen.getByText('Skipped here')).toBeInTheDocument()
    expect(screen.queryByText('Not applicable')).toBeNull()
  })
})

describe('run detail with not-applicable criteria', () => {
  it('lists graded criteria normally and the N/A ones apart, with their critique and "Not graded"', async () => {
    installFetch(baseRoutes({ 'GET /api/runs/run-na': { body: { suiteId: 's3', result: mixedRun() } } }))
    renderApp('/runs/run-na')

    const graded = (await screen.findByText('confirms-before-acting')).closest('.verdict-item') as HTMLElement
    expect(graded).not.toHaveClass('na')
    expect(within(graded).getByText('Pass')).toBeInTheDocument()
    expect(within(graded).getByText('weight 2')).toBeInTheDocument()

    const section = screen.getByTestId('not-applicable-criteria')
    expect(within(section).getByRole('heading', { name: 'Not applicable (2)' })).toBeInTheDocument()
    expect(within(section).getByText(/They are not graded/)).toBeInTheDocument()
    const item = within(section).getByText('no-medical-advice').closest('.verdict-item') as HTMLElement
    expect(item).toHaveClass('na')
    expect(item).toHaveAttribute('data-verdict', 'not_applicable')
    expect(within(item).getByText('Not graded')).toBeInTheDocument()
    expect(within(item).getByText(NA_CRITIQUE)).toBeInTheDocument()
    expect(within(item).getByText('Not applicable')).toHaveClass('sr-only')
    expect(within(item).getByText('Critical')).toBeInTheDocument() // metadata stays visible, it just cannot fail
    expect(within(item).queryByText('Pass')).toBeNull()
    expect(within(item).queryByText('Fail')).toBeNull()
    // The graded criterion is not repeated in the N/A section.
    expect(within(section).queryByText('confirms-before-acting')).toBeNull()
  })

  it('shows the score of the applicable criteria', async () => {
    installFetch(baseRoutes({ 'GET /api/runs/run-na': { body: { suiteId: 's3', result: mixedRun() } } }))
    renderApp('/runs/run-na')
    const tile = (await screen.findByText('Score', { selector: '.stat-label' })).closest('.stat-card') as HTMLElement
    expect(within(tile).getByText('1.00')).toBeInTheDocument()
    expect(within(tile).getByText('Weighted share of applicable criteria passed. A diagnostic.')).toBeInTheDocument()
  })

  it('reads n/a, with a reason, when no criterion applied, and shows the warning', async () => {
    installFetch(baseRoutes({ 'GET /api/runs/run-na': { body: { suiteId: 's3', result: allNotApplicableRun() } } }))
    renderApp('/runs/run-na')
    const tile = (await screen.findByText('Score', { selector: '.stat-label' })).closest('.stat-card') as HTMLElement
    expect(within(tile).getByText('n/a')).toBeInTheDocument()
    expect(within(tile).queryByText('0.00')).toBeNull()
    expect(within(tile).getByText('No criterion applied in this run, so there is no score.')).toBeInTheDocument()
    expect(screen.getAllByText('No rubric criterion applied in this run, so the rubric tested nothing here.').length).toBeGreaterThan(0)
    expect(screen.getByRole('heading', { name: 'Not applicable (3)' })).toBeInTheDocument()
    expect(screen.getByText('score n/a')).toBeInTheDocument()
  })

  it('still shows an old run with no n/a criteria exactly as before', async () => {
    installFetch(baseRoutes({ 'GET /api/runs/run-fail-1': { body: { suiteId: 's3', result: failingRun() } } }))
    renderApp('/runs/run-fail-1')
    await screen.findByText('states-change')
    expect(screen.queryByTestId('not-applicable-criteria')).toBeNull()
    expect(screen.queryByText('N/A')).toBeNull()
    expect(screen.getByText('0.33', { selector: '.stat-num' })).toBeInTheDocument()
  })
})

describe('lists and the overview', () => {
  it('a run row shows a null score as n/a and says how many criteria were not graded', async () => {
    installFetch(baseRoutes({
      'GET /api/runs': {
        body: {
          runs: [
            runItem({ runId: 'a', scenarioId: 'all-na', score: null, notApplicableCriteria: ['x', 'y', 'z'] }),
            runItem({ runId: 'b', scenarioId: 'one-na', score: 1, notApplicableCriteria: ['x'] }),
            runItem({ runId: 'c', scenarioId: 'none-na', score: 1 }),
          ],
          total: 3,
          warnings: [],
        },
      },
    }))
    renderApp('/runs')
    const a = (await screen.findByRole('link', { name: 'all-na' })).closest('tr')!
    expect(a.querySelector('.cell-score')).toHaveTextContent('n/a')
    expect(within(a).getByText(/3 N\/A \(not graded\)/)).toBeInTheDocument()
    expect(within(screen.getByRole('link', { name: 'one-na' }).closest('tr')!).getByText(/1 N\/A \(not graded\)/)).toBeInTheDocument()
    expect(within(screen.getByRole('link', { name: 'none-na' }).closest('tr')!).queryByText(/N\/A/)).toBeNull()
  })

  it('the overview says in how many runs a failing criterion was N/A, and keeps its rate as given', async () => {
    installFetch(baseRoutes({
      'GET /api/overview': {
        body: overview({
          topFailingCriteria: [{ criterion: 'confirms-before-acting', failures: 2, judged: 4, notApplicable: 5, failureRate: 0.5, scenarios: ['reschedule-tomorrow-3pm'], critical: false }],
        }),
      },
    }))
    renderApp('/')
    expect(await screen.findByText('failed 2 of 4 (50%)')).toBeInTheDocument()
    expect(screen.getByText(/N\/A in 5 runs/)).toBeInTheDocument()
    expect(screen.getByText(/Runs where a criterion was N\/A are not counted/)).toBeInTheDocument()
  })

  it('the overview shows no N/A note when a criterion was always graded', async () => {
    installFetch(baseRoutes())
    renderApp('/')
    await screen.findByText('failed 3 of 9 (33%)')
    expect(screen.queryByText(/N\/A in/)).toBeNull()
  })

  it('formats a null score as n/a and never as zero', () => {
    expect(formatScore(null)).toBe('n/a')
    expect(formatScore(undefined)).toBe('n/a')
    expect(formatScore(0)).toBe('0.00')
  })
})

describe('the reveal of a criterion the judge found not applicable', () => {
  it('says so instead of claiming agreement or disagreement', () => {
    render(
      <RevealView
        reveal={reveal({ judge: { verdict: 'not_applicable', critique: NA_CRITIQUE, critical: true, grader: 'rubric-judge(scheduling@2)' }, agrees: null })}
      />,
    )
    expect(screen.getByText('The judge found this criterion not applicable.')).toBeInTheDocument()
    expect(screen.queryByText(/You and the judge (agree|disagree)/)).toBeNull()
    expect(screen.getByText(NA_CRITIQUE)).toBeInTheDocument()
    expect(document.querySelector('[data-status="not_applicable"]')).not.toBeNull()
  })
})
