import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueueItem, QueueReason } from '../../src/ui/api-types'
import { applyDeepLink, hasDraft, moveToFront, pickerGroups, pickerLabel, pickerPosition, shortRunId, sortForPicker } from '../src/pages/ClassifyPage'
import { baseRoutes, installEventSource, installFetch, renderApp } from './fake-api'
import { JUDGE_CRITIQUE, queue, queueItem } from './fixtures'

beforeEach(() => installEventSource())

const RUN_A = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN_B = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const RUN_C = '33333333-cccc-4ccc-8ccc-cccccccccccc'

function make(runId: string, scenarioId: string, criterionId: string, startedAt: string, reason: QueueReason, critical = false): QueueItem {
  return queueItem({
    itemId: `${runId}:${criterionId}`,
    runId,
    group: runId,
    scenarioId,
    startedAt,
    criterion: { id: criterionId, text: `Text of ${criterionId}`, critical },
    output: `Output of ${runId} ${criterionId}`,
    reason,
  })
}

const REASONS: QueueReason[] = ['random', 'targeted-failure', 'targeted-error']

function sample(reasons: QueueReason[] = REASONS): QueueItem[] {
  return [
    make(RUN_B, 'zeta-scenario', 'asks-first', '2026-11-12T12:00:00.000Z', reasons[0]!),
    make(RUN_A, 'alpha-scenario', 'no-advice', '2026-11-12T10:00:00.000Z', reasons[1]!, true),
    make(RUN_C, 'alpha-scenario', 'asks-first', '2026-11-12T11:00:00.000Z', reasons[2]!),
    make(RUN_A, 'alpha-scenario', 'asks-first', '2026-11-12T10:00:00.000Z', reasons[0]!),
    make(RUN_B, 'alpha-scenario', 'asks-first', '2026-11-12T09:00:00.000Z', reasons[1]!),
  ]
}

describe('picker helpers', () => {
  it('sorts by scenario id, then criterion id, then run time, and groups by scenario', () => {
    const groups = pickerGroups(sample())
    expect(groups.map(g => g.scenarioId)).toEqual(['alpha-scenario', 'zeta-scenario'])
    expect(groups[0]!.entries.map(e => e.itemId)).toEqual([
      `${RUN_B}:asks-first`, // 09:00
      `${RUN_A}:asks-first`, // 10:00
      `${RUN_C}:asks-first`, // 11:00
      `${RUN_A}:no-advice`,
    ])
  })

  it('does not depend on the reason: every assignment of reasons gives the same order and the same text', () => {
    const base = pickerGroups(sample())
    for (const a of REASONS) {
      for (const b of REASONS) {
        for (const c of REASONS) {
          expect(pickerGroups(sample([a, b, c]))).toEqual(base)
        }
      }
    }
    // Nor does it depend on the order the server sent the items in.
    expect(pickerGroups([...sample()].reverse())).toEqual(base)
    expect(pickerGroups(sample()).flatMap(g => g.entries.map(e => e.itemId))).toEqual(sortForPicker(sample()).map(i => i.itemId))
  })

  it('has no reason and no judge field in any entry text or in the whole structure', () => {
    const json = JSON.stringify(pickerGroups(sample()))
    for (const reason of REASONS) expect(json).not.toContain(reason)
    expect(json).not.toMatch(/targeted|reason|verdict|critique|judge/i)
    expect(json).not.toContain(JUDGE_CRITIQUE)
    expect(Object.keys(pickerGroups(sample())[0]!.entries[0]!).sort()).toEqual(['itemId', 'label', 'scenarioId'])
  })

  it('tells several runs of one scenario apart by short run id and date, and marks a critical criterion', () => {
    const labels = pickerGroups(sample())[0]!.entries.map(e => e.label)
    expect(new Set(labels).size).toBe(labels.length)
    expect(labels[0]).toContain('run 22222222')
    expect(labels[1]).toContain('run 11111111')
    expect(labels[3]).toContain('(Critical)')
    expect(labels[0]).not.toContain('(Critical)')
    expect(shortRunId(RUN_A)).toBe('11111111')
    expect(pickerLabel(make(RUN_A, 's', 'c', '', 'random'))).toBe('c · run 11111111')
  })

  it('filters by words in the scenario or the label, and always keeps the current item', () => {
    const ids = (f: string, keep?: string) => pickerGroups(sample(), f, keep).flatMap(g => g.entries.map(e => e.itemId))
    expect(ids('zeta')).toEqual([`${RUN_B}:asks-first`])
    expect(ids('alpha no-advice')).toEqual([`${RUN_A}:no-advice`])
    expect(ids('22222222')).toEqual([`${RUN_B}:asks-first`, `${RUN_B}:asks-first`])
    expect(ids('nothing matches this')).toEqual([])
    expect(ids('nothing matches this', `${RUN_C}:asks-first`)).toEqual([`${RUN_C}:asks-first`])
  })

  it('reports the position in the picker order, and null when the item is not loaded', () => {
    const items = sample()
    expect(pickerPosition(items, `${RUN_B}:asks-first`)).toEqual({ n: 1, of: 5 })
    expect(pickerPosition(items, `${RUN_B}:asks-first`)).toEqual({ n: 1, of: 5 })
    expect(pickerPosition(items, 'nope')).toBeNull()
  })

  it('moves an item to the front without losing the others, and applies a deep link only to a listed item', () => {
    const items = sample()
    const moved = moveToFront(items, items[3]!.itemId)
    expect(moved.map(i => i.itemId)).toEqual([items[3]!, items[0]!, items[1]!, items[2]!, items[4]!].map(i => i.itemId))
    expect(moveToFront(items, items[0]!.itemId)).toBe(items)
    expect(applyDeepLink(items, items[2]!.itemId)).toMatchObject({ found: true })
    expect(applyDeepLink(items, items[2]!.itemId).items[0]).toBe(items[2])
    expect(applyDeepLink(items, 'gone:thing')).toEqual({ items, found: false })
    expect(applyDeepLink(items, undefined)).toEqual({ items, found: false })
    expect(applyDeepLink(items, '').found).toBe(false)
  })

  it('treats a chosen verdict or a non-blank critique as a draft', () => {
    expect(hasDraft({ verdict: null, critique: '' })).toBe(false)
    expect(hasDraft({ verdict: null, critique: '   ' })).toBe(false)
    expect(hasDraft({ verdict: 'pass', critique: '' })).toBe(true)
    expect(hasDraft({ verdict: null, critique: 'x' })).toBe(true)
  })
})

