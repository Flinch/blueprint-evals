import type { IncomingMessage, ServerResponse } from 'node:http'
import { BASE_HEADERS, type Scrub } from './http.js'

// Server-sent events for run progress. Events of the current (or most recent)
// suite are buffered, so a page opened mid-run, or reconnecting, sees what it
// missed. A client that sends Last-Event-ID gets only what is newer.

const BUFFER_LIMIT = 5000
const KEEPALIVE_MS = 15_000

interface Buffered {
  seq: number
  event: string
  data: string
}

export interface EventHub {
  /** Publishes an event to every client and the buffer. Returns its sequence number. */
  publish(type: string, suiteId: string, payload: Record<string, unknown>, scrub: Scrub): number
  /** Starts a new suite: the buffer holds only its events. Sequence numbers keep counting. */
  resetBuffer(): void
  attach(req: IncomingMessage, res: ServerResponse, hello: unknown, scrub: Scrub): void
  closeAll(): void
  readonly clients: number
}

export function createEventHub(): EventHub {
  let seq = 0
  let buffer: Buffered[] = []
  const clients = new Set<ServerResponse>()
  const timers = new Map<ServerResponse, NodeJS.Timeout>()

  const frame = (e: Buffered) => `event: ${e.event}\nid: ${e.seq}\ndata: ${e.data}\n\n`
  const drop = (res: ServerResponse) => {
    clearInterval(timers.get(res))
    timers.delete(res)
    clients.delete(res)
  }

  return {
    get clients() {
      return clients.size
    },
    publish(type, suiteId, payload, scrub) {
      const n = ++seq
      const e: Buffered = { seq: n, event: type, data: scrub(JSON.stringify({ seq: n, at: new Date().toISOString(), suiteId, type, ...payload })) }
      buffer.push(e)
      if (buffer.length > BUFFER_LIMIT) buffer = buffer.slice(-BUFFER_LIMIT)
      for (const res of clients) res.write(frame(e))
      return n
    },
    resetBuffer() {
      buffer = []
    },
    attach(req, res, hello, scrub) {
      res.writeHead(200, {
        ...BASE_HEADERS,
        'content-type': 'text/event-stream; charset=utf-8',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write('retry: 2000\n\n')
      res.write(`event: hello\ndata: ${scrub(JSON.stringify(hello))}\n\n`)

      const last = Number(req.headers['last-event-id'])
      for (const e of buffer) if (!Number.isFinite(last) || e.seq > last) res.write(frame(e))

      clients.add(res)
      const timer = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS)
      timer.unref()
      timers.set(res, timer)
      req.on('close', () => drop(res))
    },
    closeAll() {
      for (const res of [...clients]) {
        drop(res)
        res.end()
      }
    },
  }
}
