import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'vite'
import { describe, expect, it } from 'vitest'
import { startUiServer } from '../../src/server/index.js'
import { client, raw, tempDir } from './harness.js'

// Builds the front end into a temporary directory and serves it with the real
// server, so the build contract holds whatever is in dist/ui right now.

const root = join(import.meta.dirname, '..', '..')

describe('front end build', () => {
  it('builds without emptying the output directory, and the server serves it', async () => {
    const out = tempDir('evals-ui-build-')
    // What `tsc` leaves in dist/ui: the compiled api-types. The build must keep it.
    writeFileSync(join(out, 'api-types.js'), 'export {}\n')
    mkdirSync(join(out, 'assets'), { recursive: true })
    writeFileSync(join(out, 'assets', 'stale-old-hash.js'), '// from an earlier build\n')

    await build({ configFile: join(root, 'ui', 'vite.config.ts'), logLevel: 'silent', build: { outDir: out } })

    expect(existsSync(join(out, 'api-types.js'))).toBe(true) // not emptied
    expect(existsSync(join(out, 'assets', 'stale-old-hash.js'))).toBe(false) // only its own assets are replaced
    const html = readFileSync(join(out, 'index.html'), 'utf8')
    expect(html).toContain('<div id="root">')
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/) // no inline script: the CSP forbids it

    // Nothing is fetched from another origin: no absolute URL in the page or its styles.
    const assets = readdirSync(join(out, 'assets'))
    const css = assets.filter(f => f.endsWith('.css')).map(f => readFileSync(join(out, 'assets', f), 'utf8')).join('\n')
    expect(html).not.toMatch(/(src|href)="https?:/)
    expect(css).not.toMatch(/url\(\s*["']?https?:/)
    expect(css).not.toContain('fonts.googleapis.com')
    expect(assets.some(f => f.endsWith('.woff2'))).toBe(true) // fonts ship with the page

    const ui = await startUiServer({ workdir: tempDir('evals-ui-build-wd-'), port: 0, env: {}, staticDir: out })
    try {
      const api = client(ui)
      const health = (await api.get('/api/health')).json()
      expect(health.uiBuilt).toBe(true)
      const page = await raw(ui, '/', { headers: { authorization: `Bearer ${ui.token}` } })
      expect(page.status).toBe(200)
      expect(page.text).toContain('<div id="root">')
      const js = assets.find(f => f.endsWith('.js'))!
      const script = await raw(ui, `/assets/${js}`, { headers: { authorization: `Bearer ${ui.token}` } })
      expect(script.status).toBe(200)
      expect(String(script.headers['content-type'])).toContain('javascript')
      const font = assets.find(f => f.endsWith('.woff2'))!
      expect((await raw(ui, `/assets/${font}`, { headers: { authorization: `Bearer ${ui.token}` } })).status).toBe(200)
      // The page is the app shell for any path without an extension, so a reload keeps working.
      expect((await raw(ui, '/classify', { headers: { authorization: `Bearer ${ui.token}` } })).text).toContain('<div id="root">')
    } finally {
      await ui.close()
    }
  })
})
