import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { baseRoutes, failure, installEventSource, installFetch, renderApp } from './fake-api'
import { health, overview } from './fixtures'

beforeEach(() => installEventSource())

describe('first load and the token', () => {
  it('shows the open-the-link screen when the server answers 401', async () => {
    installFetch({ 'GET /api/health': failure(401, 'unauthorized', 'A valid access token is required.') })
    renderApp('/')
    expect(await screen.findByRole('heading', { name: 'Open the link from your terminal' })).toBeInTheDocument()
    expect(screen.getByText(/\?token=/)).toBeInTheDocument()
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('shows a clear error screen with a retry when the server is down', async () => {
    const user = userEvent.setup()
    const fake = installFetch({})
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    renderApp('/')
    expect(await screen.findByRole('heading', { name: 'Cannot reach the evals server' })).toBeInTheDocument()
    expect(screen.getByText(/npx evals ui/)).toBeInTheDocument()

    // Back up: Try again loads the app.
    installFetch(baseRoutes())
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeInTheDocument()
    expect(fake.calls.length).toBe(0)
  })

  it('removes ?token= from the address bar if it is ever there, and never stores it', async () => {
    installFetch(baseRoutes())
    window.history.replaceState(null, '', '/?token=SECRET-TOKEN-VALUE')
    renderApp('/')
    await screen.findByRole('navigation', { name: 'Main' })
    expect(window.location.search).toBe('')
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('SECRET-TOKEN-VALUE')
  })

  it('sends only relative URLs, so Host and Origin are always the server', async () => {
    const fake = installFetch(baseRoutes())
    renderApp('/')
    await screen.findByRole('navigation', { name: 'Main' })
    expect(fake.calls.length).toBeGreaterThan(0)
    const fetchMock = vi.mocked(fetch)
    for (const [input] of fetchMock.mock.calls) expect(String(input)).toMatch(/^\/api\//)
  })
})

describe('shell', () => {
  it('shows a Demo data banner when the server says it is demo data', async () => {
    installFetch(baseRoutes({ 'GET /api/health': { body: health({ demo: true }) } }))
    renderApp('/')
    expect(await screen.findByText('Demo data.')).toBeInTheDocument()
    expect(screen.getByText(/synthetic/)).toBeInTheDocument()
  })

  it('shows no demo banner on real data', async () => {
    installFetch(baseRoutes())
    renderApp('/')
    await screen.findByRole('navigation', { name: 'Main' })
    expect(screen.queryByText('Demo data.')).toBeNull()
  })

  it('toggles the theme, saves it, and survives storage that throws', async () => {
    const user = userEvent.setup()
    installFetch(baseRoutes())
    renderApp('/')
    await user.click(await screen.findByRole('button', { name: 'Switch to light theme' }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(window.localStorage.getItem('evals-ui-theme')).toBe('light')

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    await user.click(screen.getByRole('button', { name: 'Switch to dark theme' }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('shows a reconnecting notice when the event stream drops', async () => {
    const { FakeEventSource } = await import('./fake-api')
    installFetch(baseRoutes())
    renderApp('/')
    await screen.findByRole('navigation', { name: 'Main' })
    FakeEventSource.last.open()
    FakeEventSource.last.drop()
    expect(await screen.findByText(/Lost contact with the server/)).toBeInTheDocument()
    FakeEventSource.last.open()
    await waitFor(() => expect(screen.queryByText(/Lost contact with the server/)).toBeNull())
  })
})

describe('overview', () => {
  it('leads with the goal-achieved rate, then pass rate, runs and cost', async () => {
    installFetch(baseRoutes())
    renderApp('/')
    const tiles = await screen.findByLabelText('Headline numbers')
    const labels = within(tiles).getAllByText(/^(Goal achieved|Pass rate|Runs|Total cost)$/).map(e => e.textContent)
    expect(labels).toEqual(['Goal achieved', 'Pass rate', 'Runs', 'Total cost'])
    expect(within(tiles).getByText('60%')).toBeInTheDocument()
    expect(within(tiles).getByText('$1.23')).toBeInTheDocument()
    expect(screen.getByText(/6 of 10 runs with a goal check/)).toBeInTheDocument()
  })

  it('shows an unknown cost, never zero, when any run has no price', async () => {
    installFetch(baseRoutes({
      'GET /api/overview': {
        body: overview({ cost: { totalUsd: null, knownUsd: 0.5, runsWithUnknownCost: 2, inputTokens: 1, outputTokens: 1 }, goal: { achieved: 0, total: 0, rate: null } }),
      },
    }))
    renderApp('/')
    const tiles = await screen.findByLabelText('Headline numbers')
    expect(within(tiles).getByText('Unknown')).toBeInTheDocument()
    expect(within(tiles).queryByText('$0.00')).toBeNull()
    expect(within(tiles).getByText(/2 runs had no price/)).toBeInTheDocument()
    expect(within(tiles).getByText('n/a')).toBeInTheDocument()
  })

  it('draws the trend, the tag failures and the failing criteria from the data', async () => {
    installFetch(baseRoutes())
    renderApp('/')
    expect(await screen.findByRole('img', { name: /Trend across 3 suites/ })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /safety: 2 pass, 3 fail, 0 error/ })).toBeInTheDocument()
    expect(screen.getByText('confirms-before-acting')).toBeInTheDocument()
    expect(screen.getByText('failed 3 of 9 (33%)')).toBeInTheDocument()
    expect(screen.getByText('must_not_call(cancel_appointment)')).toBeInTheDocument()
  })

  it('shows the exact commands to start when there are no runs', async () => {
    installFetch(baseRoutes({
      'GET /api/overview': { body: overview({ runs: 0, suites: { considered: 0, total: 0 }, counts: { pass: 0, fail: 0, error: 0 }, trend: [], failuresByTag: [], topFailingCriteria: [], topFailingChecks: [], goal: { achieved: 0, total: 0, rate: null } }) },
    }))
    renderApp('/')
    expect(await screen.findByRole('heading', { name: 'No runs yet' })).toBeInTheDocument()
    expect(screen.getByText(/npx evals run \.\/scenarios/)).toBeInTheDocument()
    expect(screen.getByText(/npx evals validate \.\/scenarios/)).toBeInTheDocument()
  })

  it('shows an error state with a retry when the overview fails', async () => {
    installFetch(baseRoutes({ 'GET /api/overview': failure(500, 'internal', 'Something broke.') }))
    renderApp('/')
    expect(await screen.findByText(/Something broke\./)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('lists skipped files as warnings', async () => {
    installFetch(baseRoutes({ 'GET /api/overview': { body: overview({ warnings: ['runs/bad.json: not valid JSON'] }) } }))
    renderApp('/')
    expect(await screen.findByText('runs/bad.json: not valid JSON')).toBeInTheDocument()
  })
})
