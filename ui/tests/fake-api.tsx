import { render } from '@testing-library/react'
import { vi } from 'vitest'
import type { ApiErrorBody, ErrorCode } from '../../src/ui/api-types'
import { App } from '../src/App'

// A fake server for the page: fetch answers from a route table and EventSource
// is a class the test drives by hand. No network, no model.

export interface Call {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
}

export type Reply = { status?: number; body: unknown }
export type Handler = Reply | ((call: Call) => Reply | Promise<Reply>)
export type Routes = Record<string, Handler>

export function failure(status: number, code: ErrorCode, message: string, details?: unknown): Reply {
  const body: ApiErrorBody = { error: { code, message, ...(details !== undefined ? { details } : {}) } }
  return { status, body }
}

export interface Fake {
  calls: Call[]
  routes: Routes
  /** Calls to one route, in order. */
  to(route: string): Call[]
}

export function installFetch(routes: Routes): Fake {
  const calls: Call[] = []
  const fake: Fake = { calls, routes, to: route => calls.filter(c => `${c.method} ${c.path}` === route) }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://127.0.0.1:4747')
      const method = (init?.method ?? 'GET').toUpperCase()
      const call: Call = { method, path: url.pathname, query: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined }
      calls.push(call)
      const key = `${method} ${url.pathname}`
      const handler = fake.routes[key] ?? Object.entries(fake.routes).find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1]
      const reply: Reply = handler
        ? typeof handler === 'function'
          ? await handler(call)
          : handler
        : failure(404, 'not_found', `No route ${key} in the fake server.`)
      const status = reply.status ?? 200
      const text = JSON.stringify(reply.body)
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => text,
        json: async () => JSON.parse(text),
      } as Response
    }),
  )
  return fake
}

// ---------------------------------------------------------------- EventSource

type Listener = (ev: { data?: string; lastEventId?: string }) => void

export class FakeEventSource {
  static instances: FakeEventSource[] = []
  static get last(): FakeEventSource {
    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]
    if (!es) throw new Error('No EventSource was opened')
    return es
  }
  static reset() {
    FakeEventSource.instances = []
  }

  url: string
  readyState = 0
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  private listeners = new Map<string, Listener[]>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  close() {
    this.readyState = 2
  }
  /** The connection opened. */
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  /** One server frame, as the browser would deliver it. */
  emit(type: string, payload: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(payload) })
  }
  /** The connection dropped. `closed` means the browser gave up for good. */
  drop(closed = false) {
    this.readyState = closed ? 2 : 0
    this.onerror?.()
    // A real EventSource also dispatches an "error" event with no data. The page must ignore it as a run event.
    for (const fn of this.listeners.get('error') ?? []) fn({})
  }
}

export function installEventSource() {
  FakeEventSource.reset()
  vi.stubGlobal('EventSource', FakeEventSource)
}

// ------------------------------------------------------------------- the app

export function renderApp(hash = '/') {
  window.location.hash = hash
  return render(<App />)
}

// -------------------------------------------------------- default route table

import { calibrationRecord, health, overview, queue, rubrics, scenarios } from './fixtures'
import type { RunStatusResponse } from '../../src/ui/api-types'

/** Every read endpoint answers with a sensible fixture. A test overrides what it cares about. */
export function baseRoutes(over: Routes = {}): Routes {
  return {
    'GET /api/health': { body: health() },
    'GET /api/overview': { body: overview() },
    'GET /api/suites': { body: { suites: [], warnings: [] } },
    'GET /api/runs': { body: { runs: [], total: 0, warnings: [] } },
    'GET /api/scenarios': { body: scenarios() },
    'GET /api/rubrics': { body: rubrics() },
    'GET /api/run/status': { body: { activeJob: null } satisfies RunStatusResponse },
    'GET /api/queue': { body: queue() },
    'GET /api/labels': { body: { file: '/work/demo/.evals/labels.jsonl', labels: [], history: {}, stats: labelStatsFixture() } },
    'GET /api/labels/suggestions': { body: { suggestions: [], fromOtherLabelers: false } },
    'GET /api/calibration': { body: { latest: calibrationRecord() } },
    ...over,
  }
}

export function labelStatsFixture(over: Partial<import('../../src/ui/api-types').LabelStats> = {}): import('../../src/ui/api-types').LabelStats {
  return {
    total: 5,
    random: 1,
    targeted: 4,
    randomShare: 0.2,
    minRandomShare: 0.3,
    byVerdict: { pass: 2, fail: 3 },
    bySplit: { train: 1, dev: 2, test: 2 },
    labelers: ['Sam'],
    revisions: 0,
    warnings: [],
    ...over,
  }
}
