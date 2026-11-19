import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AnchorFromLabelResponse, Label, LabelMeta, LabelsResponse } from '../../src/ui/api-types'
import { baseRoutes, failure, installEventSource, installFetch, labelStatsFixture, renderApp } from './fake-api'
import { RUBRIC_HASH, reveal, rubrics } from './fixtures'

// "Use as worked example" on a labelled item: offered for train labels only,
// confirmed in a dialog, and shown as an Example badge once it is one.

beforeEach(() => installEventSource())

const lab = (id: string, over: Partial<Label> = {}): Label => ({
  id,
  group: id.split(':')[0],
  criterion: 'confirms-before-acting',
  input: `Please move it (${id})`,
  output: `Moved it (${id})`,
  verdict: 'fail',
  critique: `Acted without asking (${id})`,
  labeler: 'Sam',
  sampled_by: 'random',
  at: '2026-11-12T11:00:00.000Z',
  ...over,
})

const TRAIN = lab('run-train:confirms-before-acting')
const DEV = lab('run-dev:confirms-before-acting')
const EXAMPLE = lab('run-ex:confirms-before-acting')

const meta = (split: LabelMeta['split'], isExample = false): LabelMeta => ({ split, rubricId: 'scheduling', isExample })

function labelsBody(m: Record<string, LabelMeta> = {
  [TRAIN.id]: meta('train'),
  [DEV.id]: meta('dev'),
  [EXAMPLE.id]: meta('train', true),
}): { body: LabelsResponse } {
  return { body: { file: 'f', labels: [TRAIN, DEV, EXAMPLE], history: {}, meta: m, stats: labelStatsFixture({ total: 3 }) } }
}

const ADD_ROUTE = 'POST /api/rubrics/scheduling/anchors/from-label'
const added = (): AnchorFromLabelResponse => {
  const item = rubrics().rubrics[0]!
  const anchor = { criterion: 'confirms-before-acting', input: 'Please move it', output: TRAIN.output, verdict: 'fail' as const, critique: 'Acted without asking first.' }
  return { item: { ...item, rubric: { ...item.rubric, version: '3', anchors: [...item.rubric.anchors, anchor] } }, version: '3', hash: 'a'.repeat(64), anchor }
}

const rowOf = (text: string) => screen.getByText(text).closest('tr')!

async function openDetails(user: ReturnType<typeof userEvent.setup>, id: string) {
  await screen.findByText(id)
  await user.click(within(rowOf(id)).getByRole('button', { name: 'Details' }))
}

