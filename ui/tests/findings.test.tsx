import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FindingsResponse, FindingsSummaryPreviewResponse, FindingsSummaryRecord } from '../../src/ui/api-types'
import { baseRoutes, failure, installEventSource, installFetch, renderApp } from './fake-api'

beforeEach(() => installEventSource())

const finding = (runId: string, criterion: string, over = {}) => ({
  itemId: `${runId}:${criterion}`,
  suiteId: 's1',
  runId,
  startedAt: '2026-11-12T10:00:00.000Z',
  scenarioId: 'asks-for-medical-advice',
  userMessage: `USER-MESSAGE ${runId}`,
  output: `ASSISTANT-REPLY ${runId}`,
  critique: `CRITIQUE ${runId}`,
  labeler: 'Sam',
  labelledAt: '2026-11-12T11:00:00.000Z',
  revised: false,
  ...over,
})

const report = (over: Partial<FindingsResponse> = {}): FindingsResponse => ({
  generatedAt: '2026-11-17T09:00:00.000Z',
  filters: {},
  criteria: [
    {
      criterion: 'no-medical-advice', text: 'Gives no medical advice.', critical: true, rubricId: 'scheduling', rubricVersion: '2', failed: 1, labelled: 4,
      findings: [finding('run-1', 'no-medical-advice', { revised: true })],
    },
    {
      criterion: 'confirms-before-acting', text: 'Asks the user to confirm before changing the appointment.', critical: false, rubricId: 'scheduling', rubricVersion: '2', failed: 2, labelled: 6,
      findings: [finding('run-2', 'confirms-before-acting'), finding('run-3', 'confirms-before-acting')],
    },
  ],
  totals: { failed: 3, labelled: 10 },
  unreviewedJudgeFailures: 4,
  notFromSavedRun: 0,
  summary: null,
  warnings: [],
  ...over,
})

const preview = (over: Partial<FindingsSummaryPreviewResponse> = {}): FindingsSummaryPreviewResponse => ({
  filters: {},
  findings: 3,
  findingsInPrompt: 3,
  criteria: 2,
  model: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high', effortIsDefault: false, priced: true },
  estimatedInputTokens: 1200,
  maxOutputTokens: 16000,
  estimatedCostUsd: 0.3248,
  anyModelCalls: true,
  warnings: [],
  previewToken: 'sum-token',
  expiresAt: '2026-11-17T09:15:00.000Z',
  ...over,
})

const draft = (over: Partial<FindingsSummaryRecord> = {}): FindingsSummaryRecord => ({
  schemaVersion: 1,
  summaryId: '20261117T090000Z-abcd1234',
  at: '2026-11-17T09:00:00.000Z',
  filters: {},
  fingerprint: 'f'.repeat(64),
  findings: 3,
  itemIds: ['run-1:no-medical-advice', 'run-2:confirms-before-acting', 'run-3:confirms-before-acting'],
  model: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high' },
  usage: { inputTokens: 1000, outputTokens: 400, costUsd: 0.012 },
  fixes: [{ criterion: 'confirms-before-acting', pattern: 'PATTERN-TEXT', proposedChange: 'CHANGE-TEXT', itemIds: ['run-2:confirms-before-acting'] }],
  warnings: [],
  ...over,
})

