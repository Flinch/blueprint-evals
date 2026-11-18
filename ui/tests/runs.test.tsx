import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { baseRoutes, installEventSource, installFetch, renderApp } from './fake-api'
import { failingRun, runItem, suiteItem } from './fixtures'

beforeEach(() => installEventSource())

const runs = [
  runItem({ runId: 'run-1', scenarioId: 'reschedule-tomorrow-3pm', status: 'pass', goalAchieved: true, costUsd: 0.05 }),
  runItem({ runId: 'run-2', scenarioId: 'asks-to-cancel-then-declines', status: 'fail', goalAchieved: false, failedCriteria: ['confirms-before-acting'], failedChecks: ['must_not_call(cancel_appointment)'], tags: ['safety'], costUsd: null }),
  runItem({ runId: 'run-3', scenarioId: 'asks-for-medical-advice', status: 'error', goalAchieved: null, score: null, error: 'Judge call failed: timeout', tags: ['safety'], costUsd: 0.01 }),
]

describe('runs list', () => {
  it('lists suites, then runs with status, goal, score and an unknown cost', async () => {
    installFetch(baseRoutes({
      'GET /api/suites': { body: { suites: [suiteItem()], warnings: [] } },
      'GET /api/runs': { body: { runs, total: 3, warnings: [] } },
    }))
    renderApp('/runs')
    expect(await screen.findByRole('button', { name: 's3' })).toBeInTheDocument()
    const row = (await screen.findByRole('link', { name: 'asks-to-cancel-then-declines' })).closest('tr')!
    expect(within(row).getByText('Fail')).toBeInTheDocument()
    expect(within(row).getByText('Not achieved')).toBeInTheDocument()
    expect(within(row).getByText('Unknown')).toBeInTheDocument()
    expect(within(row).getByText(/Failed: must_not_call\(cancel_appointment\), confirms-before-acting/)).toBeInTheDocument()
    const errorRow = screen.getByRole('link', { name: 'asks-for-medical-advice' }).closest('tr')!
    expect(within(errorRow).getByText('Judge call failed: timeout')).toBeInTheDocument()
    expect(within(errorRow).getByText('No goal check')).toBeInTheDocument()
  })

  it('filters by status through the server, and searches in the page', async () => {
    const user = userEvent.setup()
    const fake = installFetch(baseRoutes({
      'GET /api/suites': { body: { suites: [suiteItem()], warnings: [] } },
      'GET /api/runs': ({ query }) => {
        const status = query.get('status')
        const rows = status ? runs.filter(r => r.status === status) : runs
        return { body: { runs: rows, total: rows.length, warnings: [] } }
      },
    }))
    renderApp('/runs')
    await screen.findByRole('link', { name: 'reschedule-tomorrow-3pm' })

    await user.selectOptions(screen.getByLabelText('Status'), 'fail')
    await waitFor(() => expect(screen.queryByRole('link', { name: 'reschedule-tomorrow-3pm' })).toBeNull())
    expect(screen.getByRole('link', { name: 'asks-to-cancel-then-declines' })).toBeInTheDocument()
    expect(fake.to('GET /api/runs').some(c => c.query.get('status') === 'fail')).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    await screen.findByRole('link', { name: 'reschedule-tomorrow-3pm' })
    await user.type(screen.getByLabelText('Search'), 'timeout')
    await waitFor(() => expect(screen.queryByRole('link', { name: 'reschedule-tomorrow-3pm' })).toBeNull())
    expect(screen.getByRole('link', { name: 'asks-for-medical-advice' })).toBeInTheDocument()
  })

  it('shows an empty state when there are no runs', async () => {
    installFetch(baseRoutes())
    renderApp('/runs')
    expect(await screen.findByRole('heading', { name: 'No suites yet' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'No runs yet' })).toBeInTheDocument()
  })
})

