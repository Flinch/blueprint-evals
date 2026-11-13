import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { BASE_HEADERS, CONTENT_SECURITY_POLICY } from './http.js'

// Serves the built front end from dist/ui. Phase 2 puts it there. Until then
// every page is a short "not built yet" notice.

/** <package>/dist/ui, whether this runs from src (tsx) or dist (compiled): both are two levels below the package root. */
export const DEFAULT_STATIC_DIR = resolve(import.meta.dirname, '..', '..', 'dist', 'ui')

/** Only these are served. Source maps and TypeScript declarations that share the directory are not. */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
}

export const NOT_BUILT_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>evals ui</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222}code{background:#eee;padding:.1em .3em;border-radius:3px}</style>
</head><body>
<h1>The UI is not built yet</h1>
<p>The local server is running and its API works under <code>/api</code>, but there is no front end in <code>dist/ui</code> to show.</p>
<p>Build it, then reload this page.</p>
</body></html>
`

export const UNAUTHORIZED_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>evals ui</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222}code{background:#eee;padding:.1em .3em;border-radius:3px}</style>
</head><body>
<h1>Open the link from your terminal</h1>
<p>This page needs the access token that <code>evals ui</code> printed when it started. Open the full URL it printed, which ends in <code>?token=...</code>.</p>
</body></html>
`

export function isBuilt(dir: string): boolean {
  return existsSync(resolve(dir, 'index.html'))
}

function html(res: ServerResponse, status: number, body: string, head: boolean): void {
  res.writeHead(status, {
    ...BASE_HEADERS,
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'content-security-policy': CONTENT_SECURITY_POLICY,
  })
  res.end(head ? undefined : body)
}

export function sendUnauthorizedPage(res: ServerResponse, head = false): void {
  html(res, 401, UNAUTHORIZED_HTML, head)
}

/**
 * Where a URL path may land inside `root`, or null. The path is decoded once, a
 * NUL byte or a dot-segment anywhere refuses it, and the resolved real path
 * (symlinks followed) must still be inside the real root.
 */
export function resolveStatic(root: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  const segments = decoded.split('/').filter(s => s !== '')
  if (segments.some(s => s === '..' || s === '.' || s.startsWith('.'))) return null

  const base = resolve(root)
  const candidate = resolve(base, ...segments)
  if (candidate !== base && !candidate.startsWith(base + sep)) return null
  try {
    const real = realpathSync(candidate)
    const realBase = realpathSync(base)
    if (real !== realBase && !real.startsWith(realBase + sep)) return null
    return real
  } catch {
    return null
  }
}

/**
 * Serves a file, or the app shell for a path with no file extension (so the
 * front end's own routes work on reload), or the notice when nothing is built.
 */
export function serveStatic(root: string, urlPath: string, res: ServerResponse, head = false): void {
  if (!isBuilt(root)) return html(res, 200, NOT_BUILT_HTML, head)

  const target = resolveStatic(root, urlPath)
  const file = target && statSync(target).isFile() ? target : undefined
  const asked = extname(urlPath)

  if (!file) {
    // A missing asset is a 404. A missing page is the app shell.
    if (asked !== '') {
      res.writeHead(404, { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8' })
      return void res.end(head ? undefined : 'Not found')
    }
    return html(res, 200, readFileSync(resolve(root, 'index.html'), 'utf8'), head)
  }

  const type = TYPES[extname(file).toLowerCase()]
  if (!type) {
    res.writeHead(404, { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8' })
    return void res.end(head ? undefined : 'Not found')
  }
  const body = readFileSync(file)
  res.writeHead(200, {
    ...BASE_HEADERS,
    'content-type': type,
    'content-length': body.length,
    ...(type.startsWith('text/html') ? { 'content-security-policy': CONTENT_SECURITY_POLICY } : {}),
  })
  res.end(head ? undefined : body)
}