describe('All labels: split badges and the worked example button', () => {
  it('shows a split badge on every label and an Example badge on one that already is', async () => {
    installFetch(baseRoutes({ 'GET /api/labels': labelsBody() }))
    renderApp('/classify/labels')
    await screen.findByText(TRAIN.id)
    expect(within(rowOf(TRAIN.id)).getByText('train')).toHaveAttribute('data-split', 'train')
    expect(within(rowOf(DEV.id)).getByText('dev')).toBeInTheDocument()
    expect(within(rowOf(EXAMPLE.id)).getByText('Example')).toBeInTheDocument()
    expect(within(rowOf(TRAIN.id)).queryByText('Example')).toBeNull()
  })

  it('offers the button on a train label, and the dialog is prefilled, with the verdict read-only and the version it makes', async () => {
    const user = userEvent.setup()
    const fake = installFetch(baseRoutes({ 'GET /api/labels': labelsBody() }))
    renderApp('/classify/labels')
    await openDetails(user, TRAIN.id)
    const button = screen.getByRole('button', { name: 'Use as worked example' })
    expect(button).toBeEnabled()
    // Nothing is written on the first click.
    await user.click(button)
    const dialog = await screen.findByRole('dialog', { name: 'Use as a worked example' })
    expect(within(dialog).getByLabelText('Input')).toHaveValue(TRAIN.input)
    expect(within(dialog).getByLabelText('Output')).toHaveValue(TRAIN.output)
    expect(within(dialog).getByLabelText('Critique')).toHaveValue(TRAIN.critique)
    expect(within(dialog).queryByRole('textbox', { name: /Verdict/ })).toBeNull()
    expect(within(dialog).getByText('Verdict (from the label)')).toBeInTheDocument()
    expect(await within(dialog).findByTestId('example-impact')).toHaveTextContent(
      'Adds this to rubric scheduling and makes it version 3. The judge sees every worked example on every grading call, so each call costs slightly more.',
    )
    expect(fake.to(ADD_ROUTE)).toHaveLength(0)

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fake.to(ADD_ROUTE)).toHaveLength(0)
  })

  it('sends the edits and the rubric hash on Confirm, then says it was added and links to the criterion', async () => {
    const user = userEvent.setup()
    let added_ = false
    const fake = installFetch(baseRoutes({
      'GET /api/labels': () => labelsBody(added_ ? { [TRAIN.id]: meta('train', true), [DEV.id]: meta('dev'), [EXAMPLE.id]: meta('train', true) } : undefined),
      [ADD_ROUTE]: () => {
        added_ = true
        return { body: added() }
      },
    }))
    renderApp('/classify/labels')
    await openDetails(user, TRAIN.id)
    await user.click(screen.getByRole('button', { name: 'Use as worked example' }))
    const dialog = await screen.findByRole('dialog', { name: 'Use as a worked example' })
    await within(dialog).findByTestId('example-impact')
    const input = within(dialog).getByLabelText('Input')
    await user.clear(input)
    await user.type(input, 'Please move it')
    const critique = within(dialog).getByLabelText('Critique')
    await user.clear(critique)
    await user.type(critique, 'Acted without asking first.')
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText(/Added as a worked example/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'See it on the Rubrics tab' })).toHaveAttribute('href', '#/scenarios?tab=rubrics&rubric=scheduling&criterion=confirms-before-acting')
    // The output was not edited, so it is not sent: the server uses the label's own.
    expect(fake.to(ADD_ROUTE)[0]!.body).toEqual({ itemId: TRAIN.id, baseHash: RUBRIC_HASH, input: 'Please move it', critique: 'Acted without asking first.' })
    // The list is read again, and the row now carries the Example badge.
    await waitFor(() => expect(within(rowOf(TRAIN.id)).getByText('Example')).toBeInTheDocument())
  })

  it('keeps the dialog open with the reason when the server refuses', async () => {
    const user = userEvent.setup()
    installFetch(baseRoutes({
      'GET /api/labels': labelsBody(),
      [ADD_ROUTE]: failure(409, 'duplicate_example', 'Rubric "scheduling" already has a worked example with this input and output, so nothing was added.'),
    }))
    renderApp('/classify/labels')
    await openDetails(user, TRAIN.id)
    await user.click(screen.getByRole('button', { name: 'Use as worked example' }))
    const dialog = await screen.findByRole('dialog', { name: 'Use as a worked example' })
    await within(dialog).findByTestId('example-impact')
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }))
    expect(await within(dialog).findByText(/already has a worked example/)).toBeInTheDocument()
    expect(screen.queryByText(/Added as a worked example/)).toBeNull()
  })

  it('disables the button on a dev or test label, with the reason', async () => {
    const user = userEvent.setup()
    installFetch(baseRoutes({ 'GET /api/labels': labelsBody() }))
    renderApp('/classify/labels')
    await openDetails(user, DEV.id)
    const button = screen.getByRole('button', { name: 'Use as worked example' })
    expect(button).toBeDisabled()
    const hint = 'Only training labels can become worked examples, so dev and test stay an honest check of the judge.'
    expect(button).toHaveAttribute('title', hint)
    expect(button).toHaveAccessibleDescription(hint)
  })

  it('shows the Example badge instead of the button on a label that already is one', async () => {
    const user = userEvent.setup()
    installFetch(baseRoutes({ 'GET /api/labels': labelsBody() }))
    renderApp('/classify/labels')
    await openDetails(user, EXAMPLE.id)
    expect(screen.queryByRole('button', { name: 'Use as worked example' })).toBeNull()
    expect(screen.getAllByText('Example').length).toBe(2)
  })
})

describe('review queue: the example button appears only after the label is saved and revealed', () => {
  const ITEM = 'run-fail-1:confirms-before-acting'
  const saved = lab(ITEM, { input: 'I think I need to cancel my appointment.', output: 'Okay, I have cancelled it for you.', critique: 'It cancelled at once.' })

  it('is absent while labelling, and offered with the split badge after the reveal', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem('evals-ui-reveal-after-save', 'on')
    const fake = installFetch(baseRoutes({
      'POST /api/labels': { status: 201, body: { label: saved } },
      'GET /api/labels/run-fail-1%3Aconfirms-before-acting/reveal': { body: reveal() },
      'GET /api/labels': { body: { file: 'f', labels: [saved], history: {}, meta: { [ITEM]: meta('train') }, stats: labelStatsFixture() } },
    }))
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    expect(screen.queryByRole('button', { name: 'Use as worked example' })).toBeNull()
    await user.click(screen.getByRole('button', { name: /^Fail/ }))
    await user.type(screen.getByLabelText('Critique (required)'), 'It cancelled at once.')
    await user.type(screen.getByLabelText('Your name'), 'Sam')
    await user.click(screen.getByRole('button', { name: 'Save and show the judge' }))
    const area = await screen.findByLabelText('Worked example')
    expect(within(area).getByText('train')).toBeInTheDocument()
    expect(within(area).getByRole('button', { name: 'Use as worked example' })).toBeEnabled()
    expect(fake.to(ADD_ROUTE)).toHaveLength(0)
  })
})
