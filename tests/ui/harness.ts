import { request } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createStubAgent } from '../../examples/stub-agent/agent.js'
import { startUiServer, type UiServer, type UiServerOptions } from '../../src/server/index.js'
import type { FakeProvider } from '../../src/index.js'
import { createFakeProvider } from '../../src/index.js'
import { approvingProvider, examples, exampleConfigFor, tempDir, writeFiles } from '../cli/harness.js'

export { approvingProvider, examples, tempDir, writeFiles }

/** A value that must never appear in any response. A header in the config refers to it. */
export const SECRET = 'sk-test-SECRET-value-1234567890'
export const SECRET_ENV = 'UI_TEST_SECRET'

export interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  text: string
  json<T = any>(): T
}

export interface RawOptions {
  method?: string
  headers?: Record<string, string>
  body?: string | Buffer
}

/** A bare http request, so a test can set Host, Origin and the exact request target. */
export function raw(ui: { port: number }, path: string, options: RawOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: ui.port, path, method: options.method ?? 'GET', headers: options.headers, setHost: options.headers?.host === undefined && options.headers?.Host === undefined },
      res => {
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(c as Buffer))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: <T>() => JSON.parse(text) as T })
        })
      },
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

export interface Client {
  ui: UiServer
  get(path: string, headers?: Record<string, string>): Promise<Reply>
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply>
  /** Every response body seen so far, for "this never appeared anywhere" checks. */
  seen: string[]
}

/** An authenticated client for a running server. */
export function client(ui: UiServer): Client {
  const seen: string[] = []
  const auth = { authorization: `Bearer ${ui.token}` }
  const track = async (p: Promise<Reply>) => {
    const r = await p
    seen.push(r.text)
    return r
  }
  return {
    ui,
    seen,
    get: (path, headers = {}) => track(raw(ui, path, { headers: { ...auth, ...headers } })),
    post: (path, body, headers = {}) =>
      track(raw(ui, path, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) })),
  }
}

export interface SseEvent {
  event: string
  id?: string
  data: any
}

/** Opens the run event stream and collects events until `until` returns true. */
export function sse(ui: UiServer, options: { headers?: Record<string, string>; until?: (events: SseEvent[]) => boolean; timeoutMs?: number } = {}) {
  const events: SseEvent[] = []
  let close = () => {}
  const done = new Promise<SseEvent[]>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: ui.port, path: '/api/run/events', headers: { authorization: `Bearer ${ui.token}`, ...options.headers } },
      res => {
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          buf += chunk
          for (;;) {
            const end = buf.indexOf('\n\n')
            if (end < 0) break
            const block = buf.slice(0, end)
            buf = buf.slice(end + 2)
            const lines = block.split('\n').filter(l => !l.startsWith(':'))
            if (lines.length === 0) continue
            const ev: Partial<SseEvent> & { raw?: string } = {}
            for (const l of lines) {
              if (l.startsWith('event: ')) ev.event = l.slice(7)
              else if (l.startsWith('id: ')) ev.id = l.slice(4)
              else if (l.startsWith('data: ')) ev.raw = l.slice(6)
            }
            if (ev.event && ev.raw !== undefined) events.push({ event: ev.event, id: ev.id, data: JSON.parse(ev.raw) })
            if (options.until?.(events)) {
              req.destroy()
              resolve(events)
            }
          }
        })
        res.on('end', () => resolve(events))
      },
    )
    close = () => req.destroy()
    req.end()
    req.on('error', e => (e as { code?: string }).code === 'ECONNRESET' ? resolve(events) : reject(e))
    const t = setTimeout(() => {
      req.destroy()
      reject(new Error(`SSE timed out. Got: ${events.map(e => e.event).join(', ')}`))
    }, options.timeoutMs ?? 10_000)
    t.unref()
  })
  return { events, done, close }
}

export const hasSuiteEnd = (events: SseEvent[]) => events.some(e => e.event === 'suite:end')

export interface Fixture {
  ui: UiServer
  api: Client
  workdir: string
  configFile: string
  scenariosDir: string
  provider: FakeProvider
  stop(): Promise<void>
}

export interface FixtureOptions {
  provider?: FakeProvider
  /** Extra scenario and rubric files, relative to the scenarios directory. */
  files?: Record<string, string>
  /** Use a scenarios directory of your own instead of the examples. */
  ownScenarios?: boolean
  server?: Partial<UiServerOptions>
  fetch?: typeof fetch
  noConfig?: boolean
  env?: NodeJS.ProcessEnv
  agentDefect?: 'no-confirm'
  configEdit?: (text: string) => string
}

/** A running server against a real stub agent, the example scenarios and the fake provider. */
export async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const agent = createStubAgent(options.agentDefect ? { defect: options.agentDefect } : {})
  const base = await agent.listen()
  const workdir = tempDir('evals-ui-')
  const withHeader: [string, string][] = [['    kind: http', `    kind: http\n    headers:\n      X-Api-Key: "\${env:${SECRET_ENV}}"`]]
  const configFile = join(workdir, 'evals.config.yaml')
  const text = exampleConfigFor(base, withHeader)
  writeFileSync(configFile, options.configEdit ? options.configEdit(text) : text)

  let scenariosDir = join(examples, 'scenarios')
  if (options.ownScenarios) {
    scenariosDir = join(workdir, 'scenarios')
    mkdirSync(scenariosDir, { recursive: true })
  }
  for (const [name, body] of Object.entries(options.files ?? {})) {
    const file = join(scenariosDir, name)
    if (!options.ownScenarios) throw new Error('extra files need ownScenarios')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, body)
  }

  const provider = options.provider ?? createFakeProvider({ error: 'a model was called when none should have been' })
  const ui = await startUiServer({
    workdir,
    configFile: options.noConfig ? null : configFile,
    scenarioPath: scenariosDir,
    port: 0,
    env: { [SECRET_ENV]: SECRET, ...options.env },
    fetch: options.fetch,
    createProvider: () => provider,
    ...options.server,
  })
  return {
    ui,
    api: client(ui),
    workdir,
    configFile,
    scenariosDir,
    provider,
    async stop() {
      await ui.close()
      await agent.close()
    },
  }
}

export const DETERMINISTIC = 'reschedule-asks-before-acting'
export const MODEL_SCENARIO = 'reschedule-tomorrow-3pm'
