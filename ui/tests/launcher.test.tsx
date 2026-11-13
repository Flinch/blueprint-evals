import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ActiveJob, RunStreamEvent } from '../../src/ui/api-types'
import { baseRoutes, failure, FakeEventSource, installEventSource, installFetch, renderApp } from './fake-api'
import { grader, health, preview, previewResponse } from './fixtures'

beforeEach(() => installEventSource())

const startedAt = '2026-11-12T10:00:00.000Z'
const IDS = ['reschedule-tomorrow-3pm', 'asks-for-medical-advice']
const ALL = [...IDS, 'reschedule-asks-before-acting']

async function chooseAll(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Select all' }))
}

describe('run launcher: preview and confirmation', () => {
  it('cannot start without a preview, and sends the preview token only after the dialog is confirmed', async () => {
    const user = userEvent.setup()
    const fake = installFetch(baseRoutes({
      'POST /api/run/preview': { body: previewResponse() },
      'POST /api/run/start': { status: 202, body: { suiteId: 's-new', startedAt, preview: preview() } },
    }))
    renderApp('/launch')
    await chooseAll(user)

    // No start button before the preview, and nothing was posted.
    expect(screen.queryByRole('button', { name: /Review and start/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Start/ })).toBeNull()
    expect(fake.to('POST /api/run/start')).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: /Preview the cost/ }))
    await screen.findByRole('region', { name: 'Cost preview' })
    expect(fake.to('POST /api/run/start')).toHaveLength(0)

    // Opening the confirmation still starts nothing.
    await user.click(screen.getByRole('button', { name: 'Review and start' }))
    const dialog = await screen.findByRole('dialog')
    expect(fake.to('POST /api/run/start')).toHaveLength(0)
    // It states the scope and the number of model calls.
    expect(within(dialog).getByText(/2 scenarios, with up to 13 model calls\./)).toBeInTheDocument()
    expect(within(dialog).getByText(/can spend money/)).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: /Start \(up to 13 model calls\)/ }))
    await waitFor(() => expect(fake.to('POST /api/run/start')).toHaveLength(1))
    expect(fake.to('POST /api/run/start')[0]!.body).toEqual({ only: ALL, previewToken: 'token-abc', confirm: true })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('focuses Cancel in the dialog, so Enter cannot confirm by accident, and Escape closes it without starting', async () => {
    const user = userEvent.setup()
    const fake = installFetch(baseRoutes({ 'POST /api/run/preview': { body: previewResponse() } }))
    renderApp('/launch')
    await chooseAll(user)
    await user.click(screen.getByRole('button', { name: /Preview the cost/ }))
    await user.click(await screen.findByRole('button', { name: 'Review and start' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(fake.to('POST /api/run/start')).toHaveLength(0)
  })

  it('shows the same numbers as the CLI: counts, models, cap, worst case and every warning', async () => {
    const user = userEvent.setup()
    installFetch(baseRoutes({ 'POST /api/run/preview': { body: previewResponse() } }))
    renderApp('/launch')
    await chooseAll(user)
    await user.click(screen.getByRole('button', { name: /Preview the cost/ }))
    const panel = await screen.findByRole('region', { name: 'Cost preview' })
    expect(within(panel).getByText('13')).toBeInTheDocument()
    expect(within(panel).getAllByText('anthropic/claude-opus-5-5')).toHaveLength(2)
    expect(within(panel).getByText('$0.500')).toBeInTheDocument()
    expect(within(panel).getByText('$1.00')).toBeInTheDocument()
    expect(within(panel).getByText('config budget.maxCostUsd')).toBeInTheDocument()
    expect(within(panel).getByText('Judge model has no price in the config, so its cost is unknown.')).toBeInTheDocument()
    expect(within(panel).getByText(/AGENT_TOKEN is not set/)).toBeInTheDocument()
    expect(within(panel).getByLabelText('Command line preview text')).toHaveTextContent('2 scenarios, 13 model calls at most')
  })

  it('sends the optional per-scenario cap and rejects a bad one', async () => {
    const user = userEvent.setup()
    const fake = installFetch(baseRoutes({ 'POST /api/run/preview': { body: previewResponse() } }))
    renderApp('/launch')
    await chooseAll(user)
    await user.type(screen.getByLabelText(/Cost cap per scenario/), '-3')
    expect(screen.getByText('Enter a number above zero, or leave it empty.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Preview the cost/ })).toBeDisabled()
    await user.clear(screen.getByLabelText(/Cost cap per scenario/))
    await user.type(screen.getByLabelText(/Cost cap per scenario/), '0.25')
    await user.click(screen.getByRole('button', { name: /Preview the cost/ }))
    await screen.findByRole('region', { name: 'Cost preview' })
    expect(fake.to('POST /api/run/preview')[0]!.body).toEqual({ only: ALL, maxCostUsd: 0.25 })
  })

  it('drops a preview when the selection changes, so a token is never reused for another plan', async () => {
    const user = userEvent.setup()
    installFetch(baseRoutes({ 'POST /api/run/preview': { body: previewResponse() } }))
    renderApp('/launch')
    await chooseAll(user)
    await user.click(screen.getByRole('button', { name: /Preview the cost/ }))
    await screen.findByRole('region', { name: 'Cost preview' })
    await user.click(screen.getByRole('checkbox', { name: /asks-for-medical-advice/ }))
    expect(screen.queryByRole('region', { name: 'Cost preview' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Review and start' })).toBeNull()
  })

  it('selects by tag', async () => {
    const user = userEvent.setup()
    installFetch(baseRoutes())
    renderApp('/launch')
    await user.click(await screen.findByRole('button', { name: 'safety' }))
    expect(screen.getByRole('checkbox', { name: /asks-for-medical-advice/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /reschedule-tomorrow-3pm/ })).not.toBeChecked()
    expect(screen.getByText('1 of 3 selected')).toBeInTheDocument()
  })

  it('on 412, previews again and says what changed, and does not start', async () => {
    const user = userEvent.setup()
    let previews = 0
    const fake = installFetch(baseRoutes({
      'POST /api/run/preview': () => {
        previews++
        return previews === 1
          ? { body: previewResponse() }
          : { body: previewResponse({ previewToken: 'token-new', preview: preview({ calls: { simulator: 12, rubric: 2, goal: 2, judge: 4, total: 16 } }) }) }
      },
      'POST /api/run/start': failure(412, 'preview_token_invalid', 'The plan changed.'),
    }))
    renderApp('/launch')
    await chooseAll(user)
    await user.click(screen.getByRole('button', { name: /Preview the cost/ }))
    await user.click(await screen.findByRole('button', { name: 'Review and start' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^Start/ }))
    expect(await screen.findByText(/Model calls \(at most\) went from 13 to 16\./)).toBeInTheDocument()
    expect(screen.getByText(/The plan changed since you previewed it/)).toBeInTheDocument()
    expect(fake.to('POST /api/run/start')).toHaveLength(1)
    // The new token is used only after another explicit confirmation.
    await user.click(screen.getByRole('button', { name: 'Review and start' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /Start \(up to 16 model calls\)/ }))
    await waitFor(() => expect(fake.to('POST /api/run/start')).toHaveLength(2))
    expect(fake.to('POST /api/run/start')[1]!.body).toMatchObject({ previewToken: 'token-new', confirm: true })
  })

  it('on 409, shows the active run and keeps start off', async () => {
    const user = userEvent.setup()
    const job: ActiveJob = { kind: 'run', startedAt, suiteId: 's-busy', scenarioIds: ['a', 'b', 'c'], finished: 1, cancelling: false }
    installFetch(baseRoutes({
      'POST /api/run/preview': { body: previewResponse() },
      'POST /api/run/start': failure(409, 'run_in_progress', 'A run is already going.', { activeJob: job }),
    }))
    renderApp('/launch')
    await chooseAll(user)
    await user.click(screen.getByRole('button', { name: /Preview the cost/ }))
    await user.click(await screen.findByRole('button', { name: 'Review and start' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^Start/ }))
    expect(await screen.findByText('A job is already running.')).toBeInTheDocument()
    expect(screen.getByText(/A run of 3 scenarios is active \(1 finished, suite s-busy\)/)).toBeInTheDocument()
  })

  it('lists plan_invalid problems from the server', async () => {
    const user = userEvent.setup()
    installFetch(baseRoutes({ 'POST /api/run/preview': failure(422, 'plan_invalid', 'Cannot run.', { errors: ['Scenario "x" uses the target "nope".'] }) }))
    renderApp('/launch')
    await chooseAll(user)
    await user.click(screen.getByRole('button', { name: /Preview the cost/ }))
    expect(await screen.findByText('These scenarios cannot run.')).toBeInTheDocument()
    expect(screen.getByText('Scenario "x" uses the target "nope".')).toBeInTheDocument()
  })

  it('offers no run when the server has no config', async () => {
    const user = userEvent.setup()
    installFetch(baseRoutes({ 'GET /api/health': { body: health({ configFile: null }) } }))
    renderApp('/launch')
    expect(await screen.findByText('No config file.')).toBeInTheDocument()
    await chooseAll(user)
    expect(screen.getByRole('button', { name: /Preview the cost/ })).toBeDisabled()
  })

  it('disables the controls while a job is active, taking it from the health response', async () => {
    const job: ActiveJob = { kind: 'run', startedAt, suiteId: 's-busy', scenarioIds: ['a', 'b'], finished: 0, cancelling: false }
    installFetch(baseRoutes({ 'GET /api/health': { body: health({ activeJob: job }) } }))
    renderApp('/launch')
    expect(await screen.findByText('A run is active.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Select all' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Preview the cost/ })).toBeDisabled()
  })

  it('a plan with no model calls says it costs nothing', async () => {
    const user = userEvent.setup()
    installFetch(baseRoutes({
      'POST /api/run/preview': {
        body: previewResponse({
          preview: preview({ scenarios: { selected: 1, withModel: 0, deterministicOnly: 1, ids: ['reschedule-asks-before-acting'] }, calls: { simulator: 0, rubric: 0, goal: 0, judge: 0, total: 0 }, cap: null, warnings: [], anyModelCalls: false }),
          warnings: [],
        }),
      },
    }))
    renderApp('/launch')
    await user.click(await screen.findByRole('checkbox', { name: /reschedule-asks-before-acting/ }))
    await user.click(screen.getByRole('button', { name: /Preview the cost/ }))
    expect(await screen.findByText(/makes no model calls, so it costs nothing/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Review and start' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/No model is called, so this costs nothing/)).toBeInTheDocument()
  })
})

// --------------------------------------------------------------- live progress

const base = { at: startedAt, suiteId: 's-live' }
let seq = 0
const ev = <T extends RunStreamEvent['type']>(type: T, rest: Omit<Extract<RunStreamEvent, { type: T }>, 'seq' | 'at' | 'suiteId' | 'type'>) =>
  ({ ...base, seq: ++seq, type, ...rest }) as Extract<RunStreamEvent, { type: T }>

function send(type: RunStreamEvent['type'], e: RunStreamEvent) {
  act(() => FakeEventSource.last.emit(type, e))
}

describe('run launcher: live progress', () => {
  beforeEach(() => {
    seq = 0
  })

  async function openWithStream() {
    const fake = installFetch(baseRoutes({ 'POST /api/run/cancel': { status: 202, body: { suiteId: 's-live', cancelling: true } } }))
    renderApp('/launch')
    await screen.findByRole('button', { name: 'Select all' })
    act(() => {
      FakeEventSource.last.open()
      FakeEventSource.last.emit('hello', { type: 'hello', activeJob: null })
    })
    return fake
  }

  it('updates per scenario as events arrive: turns, graders, cost, then the end', async () => {
    const user = userEvent.setup()
    await openWithStream()
    const job: ActiveJob = { kind: 'run', startedAt, suiteId: 's-live', scenarioIds: IDS, finished: 0, cancelling: false }
    act(() => FakeEventSource.last.emit('hello', { type: 'hello', activeJob: job }))
    send('suite:start', ev('suite:start', { startedAt, scenarioIds: IDS, preview: preview() }))

    const progress = await screen.findByRole('region', { name: 'Run progress' })
    expect(within(progress).getByText('0 of 2')).toBeInTheDocument()
    expect(within(progress).getAllByText('Queued')).toHaveLength(2)

    send('run:start', ev('run:start', { runId: 'live-1', scenarioId: IDS[0]! }))
    expect(within(progress).getByText('Running')).toBeInTheDocument()

    send('turn', ev('turn', { runId: 'live-1', turn: { index: 0, role: 'user', content: 'Hi, can you move my appointment?', at: startedAt } }))
    send('turn', ev('turn', { runId: 'live-1', turn: { index: 1, role: 'assistant', content: 'I can move it to 15:00. Shall I go ahead?', at: startedAt } }))
    expect(within(progress).getByText('2 turns')).toBeInTheDocument()
    await user.click(within(progress).getByRole('button', { name: 'Show live view' }))
    expect(within(progress).getByText('I can move it to 15:00. Shall I go ahead?')).toBeInTheDocument()

    send('grader:done', ev('grader:done', { runId: 'live-1', result: grader({ grader: 'must_not_call(cancel_appointment)', status: 'pass', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 } }) }))
    expect(within(progress).getByText('must_not_call(cancel_appointment)')).toBeInTheDocument()
    expect(within(progress).getByText('$0.010', { selector: '.stat-num' })).toBeInTheDocument()

    send('run:end', ev('run:end', { runId: 'live-1', summary: { runId: 'live-1', scenarioId: IDS[0]!, scenarioVersion: '1', status: 'pass', score: 1, goalAchieved: true, costUsd: 0.2, durationMs: 3000, turns: 2, failedCriteria: [], warnings: 0 } }))
    expect(within(progress).getByText('1 of 2')).toBeInTheDocument()
    expect(within(progress).getByText('$0.200', { selector: '.stat-num' })).toBeInTheDocument()
    expect(within(progress).getByRole('link', { name: 'Open run' })).toHaveAttribute('href', '#/runs/live-1')

    send('suite:end', ev('suite:end', { state: 'complete', summary: { runs: 2, pass: 1, fail: 1, error: 0, goal: { achieved: 1, total: 2 }, avgScore: 0.5, costUsd: 0.4, durationMs: 9000, scenarios: IDS }, warnings: [] }))
    expect(await within(progress).findByText('Run complete.', { selector: 'strong' })).toBeInTheDocument()
    expect(within(progress).queryByRole('button', { name: 'Cancel run' })).toBeNull()
  })

  it('shows an unknown running cost, never zero, when a run has no price', async () => {
    await openWithStream()
    send('suite:start', ev('suite:start', { startedAt, scenarioIds: [IDS[0]!], preview: preview() }))
    send('run:start', ev('run:start', { runId: 'live-1', scenarioId: IDS[0]! }))
    send('run:end', ev('run:end', { runId: 'live-1', summary: { runId: 'live-1', scenarioId: IDS[0]!, scenarioVersion: '1', status: 'pass', score: 1, goalAchieved: true, costUsd: null, durationMs: 10, turns: 2, failedCriteria: [], warnings: 0 } }))
    const progress = await screen.findByRole('region', { name: 'Run progress' })
    expect(within(progress).getByText('Cost so far').previousElementSibling).toHaveTextContent('Unknown')
  })

  it('ignores replayed events after a reconnect', async () => {
    await openWithStream()
    const start = ev('suite:start', { startedAt, scenarioIds: [IDS[0]!], preview: preview() })
    const rs = ev('run:start', { runId: 'live-1', scenarioId: IDS[0]! })
    const turn = ev('turn', { runId: 'live-1', turn: { index: 0, role: 'user', content: 'once', at: startedAt } })
    for (const e of [start, rs, turn]) send(e.type, e)
    act(() => FakeEventSource.last.drop())
    act(() => FakeEventSource.last.open())
    for (const e of [start, rs, turn]) send(e.type, e) // the server replays its buffer
    const progress = await screen.findByRole('region', { name: 'Run progress' })
    expect(within(progress).getByText('1 turn')).toBeInTheDocument()
  })

  it('shows a reconnecting banner in the progress panel and reopens the stream when the browser gives up', async () => {
    await openWithStream()
    send('suite:start', ev('suite:start', { startedAt, scenarioIds: [IDS[0]!], preview: preview() }))
    const before = FakeEventSource.instances.length
    act(() => FakeEventSource.last.drop(true))
    const progress = await screen.findByRole('region', { name: 'Run progress' })
    expect(within(progress).getByText(/Reconnecting to the server/)).toBeInTheDocument()
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(before + 1), { timeout: 5000 })
  })

  it('cancels through the API and shows the cancelling state', async () => {
    const user = userEvent.setup()
    const fake = await openWithStream()
    const job: ActiveJob = { kind: 'run', startedAt, suiteId: 's-live', scenarioIds: IDS, finished: 0, cancelling: false }
    act(() => FakeEventSource.last.emit('hello', { type: 'hello', activeJob: job }))
    send('suite:start', ev('suite:start', { startedAt, scenarioIds: IDS, preview: preview() }))
    await user.click(await screen.findByRole('button', { name: 'Cancel run' }))
    await waitFor(() => expect(fake.to('POST /api/run/cancel')).toHaveLength(1))
    expect(await screen.findByRole('button', { name: 'Cancelling' })).toBeDisabled()
    send('suite:end', ev('suite:end', { state: 'cancelled', summary: { runs: 0, pass: 0, fail: 0, error: 0, goal: { achieved: 0, total: 0 }, avgScore: null, costUsd: 0, durationMs: 0, scenarios: [] }, warnings: [] }))
    expect(await screen.findByText('Run cancelled.', { selector: 'strong' })).toBeInTheDocument()
  })

  it('announces progress to screen readers through a polite live region', async () => {
    await openWithStream()
    send('suite:start', ev('suite:start', { startedAt, scenarioIds: IDS, preview: preview() }))
    const progress = await screen.findByRole('region', { name: 'Run progress' })
    const live = within(progress).getAllByRole('status').find(el => el.getAttribute('aria-live') === 'polite' && el.classList.contains('sr-only'))!
    expect(live).toHaveTextContent('Run started with 2 scenarios.')
    send('run:start', ev('run:start', { runId: 'live-1', scenarioId: IDS[0]! }))
    expect(live).toHaveTextContent(`Running ${IDS[0]}.`)
  })

  it('shows a failure from the run machinery', async () => {
    await openWithStream()
    send('suite:start', ev('suite:start', { startedAt, scenarioIds: [IDS[0]!], preview: preview() }))
    send('error', ev('error', { code: 'run_failed', message: 'The disk is full.' }))
    expect(await screen.findByText('The run failed.')).toBeInTheDocument()
    expect(screen.getByText('The disk is full.')).toBeInTheDocument()
  })
})
