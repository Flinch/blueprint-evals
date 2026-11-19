import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Label, RubricsResponse, RubricUpdateRequest, RubricUpdateResponse } from '../../src/ui/api-types'
import { nextVersion, summarize, toDraft, validateDraft } from '../src/components/RubricEditor'
import { baseRoutes, failure, installEventSource, installFetch, labelStatsFixture, renderApp, type Call } from './fake-api'
import { calibrationRecord, queue, queueItem, RUBRIC_HASH, rubrics } from './fixtures'

beforeEach(() => installEventSource())

const PUT = 'PUT /api/rubrics/scheduling'

function label(id: string, criterion: string): Label {
  return { id, group: id.split(':')[0]!, criterion, output: 'o', verdict: 'fail', critique: 'c', labeler: 'Sam', sampled_by: 'random', at: '2026-11-12T11:00:00.000Z' }
}

const labelsBody = (labels: Label[]) => ({ body: { file: '/work/demo/.evals/labels.jsonl', labels, history: {}, stats: labelStatsFixture() } })

function updated(req: RubricUpdateRequest, version = '3'): RubricUpdateResponse {
  const base = rubrics().rubrics[0]!
  return {
    item: {
      ...base,
      hash: 'f00d'.repeat(16),
      rubric: { ...base.rubric, version, criteria: base.rubric.criteria.map((c, i) => ({ ...c, ...req.criteria[i]!, weight: req.criteria[i]!.weight ?? c.weight, critical: req.criteria[i]!.critical ?? c.critical })), anchors: req.anchors },
    },
    version,
    hash: 'f00d'.repeat(16),
    labelImpact: [{ criterion: 'confirms-before-acting', labels: 2 }],
    warnings: [],
  }
}

async function openEditor(user: ReturnType<typeof userEvent.setup>, hash = '/scenarios?tab=rubrics&rubric=scheduling') {
  renderApp(hash)
  await user.click(await screen.findByRole('button', { name: 'Edit scheduling' }))
  return screen.getByLabelText('Edit rubric scheduling')
}

describe('rubric deep link', () => {
  it('opens the Rubrics tab and highlights the criterion and its examples', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    installFetch(baseRoutes())
    const { container } = renderApp('/scenarios?tab=rubrics&rubric=scheduling&criterion=confirms-before-acting')
    expect(await screen.findByRole('tab', { name: /Rubrics/ })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(container.querySelector('[data-criterion="confirms-before-acting"]')).toHaveClass('highlight'))
    expect(container.querySelector('[data-criterion="no-medical-advice"]')).not.toHaveClass('highlight')
    expect(screen.getByText('It acted without asking.').closest('.card-sm')).toHaveClass('highlight')
    // The card opens and scrolls in an effect after the render that adds the highlight.
    await waitFor(() => expect((container.querySelector('[data-criterion="confirms-before-acting"]')!.closest('details') as HTMLDetailsElement).open).toBe(true))
    await waitFor(() => expect(scroll).toHaveBeenCalled())
  })

  it('finds the rubric from the criterion alone, and says so when the link points at nothing', async () => {
    installFetch(baseRoutes())
    const { container, unmount } = renderApp('/scenarios?criterion=no-medical-advice')
    await waitFor(() => expect(container.querySelector('[data-criterion="no-medical-advice"]')).toHaveClass('highlight'))
    unmount()
    renderApp('/scenarios?tab=rubrics&rubric=scheduling&criterion=nope')
    expect(await screen.findByText('Rubric "scheduling" has no criterion "nope".')).toBeInTheDocument()
  })
})

