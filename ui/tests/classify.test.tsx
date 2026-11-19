import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Label } from '../../src/ui/api-types'
import { canNotApply, NOT_APPLICABLE_CRITIQUE, REVEAL_AFTER_KEY, RevealView, validateLabel } from '../src/pages/ClassifyPage'
import { baseRoutes, failure, installEventSource, installFetch, labelStatsFixture, renderApp } from './fake-api'
import { failingRun, JUDGE_CRITIQUE, queue, queueItem, reveal } from './fixtures'

beforeEach(() => installEventSource())

const REVEAL_ROUTE = 'GET /api/labels/run-fail-1%3Aconfirms-before-acting/reveal'
const REVISE_ROUTE = 'POST /api/labels/run-fail-1%3Aconfirms-before-acting/revise'

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
    // The opt-in checkbox is the only place the judge is mentioned.
    const mentions = within(item).queryAllByText(/verdict:|critique:|the judge said/i).map(e => e.textContent?.trim())
    expect(mentions).toEqual(['Show me what the judge said after I save'])
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

  it('with the checkbox off, saving moves to the next item with a Saved banner and makes no reveal request', async () => {
    const user = userEvent.setup()
    const fake = installFetch(routes())
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    expect(screen.getByLabelText('Show me what the judge said after I save')).not.toBeChecked()
    await user.click(screen.getByRole('button', { name: /^Fail/ }))
    await user.type(screen.getByLabelText('Critique (required)'), 'It cancelled at once.')
    await user.type(screen.getByLabelText('Your name'), 'Sam')
    await user.click(screen.getByRole('button', { name: 'Save and go to next' }))

    expect(await screen.findByText(/Saved: fail for confirms-before-acting \(scenario /)).toBeInTheDocument()
    expect(await screen.findByText('I can move it to 15:00. Shall I go ahead?')).toBeInTheDocument()
    expect(screen.queryByText('Label saved.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reveal what the judge said' })).toBeNull()
    expect(screen.queryByText(JUDGE_CRITIQUE)).toBeNull()
    expect(fake.calls.some(c => c.path.endsWith('/reveal'))).toBe(false)
    expect(fake.to('POST /api/labels')[0]!.body).toEqual({ itemId: 'run-fail-1:confirms-before-acting', labeler: 'Sam', verdict: 'fail', critique: 'It cancelled at once.' })
    // The form is reset for the next item.
    expect(screen.getByRole('button', { name: /^Fail/ })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByLabelText('Critique (required)')).toHaveValue('')
  })

  it('with the checkbox on, saving fetches the reveal once and shows the judge critique', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(REVEAL_AFTER_KEY, 'on')
    const fake = installFetch(routes())
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    expect(screen.getByLabelText('Show me what the judge said after I save')).toBeChecked()
    await user.click(screen.getByRole('button', { name: /^Fail/ }))
    await user.type(screen.getByLabelText('Critique (required)'), 'It cancelled at once.')
    await user.type(screen.getByLabelText('Your name'), 'Sam')
    // Blind until saved: no reveal request yet.
    expect(fake.calls.some(c => c.path.endsWith('/reveal'))).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Save and show the judge' }))

    expect(await screen.findByText('Label saved.')).toBeInTheDocument()
    expect(await screen.findByText(JUDGE_CRITIQUE)).toBeInTheDocument()
    expect(screen.getByText('You and the judge agree.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change my label (E)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next item' })).toBeInTheDocument()
    expect(fake.to('POST /api/labels')[0]!.body).toEqual({ itemId: 'run-fail-1:confirms-before-acting', labeler: 'Sam', verdict: 'fail', critique: 'It cancelled at once.' })
    expect(fake.to(REVEAL_ROUTE)).toHaveLength(1)
  })

  it('offers the Reveal button as a fallback when the reveal fetch fails after saving', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(REVEAL_AFTER_KEY, 'on')
    let calls = 0
    const fake = installFetch(routes({ [REVEAL_ROUTE]: () => (++calls === 1 ? failure(500, 'internal', 'Reveal broke.') : { body: reveal() }) }))
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    await user.click(screen.getByRole('button', { name: /^Fail/ }))
    await user.type(screen.getByLabelText('Critique (required)'), 'It cancelled at once.')
    await user.type(screen.getByLabelText('Your name'), 'Sam')
    await user.click(screen.getByRole('button', { name: 'Save and show the judge' }))
    await user.click(await screen.findByRole('button', { name: 'Reveal what the judge said' }))
    expect(await screen.findByText(JUDGE_CRITIQUE)).toBeInTheDocument()
    expect(fake.to(REVEAL_ROUTE)).toHaveLength(2)
  })

  it('ticking the checkbox stores "on" in localStorage, and unticking stores "off"', async () => {
    const user = userEvent.setup()
    installFetch(routes())
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    const box = screen.getByLabelText('Show me what the judge said after I save')
    expect(window.localStorage.getItem(REVEAL_AFTER_KEY)).toBeNull()
    expect(screen.getByRole('button', { name: 'Save and go to next' })).toBeInTheDocument()
    await user.click(box)
    expect(window.localStorage.getItem(REVEAL_AFTER_KEY)).toBe('on')
    expect(screen.getByRole('button', { name: 'Save and show the judge' })).toBeInTheDocument()
    await user.click(box)
    expect(window.localStorage.getItem(REVEAL_AFTER_KEY)).toBe('off')
    expect(screen.getByRole('button', { name: 'Save and go to next' })).toBeInTheDocument()
  })

  it('shows disagreement plainly', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(REVEAL_AFTER_KEY, 'on')
    installFetch(routes({
      'POST /api/labels': { status: 201, body: { label: savedLabel({ verdict: 'pass' }) } },
      [REVEAL_ROUTE]: { body: reveal({ agrees: false, human: { verdict: 'pass', critique: 'Fine.', labeler: 'Sam', at: '2026-11-12T11:00:00.000Z' } }) },
    }))
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    await user.click(screen.getByRole('button', { name: /^Pass/ }))
    await user.type(screen.getByLabelText('Critique (required)'), 'Fine.')
    await user.type(screen.getByLabelText('Your name'), 'Sam')
    await user.click(screen.getByRole('button', { name: 'Save and show the judge' }))
    expect(await screen.findByText('You and the judge disagree.')).toBeInTheDocument()
  })

  it('says when the judge never decided the criterion', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(REVEAL_AFTER_KEY, 'on')
    installFetch(routes({ [REVEAL_ROUTE]: { body: reveal({ judge: null, agrees: null, runError: 'Judge call failed: timeout' }) } }))
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    await user.click(screen.getByRole('button', { name: /^Fail/ }))
    await user.type(screen.getByLabelText('Critique (required)'), 'x')
    await user.type(screen.getByLabelText('Your name'), 'Sam')
    await user.click(screen.getByRole('button', { name: 'Save and show the judge' }))
    expect(await screen.findByText('The judge never decided this criterion.')).toBeInTheDocument()
    expect(screen.getByText(/Judge call failed: timeout/)).toBeInTheDocument()
  })
})

