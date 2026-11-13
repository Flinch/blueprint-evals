import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Label } from '../../src/ui/api-types'
import { baseRoutes, failure, installEventSource, installFetch, labelStatsFixture, renderApp } from './fake-api'
import { JUDGE_CRITIQUE, queue, queueItem, reveal } from './fixtures'

beforeEach(() => installEventSource())

const REVEAL_ROUTE = 'GET /api/labels/run-fail-1%3Aconfirms-before-acting/reveal'

function savedLabel(over: Partial<Label> = {}): Label {
  return {
    id: 'run-fail-1:confirms-before-acting',
    group: 'run-fail-1',
    criterion: 'confirms-before-acting',
    input: 'I think I need to cancel my appointment.',
    output: 'Okay, I have cancelled it for you.',
    verdict: 'fail',
    critique: 'It cancelled at once.',
    labeler: 'Sam',
    sampled_by: 'targeted',
    at: '2026-11-12T11:00:00.000Z',
    ...over,
  }
}

function routes(over = {}) {
  return baseRoutes({
    'POST /api/labels': { status: 201, body: { label: savedLabel() } },
    [REVEAL_ROUTE]: { body: reveal() },
    ...over,
  })
}

describe('blind labelling: nothing about the judge before the label is saved', () => {
  it('shows the input, the output and the criterion, and nothing from the judge or the queue reason', async () => {
    const fake = installFetch(routes())
    const { container } = renderApp('/classify')
    expect(await screen.findByText('Asks the user to confirm before changing the appointment.')).toBeInTheDocument()
    const item = screen.getByLabelText('Item to label')
    expect(within(item).getAllByText('I think I need to cancel my appointment.').length).toBeGreaterThan(0)
    expect(within(item).getByText('Okay, I have cancelled it for you.')).toBeInTheDocument()

    // The item's reason is "targeted-failure". The page must not reveal it, in any form.
    const html = container.innerHTML
    expect(html).not.toMatch(/targeted/i)
    expect(html).not.toContain('targeted-failure')
    expect(html).not.toContain(JUDGE_CRITIQUE)
    expect(within(item).queryByText(/verdict:|critique:|the judge said/i)).toBeNull()
    expect(within(item).queryByText(/^(pass|fail)$/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /Reveal/ })).toBeNull()
    expect(fake.calls.some(c => c.path.endsWith('/reveal'))).toBe(false)
  })

  it('does not put the judge anywhere in the DOM while the label is being written, for a random item too', async () => {
    const user = userEvent.setup()
    const fake = installFetch(routes({ 'GET /api/queue': { body: queue({ items: [queueItem({ reason: 'random' }), queueItem({ itemId: 'x:y', reason: 'targeted-error' })] }) } }))
    const { container } = renderApp('/classify')
    await screen.findByLabelText('Item to label')
    await user.click(screen.getByRole('button', { name: /^Pass/ }))
    await user.type(screen.getByLabelText('Critique (required)'), 'Looks right.')
    expect(container.innerHTML).not.toMatch(/targeted/i)
    expect(container.innerHTML).not.toContain(JUDGE_CRITIQUE)
    expect(fake.calls.some(c => c.path.endsWith('/reveal'))).toBe(false)
  })

  it('shows the reveal step only after the label is saved, and fetches the judge only when asked', async () => {
    const user = userEvent.setup()
    const fake = installFetch(routes())
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    await user.click(screen.getByRole('button', { name: /^Fail/ }))
    await user.type(screen.getByLabelText('Critique (required)'), 'It cancelled at once.')
    await user.type(screen.getByLabelText('Your name'), 'Sam')
    await user.click(screen.getByRole('button', { name: 'Save label' }))

    expect(await screen.findByText('Label saved.')).toBeInTheDocument()
    // Saved, but the judge is still hidden and no reveal request was made.
    expect(screen.getByRole('button', { name: 'Reveal what the judge said' })).toBeInTheDocument()
    expect(screen.queryByText(JUDGE_CRITIQUE)).toBeNull()
    expect(fake.calls.some(c => c.path.endsWith('/reveal'))).toBe(false)
    expect(fake.to('POST /api/labels')[0]!.body).toEqual({ itemId: 'run-fail-1:confirms-before-acting', labeler: 'Sam', verdict: 'fail', critique: 'It cancelled at once.' })

    await user.click(screen.getByRole('button', { name: 'Reveal what the judge said' }))
    expect(await screen.findByText(JUDGE_CRITIQUE)).toBeInTheDocument()
    expect(screen.getByText('You and the judge agree.')).toBeInTheDocument()
    expect(fake.to(REVEAL_ROUTE)).toHaveLength(1)
  })

  it('shows disagreement plainly', async () => {
    const user = userEvent.setup()
    installFetch(routes({
      'POST /api/labels': { status: 201, body: { label: savedLabel({ verdict: 'pass' }) } },
      [REVEAL_ROUTE]: { body: reveal({ agrees: false, human: { verdict: 'pass', critique: 'Fine.', labeler: 'Sam', at: '2026-11-12T11:00:00.000Z' } }) },
    }))
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    await user.click(screen.getByRole('button', { name: /^Pass/ }))
    await user.type(screen.getByLabelText('Critique (required)'), 'Fine.')
    await user.type(screen.getByLabelText('Your name'), 'Sam')
    await user.click(screen.getByRole('button', { name: 'Save label' }))
    await user.click(await screen.findByRole('button', { name: 'Reveal what the judge said' }))
    expect(await screen.findByText('You and the judge disagree.')).toBeInTheDocument()
  })

  it('says when the judge never decided the criterion', async () => {
    const user = userEvent.setup()
    installFetch(routes({ [REVEAL_ROUTE]: { body: reveal({ judge: null, agrees: null, runError: 'Judge call failed: timeout' }) } }))
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    await user.click(screen.getByRole('button', { name: /^Fail/ }))
    await user.type(screen.getByLabelText('Critique (required)'), 'x')
    await user.type(screen.getByLabelText('Your name'), 'Sam')
    await user.click(screen.getByRole('button', { name: 'Save label' }))
    await user.click(await screen.findByRole('button', { name: 'Reveal what the judge said' }))
    expect(await screen.findByText('The judge never decided this criterion.')).toBeInTheDocument()
    expect(screen.getByText(/Judge call failed: timeout/)).toBeInTheDocument()
  })
})

