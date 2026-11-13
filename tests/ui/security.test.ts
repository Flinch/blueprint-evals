import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fixture, raw, tempDir, type Fixture } from './harness.js'

describe('server security', () => {
  let f: Fixture
  beforeAll(async () => {
    f = await fixture()
  })
  afterAll(() => f.stop())

  const port = () => f.ui.port
  const auth = () => ({ authorization: `Bearer ${f.ui.token}` })

  it('listens on 127.0.0.1 only', () => {
    const address = f.ui.server.address() as { address: string; family: string }
    expect(address.address).toBe('127.0.0.1')
    expect(f.ui.url).toBe(`http://127.0.0.1:${f.ui.port}/?token=${f.ui.token}`)
    expect(f.ui.token.length).toBeGreaterThanOrEqual(40)
  })

  describe('token', () => {
    it('refuses every API request without one, and with a wrong one', async () => {
      for (const path of ['/api/health', '/api/overview', '/api/queue', '/api/run/events', '/api/labels']) {
        const none = await raw(f.ui, path)
        expect(none.status, path).toBe(401)
        expect(none.json().error.code).toBe('unauthorized')
        const wrong = await raw(f.ui, path, { headers: { authorization: 'Bearer nope' } })
        expect(wrong.status, path).toBe(401)
      }
      expect((await raw(f.ui, '/api/run/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401)
    })

    it('accepts the Authorization header, the X-Evals-Token header and the cookie', async () => {
      expect((await raw(f.ui, '/api/health', { headers: auth() })).status).toBe(200)
      expect((await raw(f.ui, '/api/health', { headers: { 'x-evals-token': f.ui.token } })).status).toBe(200)
      expect((await raw(f.ui, '/api/health', { headers: { cookie: `evals_ui_${port()}=${f.ui.token}` } })).status).toBe(200)
      expect((await raw(f.ui, '/api/health', { headers: { cookie: `evals_ui_${port()}=wrong` } })).status).toBe(401)
    })

    it('does not accept the token in the query string of an API call (it would end up in logs and history)', async () => {
      expect((await raw(f.ui, `/api/health?token=${f.ui.token}`)).status).toBe(401)
    })

    it('sets an HttpOnly, SameSite=Strict cookie on first load and redirects to the page without the token', async () => {
      const first = await raw(f.ui, `/?token=${f.ui.token}`)
      expect(first.status).toBe(302)
      expect(first.headers.location).toBe('/')
      const cookie = String(first.headers['set-cookie'])
      expect(cookie).toContain(`evals_ui_${port()}=${f.ui.token}`)
      expect(cookie).toMatch(/HttpOnly/)
      expect(cookie).toMatch(/SameSite=Strict/)

      const page = await raw(f.ui, '/', { headers: { cookie: cookie.split(';')[0]! } })
      expect(page.status).toBe(200)
      expect(page.text).toMatch(/The UI is not built yet/)
      expect(page.headers['content-security-policy']).toMatch(/default-src 'self'/)
    })

    it('shows a plain page, not the app, to a visitor with no token, and rejects a wrong query token', async () => {
      const page = await raw(f.ui, '/')
      expect(page.status).toBe(401)
      expect(page.text).toMatch(/Open the link from your terminal/)
      const wrong = await raw(f.ui, '/?token=wrong')
      expect(wrong.status).toBe(401)
      expect(wrong.headers['set-cookie']).toBeUndefined()
    })

    it('never redirects off-site, whatever the path looks like', async () => {
      const r = await raw(f.ui, `//evil.example/x?token=${f.ui.token}`)
      expect(r.status).toBe(302)
      expect(r.headers.location).toBe('/')
    })
  })

  describe('Host header (DNS rebinding)', () => {
    it('refuses a Host that is not 127.0.0.1 or localhost on this port', async () => {
      for (const host of ['evil.example', `evil.example:${port()}`, `127.0.0.1:${port() + 1}`, '127.0.0.1', `localhost:${port() + 1}`, `[::1]:${port()}`]) {
        const r = await raw(f.ui, '/api/health', { headers: { ...auth(), host } })
        expect(r.status, host).toBe(403)
        expect(r.json().error.code).toBe('forbidden_host')
      }
      // Static pages too, even with a valid token.
      expect((await raw(f.ui, `/?token=${f.ui.token}`, { headers: { host: 'evil.example' } })).status).toBe(403)
    })

    it('accepts both loopback names on the right port', async () => {
      expect((await raw(f.ui, '/api/health', { headers: { ...auth(), host: `localhost:${port()}` } })).status).toBe(200)
      expect((await raw(f.ui, '/api/health', { headers: { ...auth(), host: `127.0.0.1:${port()}` } })).status).toBe(200)
    })
  })

  describe('Origin (cross-origin requests)', () => {
    const post = (headers: Record<string, string>) =>
      raw(f.ui, '/api/run/preview', { method: 'POST', headers: { ...auth(), 'content-type': 'application/json', ...headers }, body: JSON.stringify({ only: ['reschedule-asks-before-acting'] }) })

    it('refuses a mutating call from another origin, and from a request the browser marks cross-site', async () => {
      for (const origin of ['https://evil.example', 'http://127.0.0.1:1', 'http://localhost', 'null']) {
        const r = await post({ origin })
        expect(r.status, origin).toBe(403)
        expect(r.json().error.code).toBe('forbidden_origin')
      }
      expect((await post({ 'sec-fetch-site': 'cross-site' })).status).toBe(403)
      expect((await post({ 'sec-fetch-site': 'same-site' })).status).toBe(403)
    })

    it('refuses a foreign Origin on a read too', async () => {
      expect((await raw(f.ui, '/api/overview', { headers: { ...auth(), origin: 'https://evil.example' } })).status).toBe(403)
    })

    it('accepts this server\'s own origin, and no Origin from a non-browser client', async () => {
      expect((await post({ origin: `http://127.0.0.1:${port()}` })).status).toBe(200)
      expect((await post({ origin: `http://localhost:${port()}`, host: `localhost:${port()}`, 'sec-fetch-site': 'same-origin' })).status).toBe(200)
      expect((await post({})).status).toBe(200)
    })

    it('sets no CORS headers and refuses preflights', async () => {
      const r = await raw(f.ui, '/api/health', { method: 'OPTIONS', headers: { ...auth(), origin: `http://127.0.0.1:${port()}`, 'access-control-request-method': 'POST' } })
      expect(r.status).toBe(405)
      expect(r.headers['access-control-allow-origin']).toBeUndefined()
      expect((await raw(f.ui, '/api/health', { headers: auth() })).headers['access-control-allow-origin']).toBeUndefined()
    })
  })

  describe('request handling', () => {
    it('requires application/json on a POST', async () => {
      const r = await raw(f.ui, '/api/run/preview', { method: 'POST', headers: { ...auth(), 'content-type': 'text/plain' }, body: '{}' })
      expect(r.status).toBe(415)
      expect(r.json().error.code).toBe('unsupported_media_type')
    })

    it('rejects malformed JSON, and fields it does not know (an API key, for one)', async () => {
      const bad = await raw(f.ui, '/api/run/preview', { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body: '{nope' })
      expect(bad.status).toBe(400)
      const key = await raw(f.ui, '/api/run/start', {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ only: ['reschedule-asks-before-acting'], apiKey: 'sk-live-should-not-be-accepted' }),
      })
      expect(key.status).toBe(400)
      expect(key.json().error.code).toBe('bad_request')
      expect(key.text).toMatch(/apiKey/)
      expect(key.text).not.toContain('sk-live-should-not-be-accepted')
    })

    it('caps the body size', async () => {
      const small = await fixture({ server: { maxBodyBytes: 500 } })
      try {
        const body = JSON.stringify({ only: ['x'.repeat(2000)] })
        const r = await raw(small.ui, '/api/run/preview', { method: 'POST', headers: { authorization: `Bearer ${small.ui.token}`, 'content-type': 'application/json' }, body })
        expect(r.status).toBe(413)
        expect(r.json().error.code).toBe('payload_too_large')
        // The server is still healthy afterwards.
        expect((await raw(small.ui, '/api/health', { headers: { authorization: `Bearer ${small.ui.token}` } })).status).toBe(200)
      } finally {
        await small.stop()
      }
    })

    it('answers an unknown endpoint with 404 and a wrong method with 405, both in the error format', async () => {
      const nf = await raw(f.ui, '/api/nope', { headers: auth() })
      expect(nf.status).toBe(404)
      expect(nf.json()).toEqual({ error: { code: 'not_found', message: expect.any(String) } })
      const bad = await raw(f.ui, '/api/overview', { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body: '{}' })
      expect(bad.status).toBe(405)
      expect(bad.json().error.code).toBe('method_not_allowed')
    })

    it('puts the safety headers on every reply', async () => {
      const r = await raw(f.ui, '/api/health', { headers: auth() })
      expect(r.headers['cache-control']).toBe('no-store')
      expect(r.headers['x-content-type-options']).toBe('nosniff')
      expect(r.headers['x-frame-options']).toBe('DENY')
      expect(r.headers['referrer-policy']).toBe('no-referrer')
    })

    it('rejects path-traversal and malformed ids in API paths', async () => {
      for (const path of ['/api/suites/..', '/api/suites/..%2f..%2fetc%2fpasswd', '/api/suites/%2e%2e', '/api/runs/..%2f..', '/api/suites/a%00b', '/api/suites/%E0%A4%A']) {
        const r = await raw(f.ui, path, { headers: auth() })
        expect([400, 404], path).toContain(r.status)
        expect(r.text).not.toMatch(/root:/)
      }
      expect((await raw(f.ui, '/api/suites/..', { headers: auth() })).status).toBe(400)
    })
  })

  describe('static files', () => {
    let site: Fixture
    let outside: string
    beforeAll(async () => {
      const root = tempDir('evals-static-')
      outside = join(root, 'secret.txt')
      writeFileSync(outside, 'TOP-SECRET-OUTSIDE')
      const dist = join(root, 'dist', 'ui')
      mkdirSync(join(dist, 'assets'), { recursive: true })
      writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title><div id=root></div>')
      writeFileSync(join(dist, 'assets', 'app.js'), 'console.log("app")')
      writeFileSync(join(dist, 'assets', 'app.js.map'), '{"sources":["../../src/server/app.ts"]}')
      writeFileSync(join(dist, 'api-types.d.ts'), 'export {}')
      writeFileSync(join(dist, '.hidden'), 'dotfile')
      symlinkSync(outside, join(dist, 'assets', 'link.txt'))
      site = await fixture({ server: { staticDir: dist } })
    })
    afterAll(() => site.stop())
    const cookie = () => ({ cookie: `evals_ui_${site.ui.port}=${site.ui.token}` })

    it('serves the shell, an asset, and the shell again for a client-side route', async () => {
      const shell = await raw(site.ui, '/', { headers: cookie() })
      expect(shell.status).toBe(200)
      expect(shell.text).toContain('<div id=root>')
      const asset = await raw(site.ui, '/assets/app.js', { headers: cookie() })
      expect(asset.status).toBe(200)
      expect(asset.headers['content-type']).toMatch(/javascript/)
      expect((await raw(site.ui, '/runs/abc', { headers: cookie() })).text).toContain('<div id=root>')
      expect((await raw(site.ui, '/assets/missing.js', { headers: cookie() })).status).toBe(404)
    })

    it('does not serve files outside the directory, however the path is written', async () => {
      const attempts = [
        '/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/assets/..%2f..%2fsecret.txt',
        '/assets/../../secret.txt', '/....//secret.txt', `/${encodeURIComponent(outside)}`, '//etc/passwd', '/%5c..%5csecret.txt', '/%00', '/assets/%00.js',
        '/assets/link.txt',
      ]
      for (const path of attempts) {
        const r = await raw(site.ui, path, { headers: cookie() })
        expect(r.text, path).not.toContain('TOP-SECRET-OUTSIDE')
        expect(r.text, path).not.toMatch(/root:/)
      }
    })

    it('does not serve dotfiles, source maps or declaration files', async () => {
      for (const path of ['/.hidden', '/assets/app.js.map', '/api-types.d.ts']) {
        const r = await raw(site.ui, path, { headers: cookie() })
        expect(r.text, path).not.toMatch(/dotfile|sources|export \{\}/)
      }
    })

    it('still needs the token and the Host check for static files', async () => {
      expect((await raw(site.ui, '/assets/app.js')).status).toBe(401)
      expect((await raw(site.ui, '/assets/app.js', { headers: { ...cookie(), host: 'evil.example' } })).status).toBe(403)
    })

    it('refuses writes to static paths', async () => {
      expect((await raw(site.ui, '/index.html', { method: 'POST', headers: cookie(), body: 'x' })).status).toBe(405)
    })
  })
})
