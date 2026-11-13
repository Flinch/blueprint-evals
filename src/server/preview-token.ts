import { createHash, createHmac } from 'node:crypto'
import { safeEqual } from './http.js'

// The preview token ties a confirmation to one exact plan. It is an HMAC, under
// a key that exists only in this server process, over a canonical form of the
// plan (which scenarios, the cost cap, the models and their prices, the targets)
// and an expiry. Starting a run recomputes the plan from the files as they are
// now and compares: a changed plan, an expired token, or a token from another
// server all fail the same way.

export const TOKEN_TTL_MS = 15 * 60 * 1000

/** JSON with object keys sorted at every level, so equal plans serialise identically. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return `{${Object.keys(o)
      .filter(k => o[k] !== undefined)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')

export interface PreviewTokens {
  issue(plan: unknown, now?: number): { token: string; expiresAt: number }
  /** True only for an unexpired token issued by this server for exactly this plan. */
  verify(token: string | undefined, plan: unknown, now?: number): boolean
}

export function createPreviewTokens(key: Buffer, ttlMs = TOKEN_TTL_MS): PreviewTokens {
  const sign = (expiresAt: number, plan: unknown) => createHmac('sha256', key).update(`${expiresAt}.${canonical(plan)}`).digest('hex')
  return {
    issue(plan, now = Date.now()) {
      const expiresAt = now + ttlMs
      return { token: `${expiresAt}.${sign(expiresAt, plan)}`, expiresAt }
    },
    verify(token, plan, now = Date.now()) {
      if (typeof token !== 'string') return false
      const dot = token.indexOf('.')
      if (dot < 1) return false
      const expiresAt = Number(token.slice(0, dot))
      if (!Number.isSafeInteger(expiresAt) || expiresAt < now) return false
      return safeEqual(token.slice(dot + 1), sign(expiresAt, plan))
    },
  }
}