describe('run detail', () => {
  const route = () => baseRoutes({ 'GET /api/runs/run-fail-1': { body: { suiteId: 's3', result: failingRun() } } })

  it('shows skipped distinctly and never as a pass', async () => {
    installFetch(route())
    renderApp('/runs/run-fail-1')
    const skipped = (await screen.findByText('tool_called(reschedule_appointment)')).closest('.verdict-item')!
    expect(skipped).toHaveAttribute('data-status', 'skipped')
    expect(skipped).toHaveClass('skipped')
    expect(within(skipped as HTMLElement).getByText('Skipped')).toBeInTheDocument()
    expect(within(skipped as HTMLElement).queryByText('Pass')).toBeNull()
    expect(within(skipped as HTMLElement).getByText(/never counted as a pass/)).toBeInTheDocument()
    expect(screen.getByText('0 passed, 1 failed, 0 errored, 1 skipped')).toBeInTheDocument()
    expect(document.querySelector('.badge-skipped')).not.toBeNull()
  })

  it('shows the transcript with turn numbers that critiques cite', async () => {
    const user = userEvent.setup()
    installFetch(route())
    renderApp('/runs/run-fail-1')
    const transcript = await screen.findByLabelText('Transcript')
    expect(within(transcript).getByText('[0]')).toBeInTheDocument()
    expect(within(transcript).getByText('[3]')).toBeInTheDocument()
    expect(within(transcript).getByText('Okay, I have cancelled it for you.')).toBeInTheDocument()
    // A citation in a critique jumps to that turn.
    const cite = screen.getAllByRole('button', { name: 'Go to turn 1' })[0]!
    await user.click(cite)
    await waitFor(() => expect(document.getElementById('turn-1')).toHaveClass('flash'))
  })

  it('shows the conversation date the judge was told', async () => {
    installFetch(baseRoutes({ 'GET /api/runs/run-fail-1': { body: { suiteId: 's3', result: failingRun(), conversationDate: 'Thursday, 12 November 2026 (UTC)' } } }))
    renderApp('/runs/run-fail-1')
    expect(await screen.findByText('The conversation took place on Thursday, 12 November 2026 (UTC).')).toBeInTheDocument()
  })

  it('expands a tool call to show its arguments as JSON', async () => {
    const user = userEvent.setup()
    installFetch(route())
    renderApp('/runs/run-fail-1')
    const head = await screen.findByRole('button', { name: /Tool call: cancel_appointment/ })
    expect(head).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByLabelText('Arguments for cancel_appointment')).toBeNull()
    await user.click(head)
    expect(head).toHaveAttribute('aria-expanded', 'true')
    const args = screen.getByLabelText('Arguments for cancel_appointment')
    expect(args.textContent).toContain('"appointment": "thursday-14:00"')
    expect(screen.getByLabelText('Result of cancel_appointment').textContent).toContain('"ok": true')
  })

  it('shows each criterion with verdict, critique, weight and a critical marker', async () => {
    installFetch(route())
    renderApp('/runs/run-fail-1')
    const failed = (await screen.findByText('states-change')).closest('.verdict-item') as HTMLElement
    expect(within(failed).getByText('Fail')).toBeInTheDocument()
    expect(within(failed).getByText('Critical')).toBeInTheDocument()
    expect(within(failed).getByText('weight 1')).toBeInTheDocument()
    expect(within(failed).getByText(/It did say what it changed in/)).toBeInTheDocument()
    const noncritical = screen.getByText('confirms-before-acting').closest('.verdict-item') as HTMLElement
    expect(within(noncritical).queryByText('Critical')).toBeNull()
    expect(within(noncritical).getByText('weight 2')).toBeInTheDocument()
  })

  it('shows the goal check, warnings, models with effort, cost and tokens, and trace metadata', async () => {
    installFetch(route())
    renderApp('/runs/run-fail-1')
    expect(await screen.findByText('Goal not achieved')).toBeInTheDocument()
    expect(screen.getByText('The target reported tool calls but the shape is unconfirmed.')).toBeInTheDocument()
    expect(screen.getByText('anthropic/claude-opus-5-5, effort low')).toBeInTheDocument()
    expect(screen.getAllByText('anthropic/claude-opus-5-5, effort high').length).toBeGreaterThan(0)
    expect(screen.getByText('claude-opus-5-5-fallback')).toBeInTheDocument()
    expect(screen.getByText('5,400')).toBeInTheDocument()
    expect(screen.getByText('prompt-v7')).toBeInTheDocument()
    expect(screen.getByText('reported')).toBeInTheDocument()
  })

  it('shows the error of an error run, and an unknown cost as unknown', async () => {
    const run = failingRun()
    run.status = 'error'
    run.error = 'Judge call failed: timeout'
    run.costUsd = null
    run.trace.usage.costUsd = null
    installFetch(baseRoutes({ 'GET /api/runs/run-fail-1': { body: { suiteId: 's3', result: run } } }))
    renderApp('/runs/run-fail-1')
    expect(await screen.findByText('This run ended with an error.')).toBeInTheDocument()
    expect(screen.getByText('Judge call failed: timeout')).toBeInTheDocument()
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0)
    expect(screen.getByText(/never shown as zero/)).toBeInTheDocument()
  })

  it('renders transcript text as text, never as HTML', async () => {
    const run = failingRun()
    run.trace.turns[0]!.content = '<img src=x onerror="window.pwned=1"><b>bold</b>'
    installFetch(baseRoutes({ 'GET /api/runs/run-fail-1': { body: { suiteId: 's3', result: run } } }))
    renderApp('/runs/run-fail-1')
    const bubble = await screen.findByText(/<b>bold<\/b>/)
    expect(bubble.querySelector('b')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
  })

  it('shows an error state for a run that is gone', async () => {
    installFetch(baseRoutes())
    renderApp('/runs/nope')
    expect(await screen.findByText(/Could not load this run/)).toBeInTheDocument()
  })
})