describe('blind labelling: validation and controls', () => {
  it('requires a critique, a verdict and a name before the save button is enabled', async () => {
    const user = userEvent.setup()
    installFetch(routes())
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    const save = screen.getByRole('button', { name: 'Save label' })
    expect(save).toBeDisabled()
    await user.click(screen.getByRole('button', { name: /^Pass/ }))
    await user.type(screen.getByLabelText('Your name'), 'Sam')
    expect(save).toBeDisabled()
    await user.type(screen.getByLabelText('Critique (required)'), '   ')
    expect(save).toBeDisabled() // whitespace is not a critique
    await user.type(screen.getByLabelText('Critique (required)'), 'ok')
    expect(save).toBeEnabled()
  })

  it('shows the validation message and posts nothing when Enter is pressed with no critique', async () => {
    const user = userEvent.setup()
    const fake = installFetch(routes())
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    await user.click(screen.getByRole('button', { name: /^Pass/ }))
    await user.type(screen.getByLabelText('Your name'), 'Sam')
    // Move focus off the text field so the plain Enter shortcut applies.
    ;(document.activeElement as HTMLElement).blur()
    await user.keyboard('{Enter}')
    expect(await screen.findByText('A critique is required on every label.')).toBeInTheDocument()
    expect(fake.to('POST /api/labels')).toHaveLength(0)
  })

  it('keyboard: P and F choose, Ctrl+Enter saves from the text box, N skips, and the hint is visible', async () => {
    const user = userEvent.setup()
    const fake = installFetch(routes())
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    const hint = screen.getByText(/skip/i, { selector: 'span' })
    expect(hint.textContent).toMatch(/pass.*fail.*skip.*submit/)

    // N skips to the back of the list, so the second item comes up, then the first again.
    await user.keyboard('n')
    expect(await screen.findByText('I can move it to 15:00. Shall I go ahead?')).toBeInTheDocument()
    await user.keyboard('n')
    expect(await screen.findByText('Okay, I have cancelled it for you.')).toBeInTheDocument()

    await user.keyboard('p')
    expect(screen.getByRole('button', { name: /^Pass/ })).toHaveAttribute('aria-pressed', 'true')
    await user.keyboard('f') // focus is now in the critique box, so this types text
    expect(screen.getByLabelText('Critique (required)')).toHaveValue('f')
    ;(document.activeElement as HTMLElement).blur()
    await user.keyboard('f')
    expect(screen.getByRole('button', { name: /^Fail/ })).toHaveAttribute('aria-pressed', 'true')

    await user.type(screen.getByLabelText('Your name'), 'Sam')
    await user.type(screen.getByLabelText('Critique (required)'), 'Acted without asking.')
    await user.keyboard('{Control>}{Enter}{/Control}')
    await screen.findByText('Label saved.')
    expect(fake.to('POST /api/labels')).toHaveLength(1)

    // N after saving goes to the next item.
    await user.keyboard('n')
    expect(await screen.findByText('I can move it to 15:00. Shall I go ahead?')).toBeInTheDocument()
  })

  it('remembers the labeler name in localStorage, and works when storage throws', async () => {
    const user = userEvent.setup()
    installFetch(routes())
    const first = renderApp('/classify')
    await screen.findByLabelText('Item to label')
    await user.click(screen.getByRole('button', { name: /^Pass/ }))
    await user.type(screen.getByLabelText('Your name'), 'Alex')
    await user.type(screen.getByLabelText('Critique (required)'), 'Fine.')
    await user.click(screen.getByRole('button', { name: 'Save label' }))
    await screen.findByText('Label saved.')
    expect(window.localStorage.getItem('evals-ui-labeler')).toBe('Alex')
    first.unmount()

    installEventSource()
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    expect(screen.getByLabelText('Your name')).toHaveValue('Alex')
  })

  it('still works when localStorage throws on read and write', async () => {
    const user = userEvent.setup()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    installFetch(routes())
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    expect(screen.getByLabelText('Your name')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: /^Pass/ }))
    await user.type(screen.getByLabelText('Your name'), 'Sam')
    await user.type(screen.getByLabelText('Critique (required)'), 'Fine.')
    await user.click(screen.getByRole('button', { name: 'Save label' }))
    expect(await screen.findByText('Label saved.')).toBeInTheDocument()
  })

  it('shows the quota status the server reports, progress, and a labelled-so-far summary', async () => {
    installFetch(routes())
    renderApp('/classify')
    const quota = await screen.findByLabelText('Random sampling quota')
    expect(within(quota).getByText('Behind')).toBeInTheDocument()
    expect(within(quota).getByText(/20% of your 5 labels are random samples\. The minimum is 30%/)).toBeInTheDocument()
    const summary = await screen.findByLabelText('Labelled so far')
    expect(within(summary).getByText('5')).toBeInTheDocument()
    expect(screen.getByText(/0 labelled this session, 2 left in this batch, 4 up for review in total/)).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Review progress' })).toBeInTheDocument()
  })

  it('shows a met quota', async () => {
    installFetch(routes({ 'GET /api/queue': { body: queue({ stats: { candidates: 5, pending: 2, queued: 2, labelled: 10, labelledRandom: 5, labelledRandomShare: 0.5, minRandomShare: 0.3, quotaMet: true } }) } }))
    renderApp('/classify')
    const quota = await screen.findByLabelText('Random sampling quota')
    expect(within(quota).getByText('Met')).toBeInTheDocument()
  })

  it('handles an item that already has a label (409) without losing the page', async () => {
    const user = userEvent.setup()
    installFetch(routes({ 'POST /api/labels': failure(409, 'duplicate_label', 'A label with the id "x" already exists.') }))
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    await user.click(screen.getByRole('button', { name: /^Pass/ }))
    await user.type(screen.getByLabelText('Your name'), 'Sam')
    await user.type(screen.getByLabelText('Critique (required)'), 'ok')
    await user.click(screen.getByRole('button', { name: 'Save label' }))
    expect(await screen.findByText(/already exists\. It is not in your queue any more/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next item' }))
    expect(await screen.findByText('I can move it to 15:00. Shall I go ahead?')).toBeInTheDocument()
  })

  it('shows the earlier conversation only on request', async () => {
    const user = userEvent.setup()
    installFetch(routes({ 'GET /api/queue': { body: queue({ items: [queueItem({ context: [{ index: 0, role: 'user', content: 'EARLIER-USER-LINE' }, { index: 1, role: 'assistant', content: 'EARLIER-AGENT-LINE', toolCalls: [{ name: 'lookup', arguments: { a: 1 } }] }] })] }) } }))
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    expect(screen.queryByText('EARLIER-AGENT-LINE')).toBeNull()
    await user.click(screen.getByRole('button', { name: /Show the earlier conversation \(2 turns\)/ }))
    expect(screen.getByText('EARLIER-AGENT-LINE')).toBeInTheDocument()
  })

  it('shows an empty state with the server note when nothing is up for review', async () => {
    installFetch(routes({ 'GET /api/queue': { body: queue({ items: [], notes: ['There are no saved runs to label yet.'] }) } }))
    renderApp('/classify')
    expect(await screen.findByRole('heading', { name: 'Nothing to review right now' })).toBeInTheDocument()
    expect(screen.getAllByText('There are no saved runs to label yet.').length).toBeGreaterThan(0)
  })

  it('shows an error state when the queue cannot load', async () => {
    installFetch(routes({ 'GET /api/queue': failure(500, 'internal', 'The queue broke.') }))
    renderApp('/classify')
    expect(await screen.findByText(/The queue broke\./)).toBeInTheDocument()
  })
})