const A = queueItem({ itemId: 'run-a:crit-1', runId: 'run-a', group: 'run-a', scenarioId: 'billing', output: 'OUTPUT-A', reason: 'targeted-failure' })
const B = queueItem({ itemId: 'run-b:crit-1', runId: 'run-b', group: 'run-b', scenarioId: 'billing', output: 'OUTPUT-B', reason: 'random', startedAt: '2026-11-12T11:00:00.000Z' })
const C = queueItem({ itemId: 'run-c:crit-2', runId: 'run-c', group: 'run-c', scenarioId: 'support', output: 'OUTPUT-C', reason: 'targeted-error', criterion: { id: 'crit-2', text: 'Second criterion', critical: true } })

function routes(over = {}) {
  return baseRoutes({
    'GET /api/queue': { body: queue({ items: [A, B, C], stats: { candidates: 10, notApplicable: 0, pending: 3, queued: 3, labelled: 5, labelledRandom: 1, labelledRandomShare: 0.2, minRandomShare: 0.3, quotaMet: false, byCriterion: [] } }) },
    ...over,
  })
}

describe('Jump to an item', () => {
  it('asks the server for the whole queue (limit 200), and lists exactly its items by scenario', async () => {
    const fake = installFetch(routes())
    renderApp('/classify')
    const picker = await screen.findByLabelText('Jump to an item', { selector: 'select' })
    expect(fake.to('GET /api/queue')[0]!.query.get('limit')).toBe('200')
    const groups = within(picker).getAllByRole('group')
    expect(groups.map(g => g.getAttribute('label'))).toEqual(['billing', 'support'])
    expect(within(picker).getAllByRole('option')).toHaveLength(3)
    expect(within(picker).getByRole('option', { name: /crit-2 \(Critical\) · run run-c/ })).toBeInTheDocument()
  })

  it('shows Item N of M next to the progress text, and keeps the batch text accurate', async () => {
    installFetch(routes())
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    expect(screen.getByText(/Item 1 of 3 .* 0 labelled this session, 3 left in this batch, 3 up for review in total/)).toBeInTheDocument()
  })

  it('makes the chosen item current, keeps the others, and resets the form', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm')
    installFetch(routes())
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    expect(screen.getAllByText('OUTPUT-A').length).toBeGreaterThan(0)
    await user.selectOptions(screen.getByLabelText('Jump to an item', { selector: 'select' }), 'run-c:crit-2')
    expect(confirm).not.toHaveBeenCalled() // nothing typed, nothing to lose
    expect(await screen.findByText('OUTPUT-C')).toBeInTheDocument()
    expect(screen.queryByText('OUTPUT-A')).toBeNull()
    expect(screen.getByLabelText('Jump to an item', { selector: 'select' })).toHaveValue('run-c:crit-2')
    expect(within(screen.getByLabelText('Jump to an item', { selector: 'select' })).getAllByRole('option')).toHaveLength(3)
    expect(screen.getByText(/Item 3 of 3 .* 3 left in this batch/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Pass/ })).toHaveAttribute('aria-pressed', 'false')
    // The item it left is still there, right behind it. The picker has focus, so blur it for the shortcut.
    ;(document.activeElement as HTMLElement).blur()
    await user.keyboard('n')
    expect(await screen.findByText('OUTPUT-A')).toBeInTheDocument()
  })

  it('asks before throwing a draft away, and keeps it when the person says no', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    installFetch(routes())
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    await user.click(screen.getByRole('button', { name: /^Fail/ }))
    await user.type(screen.getByLabelText('Critique (required)'), 'Half written')
    const select = screen.getByLabelText('Jump to an item', { selector: 'select' })

    await user.selectOptions(select, 'run-b:crit-1')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(screen.getAllByText('OUTPUT-A').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Critique (required)')).toHaveValue('Half written')
    expect(select).toHaveValue('run-a:crit-1')

    await user.selectOptions(select, 'run-b:crit-1')
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(await screen.findByText('OUTPUT-B')).toBeInTheDocument()
    expect(screen.getByLabelText('Critique (required)')).toHaveValue('')
    expect(screen.getByRole('button', { name: /^Fail/ })).toHaveAttribute('aria-pressed', 'false')
  })

  it('does not fire the shortcuts while the picker has focus, and they work again after', async () => {
    const user = userEvent.setup()
    installFetch(routes())
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    const select = screen.getByLabelText('Jump to an item', { selector: 'select' })
    select.focus()
    await user.keyboard('p')
    await user.keyboard('n')
    expect(screen.getByRole('button', { name: /^Pass/ })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getAllByText('OUTPUT-A').length).toBeGreaterThan(0)
    select.blur()
    await user.keyboard('p')
    expect(screen.getByRole('button', { name: /^Pass/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('drops an item that was just labelled when the person jumps away from it, as Next does', async () => {
    const user = userEvent.setup()
    // With the reveal on, the labelled item stays on screen until the person moves.
    window.localStorage.setItem('evals-ui-reveal-after-save', 'on')
    installFetch(routes({ 'POST /api/labels': { status: 201, body: { label: { id: A.itemId, group: 'run-a', criterion: 'crit-1', output: 'x', verdict: 'fail', critique: 'c', labeler: 'Sam', sampled_by: 'targeted', at: '2026-11-12T11:00:00.000Z' } } } }))
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    await user.click(screen.getByRole('button', { name: /^Fail/ }))
    await user.type(screen.getByLabelText('Critique (required)'), 'c')
    await user.type(screen.getByLabelText('Your name'), 'Sam')
    await user.click(screen.getByRole('button', { name: 'Save and show the judge' }))
    await screen.findByText('Label saved.')
    await user.selectOptions(screen.getByLabelText('Jump to an item', { selector: 'select' }), 'run-c:crit-2')
    expect(await screen.findByText('OUTPUT-C')).toBeInTheDocument()
    expect(within(screen.getByLabelText('Jump to an item', { selector: 'select' })).getAllByRole('option')).toHaveLength(2)
    expect(screen.getByText(/2 left in this batch/)).toBeInTheDocument()
  })

  it('shows a filter for a long list, narrows the options, and keeps the current item selectable', async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: 30 }, (_, i) => make(`run-${String(i).padStart(2, '0')}`, i < 15 ? 'billing' : 'support', 'crit', '2026-11-12T10:00:00.000Z', 'random'))
    installFetch(routes({ 'GET /api/queue': { body: queue({ items: many, stats: { candidates: 30, notApplicable: 0, pending: 30, queued: 30, labelled: 0, labelledRandom: 0, labelledRandomShare: null, minRandomShare: 0.3, quotaMet: true, byCriterion: [] } }) } }))
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    await user.type(screen.getByLabelText('Filter the list'), 'support')
    const select = screen.getByLabelText('Jump to an item', { selector: 'select' })
    // 15 support items plus the current item, which is a billing one.
    expect(within(select).getAllByRole('option')).toHaveLength(16)
    expect(select).toHaveValue(many[0]!.itemId)
    expect(screen.getByText(/15 other items match the filter/)).toBeInTheDocument()
  })

  it('has no filter for a short list', async () => {
    installFetch(routes())
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    expect(screen.queryByLabelText('Filter the list')).toBeNull()
  })

  it('says plainly when the list is capped', async () => {
    installFetch(routes({ 'GET /api/queue': { body: queue({ items: [A, B, C], stats: { candidates: 400, notApplicable: 0, pending: 250, queued: 3, labelled: 5, labelledRandom: 1, labelledRandomShare: 0.2, minRandomShare: 0.3, quotaMet: false, byCriterion: [] } }) } }))
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    expect(screen.getByText(/The list shows 3 of the 250 items up for review/)).toBeInTheDocument()
  })

  it('never puts the reason or the judge in the DOM, for any item, with the picker open', async () => {
    const user = userEvent.setup()
    installFetch(routes())
    const { container } = renderApp('/classify')
    await screen.findByLabelText('Item to label')
    await user.selectOptions(screen.getByLabelText('Jump to an item', { selector: 'select' }), 'run-c:crit-2')
    const html = container.innerHTML
    expect(html).not.toMatch(/targeted/i)
    expect(html).not.toContain(JUDGE_CRITIQUE)
  })
})

