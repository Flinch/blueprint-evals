import type { IncomingMessage } from 'node:http'
import { parseCookies, safeEqual } from './http.js'

// The local server's defences. It binds 127.0.0.1 only, and on top of that:
//
//  - a random token, required on every request (Authorization: Bearer, the
//    X-Evals-Token header, or the cookie the first page load sets);
//  - the Host header must be 127.0.0.1 or localhost on this port, which defeats
//    DNS rebinding (a hostile page re-pointing its own name at 127.0.0.1);
//  - an Origin header, when present, must be this server's own origin, and a
//    browser that marks a request as cross-site is refused even without one.

export const LOOPBACK_HOST = '127.0.0.1'

export interface Security {
  /** The cookie name. It includes the port because cookies are shared across ports on one host. */
  cookieName: string
  hostAllowed(host: string | undefined): boolean
  /** Null when the request's origin is acceptable, otherwise the reason. */
  originProblem(req: IncomingMessage): string | null
  /** True when the request carries the right token in a header or the cookie. */
  authenticated(req: IncomingMessage): boolean
  tokenValid(candidate: string | null | undefined): boolean
  cookieHeader(): string
}

export function createSecurity(token: string, port: number): Security {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
  const cookieName = `evals_ui_${port}`

  const fromHeaders = (req: IncomingMessage): string | undefined => {
    const auth = req.headers.authorization
    if (typeof auth === 'string' && /^Bearer /i.test(auth)) return auth.slice(7).trim()
    const custom = req.headers['x-evals-token']
    return typeof custom === 'string' ? custom : undefined
  }

  return {
    cookieName,
    hostAllowed: host => host !== undefined && hosts.has(host.toLowerCase()),
    originProblem(req) {
      const origin = req.headers.origin
      if (origin !== undefined && !origins.has(origin.toLowerCase())) return `Origin "${origin}" is not this server.`
      const site = req.headers['sec-fetch-site']
      if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return `The request is marked ${site}.`
      return null
    },
    tokenValid: candidate => typeof candidate === 'string' && candidate !== '' && safeEqual(candidate, token),
    authenticated(req) {
      const candidate = fromHeaders(req) ?? parseCookies(req.headers.cookie)[cookieName]
      return typeof candidate === 'string' && candidate !== '' && safeEqual(candidate, token)
    },
    cookieHeader: () => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict`,
  }
}