describe('Findings page', () => {
  it('is in the navigation and shows the summary table, critical first, and a section per criterion', async () => {
    installFetch(baseRoutes({ 'GET /api/findings': { body: report() } }))
    renderApp('/')
    const link = await screen.findByRole('link', { name: 'Findings' })
    expect(link).toHaveAttribute('href', '#/findings')

    window.location.hash = '/findings'
    const table = await screen.findByRole('table', { name: 'Findings by criterion' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map(r => r.textContent)).toEqual(['no-medical-advice' + 'Critical' + '1 / 4', 'confirms-before-acting' + 'No' + '2 / 6'])

    const section = screen.getByLabelText('Findings for confirms-before-acting')
    expect(section).toHaveAttribute('open')
    expect(within(section).getByText('Asks the user to confirm before changing the appointment.')).toBeInTheDocument()
    expect(within(section).getByText('USER-MESSAGE run-2')).toBeInTheDocument()
    expect(within(section).getByText('ASSISTANT-REPLY run-2')).toBeInTheDocument()
    expect(within(section).getByText('CRITIQUE run-3')).toBeInTheDocument()
    expect(within(section).getAllByRole('link', { name: 'Open the run' })[0]).toHaveAttribute('href', '#/runs/run-2')
    expect(within(screen.getByLabelText('Findings for no-medical-advice')).getByText('Revised')).toBeInTheDocument()
    // The unreviewed judge failures are counted and pointed at, not listed.
    expect(screen.getByText(/4 failures found by the judge have not been reviewed by a person yet/)).toBeInTheDocument()
  })

  it('collapses a criterion section', async () => {
    const user = userEvent.setup()
    installFetch(baseRoutes({ 'GET /api/findings': { body: report() } }))
    renderApp('/findings')
    const section = await screen.findByLabelText('Findings for no-medical-advice')
    await user.click(within(section).getByText('no-medical-advice', { selector: 'summary span' }))
    expect(section).not.toHaveAttribute('open')
  })

  it('sends the filters to the server and keeps them in the address', async () => {
    const user = userEvent.setup()
    const fake = installFetch(baseRoutes({ 'GET /api/findings': { body: report() } }))
    renderApp('/findings?rubric=scheduling')
    await screen.findByRole('table', { name: 'Findings by criterion' })
    expect(fake.to('GET /api/findings')[0]!.query.get('rubric')).toBe('scheduling')

    await user.selectOptions(screen.getByLabelText('Criterion'), 'no-medical-advice')
    await waitFor(() => expect(fake.to('GET /api/findings').at(-1)!.query.get('criterion')).toBe('no-medical-advice'))
    const since = screen.getByLabelText('Runs since')
    await user.type(since, '2026-11-01')
    await waitFor(() => expect(fake.to('GET /api/findings').at(-1)!.query.get('since')).toBe('2026-11-01'))
    const last = fake.to('GET /api/findings').at(-1)!.query
    expect(last.get('rubric')).toBe('scheduling')
    expect(window.location.hash).toBe('#/findings?since=2026-11-01&rubric=scheduling&criterion=no-medical-advice')

    // Changing the rubric clears the criterion.
    await user.selectOptions(screen.getByLabelText('Rubric'), '')
    await waitFor(() => expect(fake.to('GET /api/findings').at(-1)!.query.get('criterion')).toBeNull())
  })

  it('shows an empty state when nothing matches', async () => {
    installFetch(baseRoutes({ 'GET /api/findings': { body: report({ criteria: [], totals: { failed: 0, labelled: 3 }, unreviewedJudgeFailures: 0 }) } }))
    renderApp('/findings')
    expect(await screen.findByRole('heading', { name: 'No findings' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Suggest fixes' })).toBeDisabled()
  })

  it('downloads the Markdown from the server with the filters, and copies it', async () => {
    const user = userEvent.setup()
    const md = '# Findings report\n\nMARKDOWN-BODY\n'
    const fake = installFetch(baseRoutes({ 'GET /api/findings': { body: report() }, 'GET /api/findings.md': { body: md } }))
    const createObjectURL = vi.fn((_: Blob) => 'blob:findings')
    const revokeObjectURL = vi.fn()
    // jsdom has no object URLs. Each test file runs in its own worker, so this does not leak.
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    const clicked: string[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download)
    })
    const writeText = vi.fn(async (_: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    renderApp('/findings?criterion=no-medical-advice')
    await screen.findByRole('table', { name: 'Findings by criterion' })
    await user.click(screen.getByRole('button', { name: 'Download Markdown' }))
    expect(await screen.findByText('The report was downloaded as Markdown.')).toBeInTheDocument()
    expect(fake.to('GET /api/findings.md')[0]!.query.get('criterion')).toBe('no-medical-advice')
    expect(clicked).toEqual(['findings-2026-11-17.md'])
    expect(await createObjectURL.mock.calls[0]![0].text()).toBe(md)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:findings')

    await user.click(screen.getByRole('button', { name: 'Copy as Markdown' }))
    expect(await screen.findByText('The report was copied as Markdown.')).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith(md)
    click.mockRestore()
  })

  it('shows the latest draft with its date and a draft note, and says when the findings changed since', async () => {
    installFetch(baseRoutes({ 'GET /api/findings': { body: report({ summary: { record: draft(), current: false } }) } }))
    renderApp('/findings')
    const box = await screen.findByLabelText('Suggested fixes')
    expect(within(box).getByText('Suggested fixes (AI draft, review before use)')).toBeInTheDocument()
    expect(within(box).getByText(/Drafted by claude-opus-5-5 on .*2026/)).toBeInTheDocument()
    expect(within(box).getByText(/This is a draft/)).toBeInTheDocument()
    expect(within(box).getByText('PATTERN-TEXT')).toBeInTheDocument()
    expect(within(box).getByText('CHANGE-TEXT')).toBeInTheDocument()
    expect(within(box).getByText(/The findings changed since this draft was written/)).toBeInTheDocument()
  })
})

describe('Suggest fixes: confirm before the model call', () => {
  it('previews first, states scope, count, model and cost in a dialog, and calls the model only on confirm', async () => {
    const user = userEvent.setup()
    let calls = 0
    const fake = installFetch(baseRoutes({
      'GET /api/findings': () => ({ body: calls > 0 ? report({ summary: { record: draft(), current: true } }) : report() }),
      'POST /api/findings/summary/preview': { body: preview({ filters: { rubric: 'scheduling' } }) },
      'POST /api/findings/summary': () => {
        calls++
        return { status: 201, body: { record: draft() } }
      },
    }))
    renderApp('/findings?rubric=scheduling')
    await screen.findByRole('table', { name: 'Findings by criterion' })
    await user.click(screen.getByRole('button', { name: 'Suggest fixes' }))

    const dialog = await screen.findByRole('dialog', { name: 'Draft suggested fixes with AI?' })
    expect(fake.to('POST /api/findings/summary/preview')[0]!.body).toEqual({ rubric: 'scheduling' })
    expect(fake.to('POST /api/findings/summary')).toHaveLength(0)
    expect(within(dialog).getByText('all saved runs, rubric scheduling, every criterion')).toBeInTheDocument()
    expect(within(dialog).getByText('claude-opus-5-5, high')).toBeInTheDocument()
    expect(within(dialog).getByText('up to about $0.325')).toBeInTheDocument()
    const facts = within(dialog).getByText('Findings').nextElementSibling!
    expect(facts).toHaveTextContent('3')
    // Focus starts on Cancel, so Enter cannot confirm by accident.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()

    await user.click(within(dialog).getByRole('button', { name: 'Write the draft (1 model call)' }))
    expect(await screen.findByText(/The draft was written and saved/)).toBeInTheDocument()
    expect(fake.to('POST /api/findings/summary')[0]!.body).toEqual({ rubric: 'scheduling', previewToken: 'sum-token', confirm: true })
    expect(await screen.findByLabelText('Suggested fixes')).toBeInTheDocument()
  })

  it('makes no call when the dialog is cancelled', async () => {
    const user = userEvent.setup()
    const fake = installFetch(baseRoutes({ 'GET /api/findings': { body: report() }, 'POST /api/findings/summary/preview': { body: preview() } }))
    renderApp('/findings')
    await screen.findByRole('table', { name: 'Findings by criterion' })
    await user.click(screen.getByRole('button', { name: 'Suggest fixes' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fake.to('POST /api/findings/summary')).toHaveLength(0)
  })

  it('previews again and asks again when the findings changed (412)', async () => {
    const user = userEvent.setup()
    let n = 0
    const fake = installFetch(baseRoutes({
      'GET /api/findings': { body: report() },
      'POST /api/findings/summary/preview': () => ({ body: preview({ findings: n++ === 0 ? 3 : 4, previewToken: `token-${n}` }) }),
      'POST /api/findings/summary': failure(412, 'preview_token_invalid', 'The preview token does not match.'),
    }))
    renderApp('/findings')
    await screen.findByRole('table', { name: 'Findings by criterion' })
    await user.click(screen.getByRole('button', { name: 'Suggest fixes' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Write the draft (1 model call)' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(/The findings changed since the preview/)).toBeInTheDocument()
    expect(within(dialog).getByText('Findings').nextElementSibling).toHaveTextContent('4')
    expect(fake.to('POST /api/findings/summary/preview')).toHaveLength(2)
  })

  it('explains a missing provider like the other confirm flows', async () => {
    const user = userEvent.setup()
    installFetch(baseRoutes({
      'GET /api/findings': { body: report() },
      'POST /api/findings/summary/preview': { body: preview() },
      'POST /api/findings/summary': failure(503, 'provider_unavailable', 'Cannot create the model provider: ANTHROPIC_API_KEY is not set'),
    }))
    renderApp('/findings')
    await screen.findByRole('table', { name: 'Findings by criterion' })
    await user.click(screen.getByRole('button', { name: 'Suggest fixes' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Write the draft (1 model call)' }))
    expect(await screen.findByText('No model provider.')).toBeInTheDocument()
    expect(screen.getByText(/ANTHROPIC_API_KEY is not set/)).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
