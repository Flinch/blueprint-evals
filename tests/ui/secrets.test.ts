import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createScrubber, secretValues } from '../../src/server/redact.js'
import { createPreviewTokens, canonical } from '../../src/server/preview-token.js'
import { DETERMINISTIC, fixture, hasSuiteEnd, sse, SECRET, type Fixture } from './harness.js'
import { saveSuite } from './records.js'

const fixtures: Fixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(f => f.stop()))
})

// An agent that repeats a request header back in its reply, the way a careless
// debug endpoint might. The header holds the secret from the environment.
const echoingFetch: typeof fetch = async (_url, init) => {
  const headers = init?.headers as Record<string, string>
  return new Response(JSON.stringify({ reply: `debug: key=${headers['x-api-key']}`, conversation_id: 'c1', tool_calls: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const OTHER = 'OTHER-env-value-that-looks-private-9876'

describe('secret values never leave the server', () => {
  it('appear in no API response, and not in the event stream, even when the agent echoes them', async () => {
    const f = await fixture({ fetch: echoingFetch, env: { SOME_SERVICE_TOKEN: OTHER, MODEL_VENDOR_API_KEY: 'vendor-fake-for-this-test-only-123456' } })
    fixtures.push(f)
    saveSuite(f.workdir, [{ runId: 'r1', scenario: 'reschedule-tomorrow-3pm', criteria: { 'confirms-before-acting': 'fail' } }])

    const stream = sse(f.ui, { until: hasSuiteEnd })
    const started = (await f.api.post('/api/run/start', { only: [DETERMINISTIC] })).json()
    const events = await stream.done
    const streamText = JSON.stringify(events)

    // The run really did capture the secret (the agent echoed it), so this is a real test of the scrubbing.
    const onDisk = readFileSync(join(f.workdir, '.evals', 'runs', `${started.suiteId}.json`), 'utf8')
    expect(onDisk).toContain(SECRET)

    const runId = events.find(e => e.event === 'run:start')!.data.runId
    const gets = [
      '/api/health', '/api/overview', '/api/suites', `/api/suites/${started.suiteId}`, '/api/runs', `/api/runs/${runId}`, '/api/scenarios', '/api/rubrics',
      '/api/queue?limit=200', '/api/labels', '/api/calibration', '/api/run/status',
    ]
    for (const path of gets) {
      const r = await f.api.get(path)
      expect(r.status, path).toBe(200)
      expect(r.text, path).not.toContain(SECRET)
      expect(r.text, path).not.toContain(OTHER)
      expect(r.text, path).not.toContain('vendor-fake')
    }
    expect((await f.api.get(`/api/runs/${runId}`)).text).toContain('debug: key=[redacted]')

    // POST responses and error responses too.
    const posts: [string, unknown][] = [
      ['/api/run/preview', { only: [DETERMINISTIC] }],
      ['/api/run/preview', { only: ['nope'] }],
      ['/api/run/start', { only: ['asks-for-medical-advice'] }],
      ['/api/calibrate/preview', { rubricId: 'scheduling', split: 'dev' }],
      ['/api/labels', { itemId: 'x', labeler: 'a', verdict: 'pass', critique: 'c' }],
    ]
    for (const [path, body] of posts) {
      const r = await f.api.post(path, body)
      expect(r.text, path).not.toContain(SECRET)
    }
    expect(streamText).not.toContain(SECRET)
    expect(streamText).toContain('[redacted]')
    // And nothing the client ever received, in any of those calls.
    for (const text of f.api.seen) {
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain(OTHER)
    }
  })

  it('does not take a key over the API', async () => {
    const f = await fixture()
    fixtures.push(f)
    for (const field of ['apiKey', 'api_key', 'anthropicApiKey', 'env', 'headers', 'token']) {
      const r = await f.api.post('/api/run/start', { only: [DETERMINISTIC], [field]: 'sk-ant-should-never-be-read' })
      expect(r.status, field).toBe(400)
    }
    for (const header of ['x-api-key', 'anthropic-api-key']) {
      // A key in a header is simply ignored: it is not used for anything.
      const r = await f.api.post('/api/run/preview', { only: [DETERMINISTIC] }, { [header]: 'sk-ant-should-never-be-read' })
      expect(r.status).toBe(200)
      expect(r.text).not.toContain('sk-ant-should-never-be-read')
    }
    expect((await f.api.get('/api/run/status')).json().activeJob).toBeNull()
  })
})

describe('the scrubber', () => {
  it('replaces raw and JSON-escaped forms', () => {
    const tricky = 'pa"ss\\word-12345'
    const scrub = createScrubber([tricky])
    expect(scrub(JSON.stringify({ a: tricky, b: `x ${tricky} y` }))).toBe('{"a":"[redacted]","b":"x [redacted] y"}')
    expect(createScrubber([])('nothing to do')).toBe('nothing to do')
  })

  it('picks up secret-looking variables and the ones the config refers to', () => {
    const values = secretValues({ MY_API_KEY: 'key-value-1234', PLAIN: 'plain-value-1234', SHORT_TOKEN: 'abc', EMPTY_SECRET: '' }, null)
    expect(values).toEqual(['key-value-1234'])
  })
})

describe('preview tokens', () => {
  const key = Buffer.alloc(32, 1)

  it('verify only for the same plan, before expiry, under the same key', () => {
    const tokens = createPreviewTokens(key, 1000)
    const plan = { ids: ['a', 'b'], cap: 1 }
    const { token, expiresAt } = tokens.issue(plan, 10_000)
    expect(expiresAt).toBe(11_000)
    expect(tokens.verify(token, plan, 10_500)).toBe(true)
    expect(tokens.verify(token, { ids: ['a', 'b'], cap: 2 }, 10_500)).toBe(false)
    expect(tokens.verify(token, { ids: ['b', 'a'], cap: 1 }, 10_500)).toBe(false)
    expect(tokens.verify(token, plan, 11_001)).toBe(false) // expired
    expect(createPreviewTokens(Buffer.alloc(32, 2), 1000).verify(token, plan, 10_500)).toBe(false)
    // Moving the expiry forward invalidates the signature.
    const forged = `${expiresAt + 1_000_000}.${token.split('.')[1]}`
    expect(tokens.verify(forged, plan, 10_500)).toBe(false)
    for (const junk of [undefined, '', 'x', '.', 'abc.def', '1.']) expect(tokens.verify(junk, plan, 10_500)).toBe(false)
  })

  it('signs a canonical form, so key order does not matter', () => {
    expect(canonical({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: undefined } })).toBe(canonical({ a: { c: undefined, d: [2, { x: 2, y: 1 }] }, b: 1 }))
  })
})

describe('what is written to disk', () => {
  it('leaves no temporary files in the store after a run', async () => {
    const f = await fixture()
    fixtures.push(f)
    const stream = sse(f.ui, { until: hasSuiteEnd })
    await f.api.post('/api/run/start', { only: [DETERMINISTIC] })
    await stream.done
    expect(readdirSync(join(f.workdir, '.evals', 'runs')).filter(n => !/^[\w.-]+\.json$/.test(n) || n.startsWith('.'))).toEqual([])
  })
})
