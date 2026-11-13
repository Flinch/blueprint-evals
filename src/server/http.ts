import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiErrorBody, ErrorCode } from '../ui/api-types.js'

/** An error with an HTTP status and a stable code. Thrown from handlers, turned into ApiErrorBody. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Response headers every reply carries. The page never needs to be framed, sniffed, cached or to leak its URL. */
export const BASE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
} as const

/** The policy for the HTML shell: everything from this origin, nothing inline except styles, no framing. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"

export type Scrub = (text: string) => string

export function sendJson(res: ServerResponse, status: number, body: unknown, scrub: Scrub, extra: Record<string, string | string[]> = {}): void {
  const text = scrub(JSON.stringify(body))
  res.writeHead(status, {
    ...BASE_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...extra,
  })
  res.end(text)
}

export function errorBody(e: ApiError): ApiErrorBody {
  return { error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } }
}

/** Reads a JSON body, refusing anything over `limit` bytes without buffering the rest. */
export async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== 'application/json') throw new ApiError(415, 'unsupported_media_type', 'Send the body as application/json.')

  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) throw new ApiError(413, 'payload_too_large', `The body is over the ${limit} byte limit.`)

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) {
      req.destroy()
      throw new ApiError(413, 'payload_too_large', `The body is over the ${limit} byte limit.`)
    }
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError(400, 'bad_request', 'The body is not valid JSON.')
  }
}

/** Constant-time string comparison, so a token cannot be guessed one character at a time. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}