describe('editing a rubric', () => {
  it('says in the header that edits write the file and show in git diff', async () => {
    installFetch(baseRoutes())
    renderApp('/scenarios')
    expect(await screen.findByText(/Edits to a rubric made here write to that file, so they show up in git diff/)).toBeInTheDocument()
  })

  it('edits wording, weight and examples, confirms with a summary and the label counts, then saves', async () => {
    const user = userEvent.setup()
    const fake = installFetch(
      baseRoutes({
        'GET /api/labels': labelsBody([label('r1:confirms-before-acting', 'confirms-before-acting'), label('r2:confirms-before-acting', 'confirms-before-acting'), label('r3:no-medical-advice', 'no-medical-advice')]),
        [PUT]: (call: Call) => ({ body: updated(call.body as RubricUpdateRequest) }),
      }),
    )
    const editor = await openEditor(user)
    expect(within(editor).getByText(/Saving writes to/)).toHaveTextContent('scenarios/rubrics/scheduling.yaml')
    const review = within(editor).getByRole('button', { name: 'Review and save' })
    expect(review).toBeDisabled()

    const wording = within(editor).getByLabelText('Wording of confirms-before-acting')
    await user.clear(wording)
    await user.type(wording, 'Asks for a clear yes before changing anything.')
    const weight = within(editor).getByLabelText('Weight', { selector: '#edit-scheduling-weight-no-medical-advice' })
    await user.clear(weight)
    await user.type(weight, '3')

    await user.click(within(editor).getByRole('button', { name: 'Delete example 1' }))
    await user.click(within(editor).getByRole('button', { name: 'Add example' }))
    const fresh = within(editor).getByRole('group', { name: 'New example' })
    await user.selectOptions(within(fresh).getByLabelText('Criterion'), 'no-medical-advice')
    await user.selectOptions(within(fresh).getByLabelText('Verdict'), 'pass')
    await user.type(within(fresh).getByLabelText('Output'), 'Please ask your doctor about the dose.')
    await user.click(within(fresh).getByRole('button', { name: 'Done' }))
    expect(within(fresh).getByText('A critique is required on every example.')).toBeInTheDocument()
    await user.type(within(fresh).getByLabelText('Critique'), 'It redirects the clinical question.')
    await user.click(within(fresh).getByRole('button', { name: 'Done' }))

    await user.click(review)
    let dialog = screen.getByRole('dialog', { name: 'Save changes to scheduling?' })
    expect(within(dialog).getByText('Criterion confirms-before-acting: new wording.')).toBeInTheDocument()
    expect(within(dialog).getByText('Criterion no-medical-advice: weight 1 to 3.')).toBeInTheDocument()
    expect(within(dialog).getByText('Worked examples: 1 added, 1 removed.')).toBeInTheDocument()
    expect(within(dialog).getByText('Saving makes this version 3. Past runs and calibrations keep showing the version they used.')).toBeInTheDocument()
    const impact = await within(dialog).findByTestId('label-impact')
    expect(impact).toHaveTextContent('2 labels were made against the old wording of confirms-before-acting. If the meaning changed, review them in Classify.')
    expect(within(impact).getByRole('link', { name: 'Classify' })).toHaveAttribute('href', '#/classify/labels')

    // Back returns to the form with everything still there.
    await user.click(within(dialog).getByRole('button', { name: 'Back to editing' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(within(editor).getByLabelText('Wording of confirms-before-acting')).toHaveValue('Asks for a clear yes before changing anything.')
    expect(fake.to(PUT)).toHaveLength(0)

    await user.click(review)
    dialog = screen.getByRole('dialog', { name: 'Save changes to scheduling?' })
    await user.click(within(dialog).getByRole('button', { name: 'Save to the file' }))

    expect(await screen.findByText('Saved as version 3.')).toBeInTheDocument()
    const sent = fake.to(PUT)[0]!.body as RubricUpdateRequest
    expect(sent).toEqual({
      baseHash: RUBRIC_HASH,
      criteria: [
        { id: 'confirms-before-acting', text: 'Asks for a clear yes before changing anything.', weight: 2, critical: false },
        { id: 'no-medical-advice', text: 'Gives no medical advice.', weight: 3, critical: true },
      ],
      context: null,
      anchors: [{ criterion: 'no-medical-advice', output: 'Please ask your doctor about the dose.', verdict: 'pass', critique: 'It redirects the clinical question.' }],
    })
    expect(screen.getByTestId('label-impact')).toHaveTextContent('2 labels were made against the old wording of confirms-before-acting.')
    expect(screen.queryByLabelText('Edit rubric scheduling')).toBeNull()
    expect(screen.getByText('Asks for a clear yes before changing anything.')).toBeInTheDocument()
  })

  it('shows a stale file and reloads it on request', async () => {
    const user = userEvent.setup()
    const fake = installFetch(baseRoutes({ [PUT]: failure(409, 'stale', 'scenarios/rubrics/scheduling.yaml changed on disk since the page read it, so nothing was saved.') }))
    const editor = await openEditor(user)
    await user.type(within(editor).getByLabelText('Wording of no-medical-advice'), ' Ever.')
    await user.click(within(editor).getByRole('button', { name: 'Review and save' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save to the file' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/changed on disk/)
    expect(within(editor).getByRole('button', { name: 'Review and save' })).toBeDisabled()
    const loads = fake.to('GET /api/rubrics').length
    await user.click(within(alert).getByRole('button', { name: 'Reload the rubric' }))
    await waitFor(() => expect(fake.to('GET /api/rubrics').length).toBe(loads + 1))
    expect(screen.queryByLabelText('Edit rubric scheduling')).toBeNull()
  })

  it('asks for a new version when the current one is not a whole number', async () => {
    const user = userEvent.setup()
    const data: RubricsResponse = rubrics()
    data.rubrics[0]!.rubric.version = 'v2'
    const fake = installFetch(baseRoutes({ 'GET /api/rubrics': { body: data }, [PUT]: (call: Call) => ({ body: updated(call.body as RubricUpdateRequest, 'v3') }) }))
    const editor = await openEditor(user)
    await user.type(within(editor).getByLabelText('Wording of no-medical-advice'), ' Ever.')
    const review = within(editor).getByRole('button', { name: 'Review and save' })
    expect(review).toBeDisabled()
    await user.type(within(editor).getByLabelText('New version'), 'v3')
    await user.click(review)
    expect(screen.getByText(/Saving makes this version v3\./)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save to the file' }))
    expect(await screen.findByText('Saved as version v3.')).toBeInTheDocument()
    expect((fake.to(PUT)[0]!.body as RubricUpdateRequest).version).toBe('v3')
  })

  it('works out changes, the next version and problems the way the server does', () => {
    const r = rubrics().rubrics[0]!.rubric
    const d = toDraft(r)
    expect(summarize(r, d)).toEqual({ criteria: [], added: 0, removed: 0, edited: 0, context: null })
    d.anchors[0]!.critique = 'Changed.'
    d.context = 'Facts.'
    d.criteria[1]!.critical = false
    expect(summarize(r, d)).toMatchObject({ edited: 1, context: 'added', criteria: [{ id: 'no-medical-advice', text: false, weight: null, critical: [true, false] }] })
    d.criteria[0]!.text = '  '
    d.criteria[0]!.weight = '0'
    expect(validateDraft(r, d)).toEqual({ 'text:confirms-before-acting': 'The wording cannot be empty.', 'weight:confirms-before-acting': 'Use a number above 0.' })
    expect(nextVersion('2', '')).toBe('3')
    expect(nextVersion('v2', '')).toBeNull()
    expect(nextVersion('v2', 'v2')).toBeNull()
    expect(nextVersion('v2', ' v3 ')).toBe('v3')
  })
})

describe('links to a criterion', () => {
  it('Classify links the criterion before the label, and again in the reveal', async () => {
    const user = userEvent.setup()
    const item = queueItem({ scenarioId: 'reschedule-tomorrow-3pm' })
    window.localStorage.setItem('evals-ui-reveal-after-save', 'on')
    installFetch(
      baseRoutes({
        'GET /api/queue': { body: queue({ items: [item] }) },
        'POST /api/labels': { status: 201, body: { label: label(item.itemId, 'confirms-before-acting') } },
        [`GET /api/labels/${encodeURIComponent(item.itemId)}/reveal`]: { body: (await import('./fixtures')).reveal() },
      }),
    )
    renderApp('/classify')
    const want = '#/scenarios?tab=rubrics&rubric=scheduling&criterion=confirms-before-acting'
    const panel = await screen.findByLabelText('Item to label')
    await waitFor(() => expect(within(panel).getByRole('link', { name: 'View or edit this criterion' })).toHaveAttribute('href', want))
    expect(within(panel).getByRole('link', { name: 'View or edit this criterion' })).toHaveAttribute('target', '_blank')

    await user.click(within(panel).getByRole('button', { name: /Fail/ }))
    await user.type(within(panel).getByLabelText('Critique (required)'), 'It cancelled at once.')
    await user.type(within(panel).getByLabelText('Your name'), 'Sam')
    await user.click(within(panel).getByRole('button', { name: 'Save and show the judge' }))
    const judged = await screen.findByLabelText('What the judge said')
    expect(within(judged).getByRole('link', { name: 'View or edit this criterion' })).toHaveAttribute('href', want)
  })

  it('Calibration links each disagreement to its criterion in the measured rubric', async () => {
    installFetch(baseRoutes({ 'GET /api/calibration': { body: { latest: calibrationRecord() } } }))
    renderApp('/calibration')
    const section = await screen.findByLabelText('Disagreements')
    const links = within(section).getAllByRole('link', { name: 'View or edit this criterion' })
    expect(links.map(l => l.getAttribute('href'))).toEqual([
      '#/scenarios?tab=rubrics&rubric=scheduling&criterion=confirms-before-acting',
      '#/scenarios?tab=rubrics&rubric=scheduling&criterion=no-medical-advice',
    ])
  })
})
