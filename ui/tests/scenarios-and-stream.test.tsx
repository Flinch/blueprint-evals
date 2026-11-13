import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ActiveJob, RunStreamEvent } from '../../src/ui/api-types'
import { costSoFar, initialStreamState, streamReducer, type RunStreamState } from '../src/state/runStream'
import { baseRoutes, failure, installEventSource, installFetch, renderApp } from './fake-api'
import { grader, preview, rubrics, scenarios } from './fixtures'

beforeEach(() => installEventSource())

describe('scenarios page', () => {
  it('lists scenarios and rubrics read-only, with checks, criteria and anchors', async () => {
    const user = userEvent.setup()
    installFetch(baseRoutes())
    renderApp('/scenarios')
    const card = (await screen.findByText('reschedule-tomorrow-3pm')).closest('details')!
    await user.click(within(card).getByText('reschedule-tomorrow-3pm'))
    expect(within(card).getByText('A rushed patient.')).toBeInTheDocument()
    expect(within(card).getByText('tool_called')).toBeInTheDocument()
    expect(within(card).getByText(/Up to 8 model calls/)).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull() // nothing to edit
    expect(screen.queryByRole('button', { name: /save|edit|delete/i })).toBeNull()

    await user.click(screen.getByRole('tab', { name: /Rubrics/ }))
    const rubric = (await screen.findByText('scheduling')).closest('details')!
    await user.click(within(rubric).getByText('scheduling'))
    expect(within(rubric).getByText('Gives no medical advice.')).toBeInTheDocument()
    expect(within(rubric).getByText('Critical')).toBeInTheDocument()
    expect(within(rubric).getByText('It acted without asking.')).toBeInTheDocument()
    expect(within(rubric).getByText('reschedule-tomorrow-3pm, asks-for-medical-advice')).toBeInTheDocument()
  })

  it('reports validation problems, and environment variables by name only', async () => {
    const user = userEvent.setup()
    const data = scenarios()
    data.validation.errors = ['Scenario "x" uses the target "nope", which is not in the config.']
    installFetch(baseRoutes({ 'GET /api/scenarios': { body: data }, 'GET /api/rubrics': { body: { ...rubrics(), problems: ['rubrics/bad.yaml: duplicate criterion id "a"'] } } }))
    renderApp('/scenarios')
    expect(await screen.findByText(/2 problems found\./)).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /Validation/ }))
    expect(await screen.findByText(/uses the target "nope"/)).toBeInTheDocument()
    expect(screen.getByText('rubrics/bad.yaml: duplicate criterion id "a"')).toBeInTheDocument()
    const row = screen.getByText('AGENT_TOKEN', { selector: 'td' }).closest('tr')!
    expect(within(row).getByText('Not set')).toBeInTheDocument()
    expect(screen.getByText(/Values are never sent to this page/)).toBeInTheDocument()
  })

  it('shows an empty state with no scenarios and an error state on failure', async () => {
    installFetch(baseRoutes({ 'GET /api/scenarios': { body: { ...scenarios(), path: null, scenarios: [] } } }))
    renderApp('/scenarios')
    expect(await screen.findByRole('heading', { name: 'No scenarios found' })).toBeInTheDocument()
  })

  it('shows an error state when scenarios cannot load', async () => {
    installFetch(baseRoutes({ 'GET /api/scenarios': failure(409, 'config_missing', 'No config file was found.') }))
    renderApp('/scenarios')
    expect(await screen.findByText(/No config file was found\./)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------- the reducer

const at = '2026-11-12T10:00:00.000Z'
const job: ActiveJob = { kind: 'run', startedAt: at, suiteId: 's1', scenarioIds: ['a', 'b'], finished: 0, cancelling: false }

function apply(state: RunStreamState, ...events: RunStreamEvent[]) {
  return events.reduce((s, event) => streamReducer(s, { type: 'event', event }), state)
}

const start: RunStreamEvent = { seq: 1, at, suiteId: 's1', type: 'suite:start', startedAt: at, scenarioIds: ['a', 'b'], preview: preview() }
const summary = (runId: string, scenarioId: string, costUsd: number | null) =>
  ({ runId, scenarioId, scenarioVersion: '1', status: 'pass' as const, score: 1, goalAchieved: true, costUsd, durationMs: 10, turns: 1, failedCriteria: [], warnings: 0 })

describe('run stream reducer', () => {
  it('builds per-scenario progress from the events, in order', () => {
    let s = streamReducer(initialStreamState, { type: 'hello', hello: { type: 'hello', activeJob: job } })
    s = apply(s, start, { seq: 2, at, suiteId: 's1', type: 'run:start', runId: 'r1', scenarioId: 'a' })
    expect(s.suite?.runs.map(r => r.phase)).toEqual(['running', 'queued'])
    s = apply(s, { seq: 3, at, suiteId: 's1', type: 'grader:done', runId: 'r1', result: grader() })
    expect(s.suite?.runs[0]?.graders).toHaveLength(1)
    s = apply(s, { seq: 4, at, suiteId: 's1', type: 'run:end', runId: 'r1', summary: summary('r1', 'a', 0.5) })
    expect(s.suite?.runs[0]?.phase).toBe('pass')
    expect(s.activeJob?.finished).toBe(1)
    expect(s.refreshTick).toBe(1)
  })

  it('applies an event once, however many times it is replayed', () => {
    const turn: RunStreamEvent = { seq: 3, at, suiteId: 's1', type: 'turn', runId: 'r1', turn: { index: 0, role: 'user', content: 'hi', at } }
    let s = apply(initialStreamState, start, { seq: 2, at, suiteId: 's1', type: 'run:start', runId: 'r1', scenarioId: 'a' }, turn)
    s = apply(s, start, turn, turn)
    expect(s.suite?.runs[0]?.turns).toHaveLength(1)
  })

  it('clears the active job at suite:end and a new suite starts fresh', () => {
    let s = apply(initialStreamState, start)
    s = apply(s, { seq: 5, at, suiteId: 's1', type: 'suite:end', state: 'complete', summary: { runs: 0, pass: 0, fail: 0, error: 0, goal: { achieved: 0, total: 0 }, avgScore: null, costUsd: 0, durationMs: 0, scenarios: [] }, warnings: [] })
    expect(s.activeJob).toBeNull()
    expect(s.suite?.end?.state).toBe('complete')
    s = apply(s, { ...start, seq: 6, suiteId: 's2', scenarioIds: ['c'] })
    expect(s.suite?.suiteId).toBe('s2')
    expect(s.suite?.end).toBeNull()
    expect(s.suite?.runs).toHaveLength(1)
  })

  it('cost so far is null as soon as any part is unknown', () => {
    let s = apply(initialStreamState, start, { seq: 2, at, suiteId: 's1', type: 'run:start', runId: 'r1', scenarioId: 'a' })
    s = apply(s, { seq: 3, at, suiteId: 's1', type: 'run:end', runId: 'r1', summary: summary('r1', 'a', 0.5) })
    expect(costSoFar(s.suite)).toBe(0.5)
    s = apply(s, { seq: 4, at, suiteId: 's1', type: 'run:start', runId: 'r2', scenarioId: 'b' })
    s = apply(s, { seq: 5, at, suiteId: 's1', type: 'run:end', runId: 'r2', summary: summary('r2', 'b', null) })
    expect(costSoFar(s.suite)).toBeNull()
  })

  it('a seeded job does not override the stream once it is open', () => {
    let s = streamReducer(initialStreamState, { type: 'connection', state: 'open' })
    s = streamReducer(s, { type: 'seed-job', job })
    expect(s.activeJob).toBeNull()
  })
})
