import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Label, LabelSuggestionsResponse, QueueItem, QueueStats } from '../../src/ui/api-types'
import { chipText, criterionOfItem, criterionOptions, insertSuggestion, nextCriterion } from '../src/pages/ClassifyPage'
import { baseRoutes, installEventSource, installFetch, renderApp, type Call, type Reply } from './fake-api'
import { JUDGE_CRITIQUE, queue, queueItem, reveal } from './fixtures'

beforeEach(() => installEventSource())

// Two criteria. "asks-first" has two items, "no-advice" one (critical). The fake server filters the way the real one
// does: after the plan, keeping the order.
const A1 = queueItem({ itemId: 'run-a:asks-first', runId: 'run-a', group: 'run-a', scenarioId: 'billing', output: 'OUTPUT-A1', reason: 'targeted-failure', criterion: { id: 'asks-first', text: 'TEXT-ASKS-FIRST: asks before acting.', critical: false } })
const N1 = queueItem({ itemId: 'run-b:no-advice', runId: 'run-b', group: 'run-b', scenarioId: 'billing', output: 'OUTPUT-N1', reason: 'random', criterion: { id: 'no-advice', text: 'TEXT-NO-ADVICE: gives no medical advice.', critical: true } })
const A2 = queueItem({ itemId: 'run-c:asks-first', runId: 'run-c', group: 'run-c', scenarioId: 'support', output: 'OUTPUT-A2', reason: 'random', criterion: { id: 'asks-first', text: 'TEXT-ASKS-FIRST: asks before acting.', critical: false } })

function statsFor(items: QueueItem[], over: Partial<QueueStats> = {}): QueueStats {
  const counts = new Map<string, number>()
  for (const i of items) counts.set(i.criterion.id, (counts.get(i.criterion.id) ?? 0) + 1)
  return {
    candidates: 10, notApplicable: 0, pending: items.length, queued: items.length, labelled: 5, labelledRandom: 1, labelledRandomShare: 0.2, minRandomShare: 0.3, quotaMet: false,
    byCriterion: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([id, pending]) => ({ id, pending })),
    ...over,
  }
}

/** A queue route over a mutable list, filtered by `criterion` like the server. */
function queueRoute(state: { items: QueueItem[] }) {
  return (call: Call): Reply => {
    const c = call.query.get('criterion')
    const items = c ? state.items.filter(i => i.criterion.id === c) : state.items
    return { body: queue({ items, stats: { ...statsFor(state.items), queued: items.length } }) }
  }
}

function savedLabel(item: QueueItem, over: Partial<Label> = {}): Label {
  return { id: item.itemId, group: item.group, criterion: item.criterion.id, output: item.output, verdict: 'fail', critique: 'c', labeler: 'Sam', sampled_by: 'targeted', at: '2026-11-12T11:00:00.000Z', ...over }
}

const queueCalls = (fake: ReturnType<typeof installFetch>) => fake.to('GET /api/queue').map(c => c.query.get('criterion'))

describe('criterion mode helpers', () => {
  it('lists criteria with items left by id, keeping a chosen one at 0', () => {
    const by = [{ id: 'b', pending: 2 }, { id: 'a', pending: 14 }, { id: 'c', pending: 0 }]
    expect(criterionOptions(by, null).map(o => o.label)).toEqual(['a (14 left)', 'b (2 left)'])
    expect(criterionOptions(by, 'zz').map(o => o.label)).toEqual(['a (14 left)', 'b (2 left)', 'zz (0 left)'])
    expect(criterionOptions(by, 'c').map(o => o.label)).toEqual(['a (14 left)', 'b (2 left)', 'c (0 left)'])
  })

  it('offers the next criterion by id with items left, wrapping round', () => {
    const by = [{ id: 'a', pending: 1 }, { id: 'b', pending: 0 }, { id: 'c', pending: 3 }]
    expect(nextCriterion(by, 'a')).toEqual({ id: 'c', pending: 3 })
    expect(nextCriterion(by, 'b')).toEqual({ id: 'c', pending: 3 })
    expect(nextCriterion(by, 'c')).toEqual({ id: 'a', pending: 1 })
    expect(nextCriterion(by, null)).toEqual({ id: 'a', pending: 1 })
    expect(nextCriterion([{ id: 'a', pending: 2 }], 'a')).toBeNull()
    expect(nextCriterion([], 'a')).toBeNull()
  })

  it('reads the criterion from an item id', () => {
    expect(criterionOfItem('run-a:asks-first')).toBe('asks-first')
    expect(criterionOfItem('run-a:x:y')).toBe('x:y')
    expect(criterionOfItem('nocolon')).toBeNull()
    expect(criterionOfItem(':x')).toBeNull()
    expect(criterionOfItem(undefined)).toBeNull()
  })
})