describe('deep link #/classify?item=', () => {
  it('opens the queue with that item current, and the others still listed', async () => {
    installFetch(routes())
    renderApp('/classify?item=run-c%3Acrit-2')
    expect(await screen.findByText('OUTPUT-C')).toBeInTheDocument()
    expect(screen.queryByText('OUTPUT-A')).toBeNull()
    expect(screen.queryByText(/not in the review queue/)).toBeNull()
    expect(screen.getByLabelText('Jump to an item', { selector: 'select' })).toHaveValue('run-c:crit-2')
    expect(within(screen.getByLabelText('Jump to an item', { selector: 'select' })).getAllByRole('option')).toHaveLength(3)
  })

  it('shows a short banner and the normal first item when the item is not in the queue', async () => {
    installFetch(routes())
    renderApp('/classify?item=run-zzz%3Acrit-9')
    expect(await screen.findByText(/That item is not in the review queue/)).toBeInTheDocument()
    expect(screen.getAllByText('OUTPUT-A').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Jump to an item', { selector: 'select' })).toHaveValue('run-a:crit-1')
  })

  it('says the list may be capped when the queue has more than it loaded', async () => {
    installFetch(routes({ 'GET /api/queue': { body: queue({ items: [A, B, C], stats: { candidates: 400, notApplicable: 0, pending: 250, queued: 3, labelled: 5, labelledRandom: 1, labelledRandomShare: 0.2, minRandomShare: 0.3, quotaMet: false, byCriterion: [] } }) } }))
    renderApp('/classify?item=run-zzz%3Acrit-9')
    expect(await screen.findByText(/may be further down/)).toBeInTheDocument()
  })

  it('follows a new link while the page is open', async () => {
    installFetch(routes())
    renderApp('/classify')
    await screen.findByLabelText('Item to label')
    expect(screen.getAllByText('OUTPUT-A').length).toBeGreaterThan(0)
    window.location.hash = '#/classify?item=run-b%3Acrit-1'
    expect(await screen.findByText('OUTPUT-B')).toBeInTheDocument()
  })

  it('does not look the item up anywhere else, so the server still decides what can be labelled', async () => {
    const fake = installFetch(routes())
    renderApp('/classify?item=run-zzz%3Acrit-9')
    await screen.findByText(/That item is not in the review queue/)
    expect(fake.calls.filter(c => c.method === 'POST')).toHaveLength(0)
    expect(fake.calls.some(c => c.path.endsWith('/reveal'))).toBe(false)
  })
})