describe('labels list', () => {
  const labels: Label[] = [
    savedLabel(),
    savedLabel({ id: 'hand-1', group: undefined, verdict: 'pass', sampled_by: 'random', labeler: 'Alex', critique: 'Clear and correct.', criterion: 'no-medical-advice' }),
  ]
  const listRoutes = () => routes({ 'GET /api/labels': { body: { file: '/work/demo/.evals/labels.jsonl', labels, stats: labelStatsFixture({ total: 2, labelers: ['Alex', 'Sam'] }) } } })

  it('lists labels with a summary and filters them', async () => {
    const user = userEvent.setup()
    installFetch(listRoutes())
    renderApp('/classify/labels')
    expect(await screen.findByText('hand-1')).toBeInTheDocument()
    expect(screen.getByText('run-fail-1:confirms-before-acting')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Verdict'), 'pass')
    expect(screen.queryByText('run-fail-1:confirms-before-acting')).toBeNull()
    expect(screen.getByText('hand-1')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Verdict'), '')
    await user.selectOptions(screen.getByLabelText('Labeler'), 'Sam')
    expect(screen.queryByText('hand-1')).toBeNull()
  })

  it('reveals the judge for a saved label, and explains a label that cannot be revealed', async () => {
    const user = userEvent.setup()
    installFetch(listRoutes())
    // Add the route for the hand-written label too.
    const fake = installFetch(routes({
      'GET /api/labels': { body: { file: 'f', labels, stats: labelStatsFixture({ total: 2, labelers: ['Alex', 'Sam'] }) } },
      'GET /api/labels/hand-1/reveal': failure(404, 'not_revealable', 'This label is not for a queue item.'),
    }))
    renderApp('/classify/labels')
    await screen.findByText('hand-1')
    const rows = screen.getAllByRole('button', { name: 'Details' })
    await user.click(rows[0]!)
    await user.click(screen.getByRole('button', { name: 'Reveal what the judge said' }))
    expect(await screen.findByText(JUDGE_CRITIQUE)).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Details' }).find(b => b.getAttribute('aria-expanded') === 'false')!)
    await user.click(screen.getByRole('button', { name: 'Reveal what the judge said' }))
    expect(await screen.findByText('This label is not for a queue item.')).toBeInTheDocument()
    expect(fake.to('GET /api/labels/hand-1/reveal')).toHaveLength(1)
  })

  it('shows an empty state with no labels', async () => {
    installFetch(routes())
    renderApp('/classify/labels')
    expect(await screen.findByRole('heading', { name: 'No labels yet' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Labels')).toBeInTheDocument())
  })
})
