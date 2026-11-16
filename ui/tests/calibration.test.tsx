import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CalibratePreviewResponse } from '../../src/ui/api-types'
import { baseRoutes, failure, installEventSource, installFetch, renderApp } from './fake-api'
import { calibrationRecord, preview, report } from './fixtures'

beforeEach(() => installEventSource())

const calPreview = (over: Partial<CalibratePreviewResponse> = {}): CalibratePreviewResponse => ({
  preview: preview({
    kind: 'calibrate',
    scenarios: undefined,
    judgements: { count: 9, split: 'dev', selection: 'random' },
    calls: { simulator: 0, rubric: 0, goal: 0, judge: 9, total: 9 },
    models: { judge: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high', effortIsDefault: false, priced: true } },
    cap: null,
    warnings: [],
  }),
  lines: ['Calibration preview', '  9 judge calls'],
  warnings: [],
  contamination: null,
  labelsFile: '/work/demo/.evals/labels.jsonl',
  previewToken: 'cal-token',
  expiresAt: '2026-11-12T10:00:00.000Z',
  ...over,
})

describe('calibration report', () => {
  it('says how many labels were changed after seeing the judge, with the agreement on the blind labels', async () => {
    const r = report()
    const blindMetrics = { ...r.metrics, accuracy: 0.78, tnr: { ...r.metrics.tnr, rate: 0.6 }, tpr: { ...r.metrics.tpr, rate: 0.9 } }
    installFetch(baseRoutes({ 'GET /api/calibration': { body: { latest: calibrationRecord({ report: report({ revisions: { revised: 3, verdictChanged: 3, blindMetrics } }) }) } } }))
    renderApp('/calibration')
    const note = await screen.findByTestId('revision-note')
    expect(note).toHaveTextContent('3 of these labels were changed after seeing the judge. Agreement on your original, blind labels: 78%, against 81% with the changes.')
    expect(screen.getByLabelText('Labels changed after seeing the judge')).toHaveTextContent(/true negative rate is 60%/)
  })

  it('shows no revision note when no label was changed, or for a report saved before revisions existed', async () => {
    installFetch(baseRoutes({ 'GET /api/calibration': { body: { latest: calibrationRecord({ report: report({ revisions: { revised: 0, verdictChanged: 0, blindMetrics: null } }) }) } } }))
    const first = renderApp('/calibration')
    await screen.findByLabelText('True negative rate')
    expect(screen.queryByTestId('revision-note')).toBeNull()
    first.unmount()
    installEventSource()
    installFetch(baseRoutes())
    renderApp('/calibration')
    await screen.findByLabelText('True negative rate')
    expect(screen.queryByTestId('revision-note')).toBeNull()
  })

  it('shows the true negative rate before the true positive rate, and it is the most prominent', async () => {
    installFetch(baseRoutes())
    renderApp('/calibration')
    const tnr = await screen.findByLabelText('True negative rate')
    const tpr = screen.getByLabelText('True positive rate')
    expect(tnr.compareDocumentPosition(tpr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(tnr).toHaveClass('primary')
    expect(tpr).not.toHaveClass('primary')
    expect(within(tnr).getByTestId('tnr-value')).toHaveTextContent('71%')
    expect(within(tpr).getByTestId('tpr-value')).toHaveTextContent('89%')
    // n per class and the interval for each.
    expect(within(tnr).getByText(/5 of 7/)).toBeInTheDocument()
    expect(within(tnr).getByText('36% to 92%')).toBeInTheDocument()
    expect(within(tnr).getByText('n = 7 expert-fail labels')).toBeInTheDocument()
    expect(within(tpr).getByText('n = 9 expert-pass labels')).toBeInTheDocument()
    expect(within(tnr).getByRole('img', { name: /True negative rate: 71%, 95 percent interval 36% to 92%/ })).toBeInTheDocument()
  })

  it('shows the insufficient-sample warnings prominently, above the rates', async () => {
    installFetch(baseRoutes())
    renderApp('/calibration')
    const alert = await screen.findByText('Insufficient sample. Do not rely on these numbers.')
    expect(alert.closest('[role="alert"]')).not.toBeNull()
    const tnr = screen.getByLabelText('True negative rate')
    expect(alert.compareDocumentPosition(tnr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getAllByText('Only 7 expert-fail labels (under 30), so the true negative rate is not reliable.').length).toBeGreaterThan(0)
    expect(screen.getByText('Warnings from this measurement')).toBeInTheDocument()
    expect(screen.getByText('2 targeted dev label(s) were left out.')).toBeInTheDocument()
  })

  it('says the sample is adequate when it is', async () => {
    const r = report({ metrics: { ...report().metrics, insufficient: false, warnings: [] }, warnings: [] })
    installFetch(baseRoutes({ 'GET /api/calibration': { body: { latest: calibrationRecord({ report: r }) } } }))
    renderApp('/calibration')
    expect(await screen.findByText(/sample size is adequate/)).toBeInTheDocument()
    expect(screen.queryByText('Insufficient sample. Do not rely on these numbers.')).toBeNull()
  })

  it('shows the confusion matrix, prevalence next to accuracy, and kappa', async () => {
    installFetch(baseRoutes())
    renderApp('/calibration')
    const matrix = await screen.findByLabelText('Confusion matrix')
    expect(within(matrix).getByText('Judge: pass')).toBeInTheDocument()
    expect(within(matrix).getByText('judge passed it').previousElementSibling).toHaveTextContent('2') // fp
    const prev = screen.getByLabelText('Prevalence and accuracy')
    expect(within(prev).getByText('56% expert-pass')).toBeInTheDocument()
    expect(within(prev).getByText('81%')).toBeInTheDocument()
    expect(within(prev).getByText('0.61')).toBeInTheDocument()
  })

  it('lists disagreements with the expert critique next to the judge critique', async () => {
    installFetch(baseRoutes())
    renderApp('/calibration')
    const section = await screen.findByLabelText('Disagreements')
    const first = within(section).getByText('run-a:confirms-before-acting').closest('article')!
    expect(within(first).getByText('EXPERT-NOTE: it acted at once.')).toBeInTheDocument()
    expect(within(first).getByText('JUDGE-NOTE: it seemed to ask.')).toBeInTheDocument()
    expect(within(first).getByText('Judge passed a failure')).toBeInTheDocument()
    const second = within(section).getByText('run-b:no-medical-advice').closest('article')!
    expect(within(second).getByText('The judge gave no critique.')).toBeInTheDocument()
    expect(within(second).queryByText('Judge passed a failure')).toBeNull()
  })

  it('lists items that could not be judged, and an unknown spend as unknown', async () => {
    installFetch(baseRoutes())
    renderApp('/calibration')
    const section = await screen.findByLabelText('Items that could not be judged')
    expect(within(section).getByText('Judge call failed: timeout')).toBeInTheDocument()
    expect(screen.getByText(/Judge spend: Unknown/)).toBeInTheDocument()
  })

  it('has a collapsible "How to read this" in plain language', async () => {
    const user = userEvent.setup()
    installFetch(baseRoutes())
    renderApp('/calibration')
    const summary = await screen.findByText('How to read this')
    const details = summary.closest('details')!
    expect(details.open).toBe(false)
    await user.click(summary)
    expect(details.open).toBe(true)
    expect(within(details).getByText(/lets bad output through/)).toBeInTheDocument()
  })

  it('handles a rate with no labels in the class', async () => {
    const m = report().metrics
    const r = report({ metrics: { ...m, tnr: { rate: null, successes: 0, n: 0, interval: null }, confusion: { tp: 8, fn: 1, tn: 0, fp: 0 } } })
    installFetch(baseRoutes({ 'GET /api/calibration': { body: { latest: calibrationRecord({ report: r }) } } }))
    renderApp('/calibration')
    const tnr = await screen.findByLabelText('True negative rate')
    expect(within(tnr).getByTestId('tnr-value')).toHaveTextContent('n/a')
    expect(within(tnr).getByText(/No expert-fail labels were measured/)).toBeInTheDocument()
  })

  it('shows an empty state when nothing has been measured', async () => {
    installFetch(baseRoutes({ 'GET /api/calibration': { body: { latest: null } } }))
    renderApp('/calibration')
    expect(await screen.findByRole('heading', { name: 'No calibration yet' })).toBeInTheDocument()
  })
})

describe('calibration: preview and confirmation', () => {
  it('offers dev and test but never train', async () => {
    installFetch(baseRoutes())
    renderApp('/calibration')
    const split = await screen.findByLabelText('Split')
    const values = within(split).getAllByRole('option').map(o => (o as HTMLOptionElement).value)
    expect(values).toEqual(['dev', 'test'])
    expect(screen.getByText(/The train split is refused/)).toBeInTheDocument()
  })

  it('previews, then needs the dialog, then sends the token with confirm and shows the new report', async () => {
    const user = userEvent.setup()
    const fresh = calibrationRecord({ calibrationId: 'fresh', report: report({ judge: 'FRESH-JUDGE-NAME' }) })
    const fake = installFetch(baseRoutes({
      'POST /api/calibrate/preview': { body: calPreview() },
      'POST /api/calibrate/start': { body: { record: fresh } },
    }))
    renderApp('/calibration')
    await user.selectOptions(await screen.findByLabelText('Split'), 'test')
    await user.click(screen.getByRole('radio', { name: /All labels/ }))
    await user.click(screen.getByRole('button', { name: /Preview the cost/ }))
    expect(fake.to('POST /api/calibrate/preview')[0]!.body).toEqual({ rubricId: 'scheduling', split: 'test', selection: 'all' })
    await screen.findByRole('region', { name: 'Cost preview' })
    expect(fake.to('POST /api/calibrate/start')).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Review and start' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/9 labels to judge, with exactly 9 judge calls\./)).toBeInTheDocument()
    expect(fake.to('POST /api/calibrate/start')).toHaveLength(0)
    await user.click(within(dialog).getByRole('button', { name: /Start \(9 judge calls\)/ }))
    await waitFor(() => expect(fake.to('POST /api/calibrate/start')).toHaveLength(1))
    expect(fake.to('POST /api/calibrate/start')[0]!.body).toEqual({ rubricId: 'scheduling', split: 'test', selection: 'all', previewToken: 'cal-token', confirm: true })
    expect(await screen.findByText('FRESH-JUDGE-NAME')).toBeInTheDocument()
    expect(screen.getByText('Just measured')).toBeInTheDocument()
  })

  it('blocks start and explains when the judge is contaminated', async () => {
    const user = userEvent.setup()
    installFetch(baseRoutes({ 'POST /api/calibrate/preview': { body: calPreview({ contamination: 'The few-shot examples include lab-7 (dev).' }) } }))
    renderApp('/calibration')
    await user.click(await screen.findByRole('button', { name: /Preview the cost/ }))
    expect(await screen.findByText('This judge is contaminated. Start is blocked.')).toBeInTheDocument()
    expect(screen.getByText('The few-shot examples include lab-7 (dev).')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review and start' })).toBeDisabled()
  })

  it('shows a refusal from the server', async () => {
    const user = userEvent.setup()
    installFetch(baseRoutes({ 'POST /api/calibrate/preview': failure(400, 'bad_request', 'The train split is not allowed.') }))
    renderApp('/calibration')
    await user.click(await screen.findByRole('button', { name: /Preview the cost/ }))
    expect(await screen.findByText('The train split is not allowed.')).toBeInTheDocument()
  })

  it('keeps start off while another job runs', async () => {
    const job = { kind: 'run' as const, startedAt: '2026-11-12T10:00:00.000Z', suiteId: 's', scenarioIds: ['a'], finished: 0, cancelling: false }
    const { health } = await import('./fixtures')
    installFetch(baseRoutes({ 'GET /api/health': { body: health({ activeJob: job }) } }))
    renderApp('/calibration')
    // The stream's own hello is the source of truth once it arrives.
    const { FakeEventSource } = await import('./fake-api')
    await screen.findByLabelText('Split')
    const { act } = await import('@testing-library/react')
    act(() => {
      FakeEventSource.last.open()
      FakeEventSource.last.emit('hello', { type: 'hello', activeJob: job })
    })
    expect(await screen.findByText(/A job is running on the server/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Preview the cost/ })).toBeDisabled()
  })
})