describe('changing a label after the reveal', () => {
  beforeEach(() => window.localStorage.setItem(REVEAL_AFTER_KEY, 'on'))
  const revisedLabel = savedLabel({ id: 'run-fail-1:confirms-before-acting~r1', replaces: 'run-fail-1:confirms-before-acting', verdict: 'pass', critique: 'It did ask in [1].', at: '2026-11-12T11:05:00.000Z' })
  const revisedReveal = reveal({
    labelId: revisedLabel.id,
    human: { verdict: 'pass', critique: 'It did ask in [1].', labeler: 'Sam', at: revisedLabel.at },
    agrees: false,
    original: { verdict: 'fail', critique: 'It cancelled at once.', at: '2026-11-12T11:00:00.000Z' },
    revisions: 1,
    blindAgrees: true,
  })
  function flowRoutes() {
    let revised = false
    return routes({
      [REVEAL_ROUTE]: () => ({ body: revised ? revisedReveal : reveal() }),
      [REVISE_ROUTE]: () => {
        revised = true
        return { status: 201, body: { label: revisedLabel } }
      },
    })
  }
  async function saveAndReveal(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByLabelText('Item to label')
    await user.click(screen.getByRole('button', { name: /^Fail/ }))
    await user.type(screen.getByLabelText('Critique (required)'), 'It cancelled at once.')
    await user.type(screen.getByLabelText('Your name'), 'Sam')
    await user.click(screen.getByRole('button', { name: 'Save and show the judge' }))
    await screen.findByText('Label saved.')
  }

  it('is offered only after the label is saved and the judge revealed', async () => {
    const user = userEvent.setup()
    const fake = installFetch(flowRoutes())
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    expect(screen.queryByRole('button', { name: /Change my label/ })).toBeNull()
    await user.keyboard('e')
    expect(screen.queryByLabelText('Change the label')).toBeNull()
    await saveAndReveal(user)
    // Saved and revealed at once: the change button is there.
    expect(await screen.findByRole('button', { name: 'Change my label (E)' })).toBeInTheDocument()
    expect(fake.to(REVISE_ROUTE)).toHaveLength(0)
  })

  it('opens a pre-filled form, saves the change, and shows what changed', async () => {
    const user = userEvent.setup()
    const fake = installFetch(flowRoutes())
    renderApp('/classify')
    await saveAndReveal(user)
    await screen.findByText(JUDGE_CRITIQUE)
    expect(screen.getByText(/change my label/, { selector: 'span' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Change my label (E)' }))
    const form = screen.getByLabelText('Change the label')
    expect(within(form).getByRole('button', { name: 'Fail' })).toHaveAttribute('aria-pressed', 'true')
    const critique = within(form).getByLabelText('Critique (required)')
    expect(critique).toHaveValue('It cancelled at once.')
    expect(within(form).getByLabelText('Your name')).toHaveValue('Sam')
    // Nothing changed yet, so there is nothing to save.
    expect(within(form).getByRole('button', { name: 'Save the change' })).toBeDisabled()

    await user.click(within(form).getByRole('button', { name: 'Pass' }))
    await user.clear(critique)
    await user.type(critique, '  It did ask in [[1].  ')
    await user.click(within(form).getByRole('button', { name: 'Save the change' }))

    expect(await screen.findByText('You changed this from Fail to Pass after seeing the judge.')).toBeInTheDocument()
    expect(screen.getByText('Label changed.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Change the label')).toBeNull()
    expect(fake.to(REVISE_ROUTE)[0]!.body).toEqual({ verdict: 'pass', critique: 'It did ask in [1].', labeler: 'Sam' })
    expect(fake.to(REVEAL_ROUTE)).toHaveLength(2)
    expect(screen.getByText('You and the judge disagree.')).toBeInTheDocument()
    expect(within(screen.getByLabelText('Your first label')).getByText(/It cancelled at once\./)).toBeInTheDocument()
  })

  it('opens with E, and Cancel or Escape returns to the reveal without saving', async () => {
    const user = userEvent.setup()
    const fake = installFetch(flowRoutes())
    renderApp('/classify')
    await saveAndReveal(user)
    await screen.findByText(JUDGE_CRITIQUE)
    ;(document.activeElement as HTMLElement).blur()
    await user.keyboard('e')
    expect(screen.getByLabelText('Change the label')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Change the label')).toBeNull()
    expect(screen.getByRole('button', { name: 'Change my label (E)' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Change my label (E)' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByLabelText('Change the label')).toBeNull()
    expect(fake.to(REVISE_ROUTE)).toHaveLength(0)
  })

  it('shows the server error and keeps the form when the change is refused', async () => {
    const user = userEvent.setup()
    installFetch(routes({ [REVISE_ROUTE]: failure(422, 'no_change', 'The verdict and critique are the same as the current label, so nothing was saved.') }))
    renderApp('/classify')
    await saveAndReveal(user)
    await user.click(await screen.findByRole('button', { name: 'Change my label (E)' }))
    await user.type(screen.getByLabelText('Critique (required)', { selector: '#revise-current-critique' }), ' More.')
    await user.click(screen.getByRole('button', { name: 'Save the change' }))
    expect(await screen.findByText(/nothing was saved/)).toBeInTheDocument()
    expect(screen.getByLabelText('Change the label')).toBeInTheDocument()
  })
})

describe('blind labelling: validation and controls', () => {
  it('requires a critique, a verdict and a name before the save button is enabled', async () => {
    const user = userEvent.setup()
    installFetch(routes())
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    const save = screen.getByRole('button', { name: 'Save and go to next' })
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

  it('keyboard: P, F and D choose, Ctrl+Enter saves from the text box, N skips, and the hint is visible', async () => {
    const user = userEvent.setup()
    const fake = installFetch(routes())
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    const hint = screen.getByText(/skip/i, { selector: 'span' })
    expect(hint.textContent).toMatch(/pass.*fail.*doesn't apply.*skip.*submit/)

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
    await screen.findByText(/Saved: fail for confirms-before-acting/)
    expect(fake.to('POST /api/labels')).toHaveLength(1)

    // Saving already moved on to the next item.
    expect(await screen.findByText('I can move it to 15:00. Shall I go ahead?')).toBeInTheDocument()
    expect(fake.calls.some(c => c.path.endsWith('/reveal'))).toBe(false)
  })

  it('remembers the labeler name in localStorage, and works when storage throws', async () => {
    const user = userEvent.setup()
    installFetch(routes())
    const first = renderApp('/classify')
    await screen.findByLabelText('Item to label')
    await user.click(screen.getByRole('button', { name: /^Pass/ }))
    await user.type(screen.getByLabelText('Your name'), 'Alex')
    await user.type(screen.getByLabelText('Critique (required)'), 'Fine.')
    await user.click(screen.getByRole('button', { name: 'Save and go to next' }))
    await screen.findByText(/Saved: /)
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
    await user.click(screen.getByRole('button', { name: 'Save and go to next' }))
    expect(await screen.findByText(/Saved: /)).toBeInTheDocument()
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
    installFetch(routes({ 'GET /api/queue': { body: queue({ stats: { candidates: 5, notApplicable: 0, pending: 2, queued: 2, labelled: 10, labelledRandom: 5, labelledRandomShare: 0.5, minRandomShare: 0.3, quotaMet: true, byCriterion: [] } }) } }))
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
    await user.click(screen.getByRole('button', { name: 'Save and go to next' }))
    expect(await screen.findByText(/already exists\. It is not in your queue any more/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next item' }))
    expect(await screen.findByText('I can move it to 15:00. Shall I go ahead?')).toBeInTheDocument()
  })

  it('shows the earlier conversation by default, and it can be hidden', async () => {
    const user = userEvent.setup()
    installFetch(routes({ 'GET /api/queue': { body: queue({ items: [queueItem({ context: [{ index: 0, role: 'user', content: 'EARLIER-USER-LINE' }, { index: 1, role: 'assistant', content: 'EARLIER-AGENT-LINE', toolCalls: [{ name: 'lookup', arguments: { a: 1 } }] }] })] }) } }))
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    expect(screen.getByText('EARLIER-AGENT-LINE')).toBeInTheDocument()
    expect(screen.getByText(/Judge the whole conversation, not only this reply/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Hide the earlier conversation' }))
    expect(screen.queryByText('EARLIER-AGENT-LINE')).toBeNull()
    expect(screen.getByRole('button', { name: /Show the earlier conversation \(2 turns, 1 tool call\)/ })).toBeInTheDocument()
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

describe("the Doesn't apply verdict", () => {
  const NA_ROUTE = 'POST /api/labels'
  const naText = 'Gives no medical advice. This does not apply if the caller never asks a medical question.'
  const naItem = () => queueItem({ criterion: { id: 'confirms-before-acting', text: naText, critical: false } })

  it('is chosen by clicking the button or pressing D', async () => {
    const user = userEvent.setup()
    installFetch(routes())
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    const na = screen.getByRole('button', { name: "Doesn't apply (D)" })
    expect(na).toHaveAttribute('aria-pressed', 'false')
    await user.click(na)
    expect(na).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /^Pass/ })).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByRole('button', { name: /^Pass/ }))
    expect(na).toHaveAttribute('aria-pressed', 'false')
    ;(document.activeElement as HTMLElement).blur()
    await user.keyboard('d')
    expect(na).toHaveAttribute('aria-pressed', 'true')
  })

  it('saves with an empty critique as not_applicable with the standard critique, and the critique label turns optional', async () => {
    const user = userEvent.setup()
    const fake = installFetch(routes({ [NA_ROUTE]: { status: 201, body: { label: savedLabel({ verdict: 'not_applicable', critique: NOT_APPLICABLE_CRITIQUE }) } }, 'GET /api/queue': { body: queue({ items: [naItem(), queueItem({ itemId: 'x:y' })] }) } }))
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    expect(screen.getByLabelText('Critique (required)')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: "Doesn't apply (D)" }))
    expect(screen.getByLabelText('Critique (optional)')).toHaveValue('')
    await user.type(screen.getByLabelText('Your name'), 'Sam')
    const save = screen.getByRole('button', { name: 'Save and go to next' })
    expect(save).toBeEnabled()
    await user.click(save)
    expect(await screen.findByText(/Saved: /)).toBeInTheDocument()
    expect(fake.to(NA_ROUTE)[0]!.body).toEqual({ itemId: 'run-fail-1:confirms-before-acting', labeler: 'Sam', verdict: 'not_applicable', critique: NOT_APPLICABLE_CRITIQUE })
  })

  it('sends a typed critique as it is when one is given', async () => {
    const user = userEvent.setup()
    const fake = installFetch(routes({ 'GET /api/queue': { body: queue({ items: [naItem(), queueItem({ itemId: 'x:y' })] }) } }))
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    await user.click(screen.getByRole('button', { name: "Doesn't apply (D)" }))
    await user.type(screen.getByLabelText('Critique (optional)'), 'No medical question came up.')
    await user.type(screen.getByLabelText('Your name'), 'Sam')
    await user.click(screen.getByRole('button', { name: 'Save and go to next' }))
    await waitFor(() => expect(fake.to(NA_ROUTE)).toHaveLength(1))
    expect(fake.to(NA_ROUTE)[0]!.body).toMatchObject({ verdict: 'not_applicable', critique: 'No medical question came up.' })
  })

  it('warns that a criterion always applies when its text has no "does not apply" condition', async () => {
    const user = userEvent.setup()
    installFetch(routes())
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    expect(screen.queryByText(/always applies/)).toBeNull()
    await user.click(screen.getByRole('button', { name: "Doesn't apply (D)" }))
    expect(screen.getByText(/has no "does not apply" condition, so it always applies/)).toBeInTheDocument()
    expect(screen.queryByText(/A critique is optional\./)).toBeNull()
  })

  it('shows the optional-critique hint instead of the warning when the criterion has a "does not apply" condition', async () => {
    const user = userEvent.setup()
    installFetch(routes({ 'GET /api/queue': { body: queue({ items: [naItem()] }) } }))
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    await user.click(screen.getByRole('button', { name: "Doesn't apply (D)" }))
    expect(screen.getByText(/A critique is optional\./)).toBeInTheDocument()
    expect(screen.queryByText(/always applies/)).toBeNull()
  })

  it('is offered in the Change my label form, and the revise request carries not_applicable', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(REVEAL_AFTER_KEY, 'on')
    const fake = installFetch(routes({ [REVISE_ROUTE]: { status: 201, body: { label: savedLabel({ id: 'run-fail-1:confirms-before-acting~r1', replaces: 'run-fail-1:confirms-before-acting', verdict: 'not_applicable', critique: NOT_APPLICABLE_CRITIQUE }) } } }))
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    await user.click(screen.getByRole('button', { name: /^Fail/ }))
    await user.type(screen.getByLabelText('Critique (required)'), 'It cancelled at once.')
    await user.type(screen.getByLabelText('Your name'), 'Sam')
    await user.click(screen.getByRole('button', { name: 'Save and show the judge' }))
    await user.click(await screen.findByRole('button', { name: 'Change my label (E)' }))
    const form = screen.getByLabelText('Change the label')
    await user.click(within(form).getByRole('button', { name: "Doesn't apply" }))
    expect(within(form).getByRole('button', { name: "Doesn't apply" })).toHaveAttribute('aria-pressed', 'true')
    await user.clear(within(form).getByLabelText(/^Critique/))
    await user.click(within(form).getByRole('button', { name: 'Save the change' }))
    await waitFor(() => expect(fake.to(REVISE_ROUTE)).toHaveLength(1))
    expect(fake.to(REVISE_ROUTE)[0]!.body).toEqual({ verdict: 'not_applicable', critique: NOT_APPLICABLE_CRITIQUE, labeler: 'Sam' })
  })
})

describe('RevealView for a "does not apply" label', () => {
  it('says the person said the criterion does not apply, instead of agree or disagree', () => {
    render(<RevealView reveal={reveal({ agrees: false, human: { verdict: 'not_applicable', critique: NOT_APPLICABLE_CRITIQUE, labeler: 'Sam', at: '2026-11-12T11:00:00.000Z' } })} />)
    expect(screen.getByText('You said this criterion does not apply.')).toBeInTheDocument()
    expect(screen.queryByText('You and the judge agree.')).toBeNull()
    expect(screen.queryByText('You and the judge disagree.')).toBeNull()
    expect(screen.getByText(JUDGE_CRITIQUE)).toBeInTheDocument()
  })
})

describe('canNotApply and validateLabel', () => {
  it('canNotApply finds a "does not apply" phrase, and treats unknown text as able to', () => {
    expect(canNotApply('Gives no medical advice.')).toBe(false)
    expect(canNotApply('Asks first. This does not apply if nothing changed.')).toBe(true)
    expect(canNotApply("Doesn't apply when no booking exists.")).toBe(true)
    expect(canNotApply('N/A: not applicable without a booking.')).toBe(true)
    expect(canNotApply('DOES NOT APPLY if silent')).toBe(true)
    expect(canNotApply(undefined)).toBe(true)
    expect(canNotApply(null)).toBe(true)
  })

  it('validateLabel names all three verdicts, and does not need a critique for not_applicable', () => {
    expect(validateLabel({ verdict: null, critique: 'x', labeler: 'Sam' }).verdict).toBe("Choose pass, fail or doesn't apply.")
    expect(validateLabel({ verdict: 'not_applicable', critique: '', labeler: 'Sam' })).toEqual({})
    expect(validateLabel({ verdict: 'fail', critique: '  ', labeler: 'Sam' }).critique).toBe('A critique is required on every label.')
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

  it('marks revised labels and changes a label inline', async () => {
    const user = userEvent.setup()
    const original = savedLabel({ verdict: 'pass', critique: 'Looked fine at first.' })
    const current = savedLabel({ id: `${original.id}~r1`, replaces: original.id, verdict: 'fail', critique: 'It cancelled at once.', at: '2026-11-12T12:00:00.000Z' })
    const listed = [current, labels[1]!]
    const fake = installFetch(routes({
      'GET /api/labels': { body: { file: 'f', labels: listed, history: { [original.id]: [original] }, stats: labelStatsFixture({ total: 2, labelers: ['Alex', 'Sam'], revisions: 1 }) } },
      [REVISE_ROUTE]: { status: 201, body: { label: savedLabel({ id: `${original.id}~r2`, replaces: current.id, verdict: 'pass', critique: 'Pass after all.' }) } },
      'POST /api/labels/hand-1/revise': { status: 201, body: { label: savedLabel({ id: 'hand-1~r1', replaces: 'hand-1' }) } },
    }))
    renderApp('/classify/labels')
    // The row shows the item id, with a badge, and the stats say how many were changed.
    expect(await screen.findByText(original.id)).toBeInTheDocument()
    expect(screen.queryByText(current.id)).toBeNull()
    expect(screen.getAllByText('Revised')).toHaveLength(1)
    expect(screen.getByText('1 changed after the first label')).toBeInTheDocument()

    const row = screen.getByText(original.id).closest('tr')!
    await user.click(within(row).getByRole('button', { name: 'Details' }))
    expect(screen.getByText(/First label, made blind, by Sam/)).toBeInTheDocument()
    expect(screen.getByText('Looked fine at first.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Change label' }))
    const form = screen.getByLabelText('Change the label')
    expect(within(form).getByLabelText('Critique (required)')).toHaveValue('It cancelled at once.')
    await user.click(within(form).getByRole('button', { name: 'Pass' }))
    await user.click(within(form).getByRole('button', { name: 'Save the change' }))
    await waitFor(() => expect(screen.queryByLabelText('Change the label')).toBeNull())
    expect(fake.to(REVISE_ROUTE)[0]!.body).toMatchObject({ verdict: 'pass', critique: 'It cancelled at once.' })
    // The list is fetched again so it shows the new version.
    await waitFor(() => expect(fake.to('GET /api/labels').length).toBeGreaterThan(1))
  })

  it('shows an empty state with no labels', async () => {
    installFetch(routes())
    renderApp('/classify/labels')
    expect(await screen.findByRole('heading', { name: 'No labels yet' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Labels')).toBeInTheDocument())
  })
})

describe('the evidence the judge sees, shown to the person labelling', () => {
  const item = queueItem({
    context: [
      { index: 0, role: 'user', content: 'Cancel Thursday please.' },
      { index: 1, role: 'assistant', content: 'Let me look.', toolCalls: [{ name: 'find_appointment', arguments: { day: 'Thursday' }, result: { status: 'found', id: 'appt-7' } }] },
      { index: 2, role: 'user', content: 'Yes, that one.' },
    ],
    outputTurn: 3,
    outputToolCalls: [{ name: 'cancel_appointment', arguments: { id: 'appt-7' }, result: { status: 'no_active_appointment', is_error: true } }],
    after: [{ index: 4, role: 'assistant', content: '', toolCalls: [{ name: 'log_event', arguments: {}, error: 'timeout' }] }],
    conversationDate: 'Sunday, 15 November 2026 (America/Toronto)',
  })

  it('shows the date, the judged reply\'s own tool calls with their results, the earlier calls, and turns after the reply', async () => {
    const user = userEvent.setup()
    installFetch(routes({ 'GET /api/queue': { body: queue({ items: [item] }) } }))
    renderApp('/classify')
    const panel = await screen.findByLabelText('Item to label')
    expect(within(panel).getByLabelText('Conversation date')).toHaveTextContent('The conversation took place on Sunday, 15 November 2026 (America/Toronto).')

    // The judged reply's call: name, arguments and the result's status at a glance, in an error style.
    const calls = within(panel).getByLabelText('Tool calls in the reply being judged')
    const head = within(calls).getByRole('button', { name: /Tool call: cancel_appointment/ })
    expect(head).toHaveTextContent('{"id":"appt-7"}')
    const badge = within(head).getByText('no_active_appointment')
    expect(badge).toHaveClass('badge-fail')
    expect(head.closest('.toolcall')).toHaveClass('toolcall-failed')
    // The full result is one click away.
    expect(within(panel).queryByLabelText('Result of cancel_appointment')).toBeNull()
    await user.click(head)
    expect(within(panel).getByLabelText('Result of cancel_appointment').textContent).toContain('"is_error": true')

    // A turn after the reply, with its error shown in the error style.
    expect(within(panel).getByText('After the reply')).toBeInTheDocument()
    expect(within(panel).getByText('timeout')).toHaveClass('toolcall-error')

    // The earlier turns' calls and results.
    // The earlier conversation is open by default.
    const earlier = within(panel).getByRole('button', { name: /Tool call: find_appointment/ })
    expect(within(earlier).getByText('found')).not.toHaveClass('badge-fail')
    await user.click(earlier)
    expect(within(panel).getByLabelText('Result of find_appointment').textContent).toContain('"id": "appt-7"')
  })

  it('shows no date line when the date is unknown', async () => {
    installFetch(routes({ 'GET /api/queue': { body: queue({ items: [queueItem({ conversationDate: null })] }) } }))
    renderApp('/classify')
    const panel = await screen.findByLabelText('Item to label')
    expect(within(panel).queryByLabelText('Conversation date')).toBeNull()
    expect(within(panel).queryByLabelText('Tool calls in the reply being judged')).toBeNull()
  })

  it('in the labels list, loads the whole conversation of a label made from a run, with the date and tool results', async () => {
    const user = userEvent.setup()
    const labels: Label[] = [savedLabel(), savedLabel({ id: 'hand-1', group: undefined, criterion: 'no-medical-advice', at: '2026-11-11T11:00:00.000Z' })]
    const fake = installFetch(routes({
      'GET /api/labels': { body: { file: 'f', labels, stats: labelStatsFixture({ total: 2 }) } },
      'GET /api/runs/run-fail-1': { body: { suiteId: 's3', result: failingRun(), conversationDate: 'Thursday, 12 November 2026 (UTC)' } },
    }))
    renderApp('/classify/labels')
    await screen.findByText('hand-1')
    // The hand-written label has no run to show.
    await user.click(screen.getAllByRole('button', { name: 'Details' })[1]!)
    expect(screen.queryByRole('button', { name: 'Show the whole conversation the judge sees' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Hide' }))

    await user.click(screen.getAllByRole('button', { name: 'Details' })[0]!)
    expect(fake.calls.some(c => c.path.startsWith('/api/runs/'))).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Show the whole conversation the judge sees' }))
    const whole = await screen.findByLabelText('The whole conversation')
    expect(within(whole).getByText('The conversation took place on Thursday, 12 November 2026 (UTC).')).toBeInTheDocument()
    expect(within(whole).getByText('Sorry, it is already done.')).toBeInTheDocument()
    const head = within(whole).getByRole('button', { name: /Tool call: cancel_appointment/ })
    expect(within(head).getByText('Result')).toBeInTheDocument()
  })

  it('in the labels list, says so when the run is gone', async () => {
    const user = userEvent.setup()
    installFetch(routes({
      'GET /api/labels': { body: { file: 'f', labels: [savedLabel()], stats: labelStatsFixture({ total: 1 }) } },
      'GET /api/runs/run-fail-1': failure(404, 'not_found', 'No run "run-fail-1".'),
    }))
    renderApp('/classify/labels')
    await user.click(await screen.findByRole('button', { name: 'Details' }))
    await user.click(screen.getByRole('button', { name: 'Show the whole conversation the judge sees' }))
    expect(await screen.findByText(/The run is not saved here any more/)).toBeInTheDocument()
  })
})