describe('one criterion at a time', () => {
  it('defaults to mixed, and switching asks the server for one criterion, pins its text and remembers the mode', async () => {
    const user = userEvent.setup()
    const state = { items: [A1, N1, A2] }
    const fake = installFetch(baseRoutes({ 'GET /api/queue': queueRoute(state) }))
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    const modes = screen.getByRole('group', { name: 'Labelling mode' })
    expect(within(modes).getByRole('button', { name: 'Mixed' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByLabelText('Criterion')).toBeNull()
    expect(queueCalls(fake)).toEqual([null])

    await user.click(within(modes).getByRole('button', { name: 'One criterion at a time' }))
    expect(within(modes).getByRole('button', { name: 'One criterion at a time' })).toHaveAttribute('aria-pressed', 'true')
    const select = await screen.findByLabelText('Criterion')
    // Every criterion with items left, with counts, by id. The first is chosen.
    expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['asks-first (2 left)', 'no-advice (1 left)'])
    expect(select).toHaveValue('asks-first')
    await waitFor(() => expect(queueCalls(fake)).toContain('asks-first'))

    // The criterion is pinned at the top, and each item no longer repeats it.
    const pin = await screen.findByRole('region', { name: 'Criterion to judge' })
    expect(within(pin).getByText('TEXT-ASKS-FIRST: asks before acting.')).toBeInTheDocument()
    expect(within(pin).getByRole('link', { name: 'View or edit this criterion' })).toBeInTheDocument()
    const item = screen.getByLabelText('Item to label')
    expect(within(item).queryByText(/TEXT-ASKS-FIRST/)).toBeNull()
    expect(within(item).getByText('scenario billing')).toBeInTheDocument()
    expect(within(screen.getByLabelText('Jump to an item', { selector: 'select' })).getAllByRole('option')).toHaveLength(2)
    expect(screen.getByText(/2 up for review for this criterion, 3 in total/)).toBeInTheDocument()

    expect(window.localStorage.getItem('evals-ui-classify-mode')).toBe('criterion')
    expect(window.location.hash).toBe('#/classify?criterion=asks-first')

    // Another criterion: a fresh list, with its own pinned text and Critical flag.
    await user.selectOptions(select, 'no-advice')
    expect(await within(screen.getByRole('region', { name: 'Criterion to judge' })).findByText('TEXT-NO-ADVICE: gives no medical advice.')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Criterion to judge' })).getByText(/critical/i)).toBeInTheDocument()
    expect(screen.getAllByText('OUTPUT-N1').length).toBeGreaterThan(0)
    expect(screen.queryByText('OUTPUT-A1')).toBeNull()
    expect(window.location.hash).toBe('#/classify?criterion=no-advice')

    // Back to mixed: everything again, and the address loses the criterion.
    await user.click(within(modes).getByRole('button', { name: 'Mixed' }))
    expect(await screen.findByText('TEXT-ASKS-FIRST: asks before acting.')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Criterion to judge' })).toBeNull()
    expect(window.localStorage.getItem('evals-ui-classify-mode')).toBe('mixed')
    expect(window.location.hash).toBe('#/classify')
  })

  it('keeps the queue\'s own order within a criterion and never shows the reason or the judge', async () => {
    const state = { items: [A1, N1, A2] }
    installFetch(baseRoutes({ 'GET /api/queue': queueRoute(state) }))
    const { container } = renderApp('/classify?criterion=asks-first')
    await screen.findByLabelText('Item to label')
    // A1 comes first because the server sent it first, whatever its reason.
    expect(screen.getAllByText('OUTPUT-A1').length).toBeGreaterThan(0)
    expect(container.innerHTML).not.toMatch(/targeted/i)
    expect(container.innerHTML).not.toContain(JUDGE_CRITIQUE)
  })

  it('opens on the criterion named in the address, whatever mode was remembered', async () => {
    window.localStorage.setItem('evals-ui-classify-mode', 'mixed')
    const state = { items: [A1, N1, A2] }
    const fake = installFetch(baseRoutes({ 'GET /api/queue': queueRoute(state) }))
    renderApp('/classify?criterion=no-advice')
    expect(await screen.findByText('OUTPUT-N1')).toBeInTheDocument()
    expect(queueCalls(fake)[0]).toBe('no-advice')
    expect(screen.getByLabelText('Criterion')).toHaveValue('no-advice')
    expect(screen.getByRole('button', { name: 'One criterion at a time' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('remembers the mode, and starts on the first criterion with items when none is named', async () => {
    window.localStorage.setItem('evals-ui-classify-mode', 'criterion')
    const state = { items: [N1, A1, A2] }
    const fake = installFetch(baseRoutes({ 'GET /api/queue': queueRoute(state) }))
    renderApp('/classify')
    expect(await screen.findByRole('region', { name: 'Criterion to judge' })).toBeInTheDocument()
    expect(await screen.findByText('OUTPUT-A1')).toBeInTheDocument()
    // The mixed list (fetched only to learn the criteria) was never shown as the item.
    expect(queueCalls(fake)).toEqual([null, 'asks-first'])
    expect(screen.getByLabelText('Criterion')).toHaveValue('asks-first')
  })

  it('composes with item=, and the item wins for the current item', async () => {
    const state = { items: [A1, N1, A2] }
    installFetch(baseRoutes({ 'GET /api/queue': queueRoute(state) }))
    renderApp('/classify?criterion=asks-first&item=run-c%3Aasks-first')
    expect(await screen.findByText('OUTPUT-A2')).toBeInTheDocument()
    expect(screen.getByLabelText('Jump to an item', { selector: 'select' })).toHaveValue('run-c:asks-first')
    expect(screen.getByLabelText('Criterion')).toHaveValue('asks-first')
  })

  it('opens the item\'s own criterion when the two disagree', async () => {
    const state = { items: [A1, N1, A2] }
    installFetch(baseRoutes({ 'GET /api/queue': queueRoute(state) }))
    renderApp('/classify?criterion=asks-first&item=run-b%3Ano-advice')
    expect(await screen.findByText('OUTPUT-N1')).toBeInTheDocument()
    expect(screen.getByLabelText('Criterion')).toHaveValue('no-advice')
    expect(screen.queryByText(/not in the review queue/)).toBeNull()
  })

  it('says when a criterion runs out and offers the next one with items left', async () => {
    const user = userEvent.setup()
    const state = { items: [A1, N1] }
    const fake = installFetch(baseRoutes({
      'GET /api/queue': queueRoute(state),
      'POST /api/labels': (call: Call) => {
        const id = (call.body as { itemId: string }).itemId
        const item = state.items.find(i => i.itemId === id)!
        state.items = state.items.filter(i => i.itemId !== id)
        return { status: 201, body: { label: savedLabel(item) } }
      },
    }))
    renderApp('/classify?criterion=asks-first')
    await screen.findByText('OUTPUT-A1')
    await user.click(screen.getByRole('button', { name: /^Fail/ }))
    await user.type(screen.getByLabelText('Critique (required)'), 'c')
    await user.type(screen.getByLabelText('Your name'), 'Sam')
    await user.click(screen.getByRole('button', { name: 'Save label' }))
    await screen.findByText('Label saved.')
    await user.click(screen.getByRole('button', { name: 'Next item' }))

    const done = await screen.findByRole('status', { name: 'Criterion done' })
    expect(within(done).getByText(/Nothing for/)).toHaveTextContent('Nothing for asks-first is up for review right now.')
    await user.click(within(done).getByRole('button', { name: 'Next criterion: no-advice (1 left)' }))
    expect(await screen.findByText('OUTPUT-N1')).toBeInTheDocument()
    expect(screen.getByLabelText('Criterion')).toHaveValue('no-advice')
    expect(queueCalls(fake).at(-1)).toBe('no-advice')
  })

  it('handles an unknown criterion in the address by offering one that has items', async () => {
    const state = { items: [A1] }
    installFetch(baseRoutes({ 'GET /api/queue': queueRoute(state) }))
    renderApp('/classify?criterion=asks-first-typo')
    const done = await screen.findByRole('status', { name: 'Criterion done' })
    expect(within(done).getByRole('button', { name: 'Next criterion: asks-first (1 left)' })).toBeInTheDocument()
    // The select keeps the unknown value, at 0.
    expect(within(screen.getByLabelText('Criterion')).getAllByRole('option').map(o => o.textContent)).toEqual(['asks-first (1 left)', 'asks-first-typo (0 left)'])
  })

  it('says so when no other criterion has items left', async () => {
    const state = { items: [A1] }
    installFetch(baseRoutes({ 'GET /api/queue': (call: Call): Reply => ({ body: queue({ items: call.query.get('criterion') === 'asks-first' ? [] : state.items, stats: statsFor([]) }) }) }))
    renderApp('/classify?criterion=asks-first')
    const done = await screen.findByRole('status', { name: 'Criterion done' })
    expect(within(done).getByText(/No other criterion has items up for review/)).toBeInTheDocument()
    expect(within(done).queryByRole('button')).toBeNull()
  })

  it('asks before switching criterion with a draft, and stays put on no', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false)
    const state = { items: [A1, N1, A2] }
    installFetch(baseRoutes({ 'GET /api/queue': queueRoute(state) }))
    renderApp('/classify?criterion=asks-first')
    await screen.findByText('OUTPUT-A1')
    await user.type(screen.getByLabelText('Critique (required)'), 'Half written')
    await user.selectOptions(screen.getByLabelText('Criterion'), 'no-advice')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('Critique (required)')).toHaveValue('Half written')
    expect(screen.getAllByText('OUTPUT-A1').length).toBeGreaterThan(0)
  })
})

// ------------------------------------------------------------ quick critiques

const REVEAL_ROUTE = 'GET /api/labels/run-a%3Aasks-first/reveal'

function suggestionsRoute(map: Record<string, LabelSuggestionsResponse>) {
  return (call: Call): Reply => ({ body: map[`${call.query.get('criterion')}/${call.query.get('verdict')}`] ?? { suggestions: [], fromOtherLabelers: false } })
}

const LONG = `Asked nothing before moving the appointment, and then said it was done, which is exactly what this criterion forbids.`

function chipRoutes(over = {}) {
  return baseRoutes({
    'GET /api/queue': { body: queue({ items: [A1, A2], stats: statsFor([A1, A2]) }) },
    'GET /api/labels/suggestions': suggestionsRoute({
      'asks-first/fail': { suggestions: ['Acted without asking.', LONG, 'Never confirmed.'], fromOtherLabelers: false },
      'asks-first/pass': { suggestions: ['Asked first.'], fromOtherLabelers: true },
    }),
    'POST /api/labels': { status: 201, body: { label: savedLabel(A1, { critique: 'Acted without asking.' }) } },
    [REVEAL_ROUTE]: { body: reveal({ labelId: A1.itemId, runId: 'run-a', human: { verdict: 'fail', critique: 'Acted without asking.', labeler: 'Sam', at: '2026-11-12T11:00:00.000Z' } }) },
    ...over,
  })
}

describe('quick critiques', () => {
  it('helpers: truncate with the full text kept, and fill an empty box or add a new line', () => {
    expect(chipText('short')).toBe('short')
    expect(chipText(LONG).length).toBeLessThanOrEqual(60)
    expect(chipText(LONG).endsWith('…')).toBe(true)
    expect(insertSuggestion('', 'A.')).toBe('A.')
    expect(insertSuggestion('  \n', 'A.')).toBe('A.')
    expect(insertSuggestion('Mine.\n\n', 'A.')).toBe('Mine.\nA.')
  })

  it('appear only after a verdict, for that verdict, and fetch with the criterion, verdict and labeler', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem('evals-ui-labeler', 'Sam')
    const fake = installFetch(chipRoutes())
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    expect(screen.queryByRole('group', { name: 'Quick critiques' })).toBeNull()
    expect(fake.to('GET /api/labels/suggestions')).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: /^Fail/ }))
    const chips = await screen.findByRole('group', { name: 'Quick critiques' })
    expect(within(chips).getAllByRole('button').map(b => b.getAttribute('title'))).toEqual(['Acted without asking.', LONG, 'Never confirmed.'])
    // The long one is cut short on the button, with the whole text in the title.
    const long = within(chips).getByRole('button', { name: LONG })
    expect(long.textContent).toBe(`2${chipText(LONG)}`)
    expect(within(chips).getByText('Your earlier critiques:')).toBeInTheDocument()
    const q = fake.to('GET /api/labels/suggestions')[0]!.query
    expect([q.get('criterion'), q.get('verdict'), q.get('labeler'), q.get('exclude')]).toEqual(['asks-first', 'fail', 'Sam', null])
    expect(screen.getByText(/quick critique/, { selector: 'span' })).toBeInTheDocument()

    // The other verdict has its own, from other labelers.
    await user.click(screen.getByRole('button', { name: /^Pass/ }))
    const pass = await screen.findByRole('group', { name: 'Quick critiques' })
    await waitFor(() => expect(within(pass).getAllByRole('button').map(b => b.getAttribute('title'))).toEqual(['Asked first.']))
    expect(within(pass).getByText('Earlier critiques from other labelers:')).toBeInTheDocument()
  })

  it('shows no chips when there are none, and nothing breaks when the request fails', async () => {
    const user = userEvent.setup()
    installFetch(chipRoutes({ 'GET /api/labels/suggestions': { status: 500, body: { error: { code: 'internal', message: 'x' } } } }))
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    await user.click(screen.getByRole('button', { name: /^Fail/ }))
    await new Promise(r => setTimeout(r, 20))
    expect(screen.queryByRole('group', { name: 'Quick critiques' })).toBeNull()
    expect(screen.queryByText(/quick critique/)).toBeNull()
  })

  it('a click fills an empty box, adds a new line after text, and the box stays editable', async () => {
    const user = userEvent.setup()
    installFetch(chipRoutes())
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    await user.click(screen.getByRole('button', { name: /^Fail/ }))
    const box = screen.getByLabelText('Critique (required)')
    await user.click(await screen.findByRole('button', { name: 'Acted without asking.' }))
    expect(box).toHaveValue('Acted without asking.')
    expect(box).toHaveFocus()
    await user.type(box, ' In [[1].')
    expect(box).toHaveValue('Acted without asking. In [1].')
    await user.click(screen.getByRole('button', { name: 'Never confirmed.' }))
    expect(box).toHaveValue('Acted without asking. In [1].\nNever confirmed.')
  })

  it('keys 1 to 4 insert a chip outside text fields, and type digits inside the critique box', async () => {
    const user = userEvent.setup()
    installFetch(chipRoutes())
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    await user.click(screen.getByRole('button', { name: /^Fail/ }))
    await screen.findByRole('group', { name: 'Quick critiques' })
    const box = screen.getByLabelText('Critique (required)')
    // Focus is on the Fail button, outside any text field.
    await user.keyboard('3')
    expect(box).toHaveValue('Never confirmed.')
    // Inserting moves focus into the box, where digits are text.
    expect(box).toHaveFocus()
    await user.keyboard('12')
    expect(box).toHaveValue('Never confirmed.12')
    // A key with no chip does nothing.
    ;(document.activeElement as HTMLElement).blur()
    await user.keyboard('4')
    expect(box).toHaveValue('Never confirmed.12')
    await user.keyboard('1')
    expect(box).toHaveValue('Never confirmed.12\nActed without asking.')
    // The name field is a text field too.
    await user.type(screen.getByLabelText('Your name'), 'S2')
    expect(screen.getByLabelText('Your name')).toHaveValue('S2')
    expect(box).toHaveValue('Never confirmed.12\nActed without asking.')
  })

  it('are offered in the Change my label form, without the item\'s own critique', async () => {
    const user = userEvent.setup()
    const fake = installFetch(chipRoutes())
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    await user.click(screen.getByRole('button', { name: /^Fail/ }))
    await user.type(screen.getByLabelText('Critique (required)'), 'Acted without asking.')
    await user.type(screen.getByLabelText('Your name'), 'Sam')
    await user.click(screen.getByRole('button', { name: 'Save label' }))
    await user.click(await screen.findByRole('button', { name: 'Reveal what the judge said' }))
    await user.click(await screen.findByRole('button', { name: 'Change my label (E)' }))
    const form = screen.getByLabelText('Change the label')
    // Pre-filled with fail, so the fail chips show at once.
    const chips = await within(form).findByRole('group', { name: 'Quick critiques' })
    const last = fake.to('GET /api/labels/suggestions').at(-1)!.query
    expect([last.get('criterion'), last.get('verdict'), last.get('exclude')]).toEqual(['asks-first', 'fail', 'run-a:asks-first'])
    expect(screen.getByText(/quick critique/, { selector: 'span' })).toBeInTheDocument()
    const box = within(form).getByLabelText('Critique (required)')
    await user.click(within(chips).getByRole('button', { name: 'Never confirmed.' }))
    expect(box).toHaveValue('Acted without asking.\nNever confirmed.')
    // Keys work here too once focus leaves the box, and the verdict switch brings that verdict's chips.
    await user.click(within(form).getByRole('button', { name: 'Pass' }))
    await waitFor(() => expect(within(form).getAllByRole('button', { name: 'Asked first.' })).toHaveLength(1))
    await user.keyboard('1')
    expect(box).toHaveValue('Acted without asking.\nNever confirmed.\nAsked first.')
  })
})
