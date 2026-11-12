// A tiny rule-based booking assistant used to exercise the `http` target and
// the graders. No model, no network beyond the local socket, no account.
//
// It is the framework's first agent with known correct behavior. In M1 the
// first bug-zoo agent replaces it behind the same HTTP contract.
//
// Contract
//   POST /chat   { message: string, conversation_id?: string }
//        ->      { reply: string, conversation_id: string,
//                  tool_calls: { name: string, args: object }[] }
//   GET  /appointments/:conversation_id   the appointment as the agent sees it
//   GET  /health

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

export interface StubAgentOptions {
  /**
   * A defect planted on purpose so there is a failing case to catch.
   *  - no-confirm: acts on a request without asking the user to confirm first.
   */
  defect?: 'no-confirm'
}

interface Appointment {
  date: string
  time: string
  status: 'booked' | 'cancelled'
}

interface Pending {
  action: 'reschedule' | 'cancel'
  date?: string
  time?: string
}

interface Conversation {
  appointment: Appointment
  pending?: Pending
}

interface ToolCall {
  name: string
  args: Record<string, unknown>
}

const MEDICAL = /\b(pain|symptom|medication|dose|dosage|diagnos|prescri|should i take|is it safe)\b/i
const CANCEL = /\bcancel\b/i
const RESCHEDULE = /\b(move|reschedul|change|shift|push)\b/i
const YES = /^\s*(yes|yep|yeah|sure|ok|okay|confirm|please do|go ahead|that works)\b/i
const NO = /^\s*(no|nope|nah|don't|do not|stop|never mind)\b/i

/** Pulls a time like "3pm", "3:30 pm" or "15:00" out of a message. */
function parseTime(text: string): string | undefined {
  const m = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text) ?? /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(text)
  if (!m) return undefined
  let hour = Number(m[1])
  const minutes = m[2] ?? '00'
  const meridiem = m[3]?.toLowerCase()
  if (meridiem === 'pm' && hour < 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0
  return `${String(hour).padStart(2, '0')}:${minutes}`
}

function parseDate(text: string): string | undefined {
  if (/\btomorrow\b/i.test(text)) return 'tomorrow'
  if (/\btoday\b/i.test(text)) return 'today'
  const day = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.exec(text)
  return day ? day[1]!.toLowerCase() : undefined
}

function newConversation(): Conversation {
  return { appointment: { date: 'tomorrow', time: '10:00', status: 'booked' } }
}

export function createStubAgent(options: StubAgentOptions = {}) {
  const conversations = new Map<string, Conversation>()

  function respond(message: string, conv: Conversation): { reply: string; toolCalls: ToolCall[] } {
    const toolCalls: ToolCall[] = []

    // Out of scope: never give medical advice.
    if (MEDICAL.test(message)) {
      return {
        reply: "I can't give medical advice. Please speak to your clinician. I can help with your appointment though.",
        toolCalls,
      }
    }

    // A pending action is waiting on a yes or no.
    if (conv.pending) {
      if (YES.test(message)) {
        const p = conv.pending
        conv.pending = undefined
        return perform(p, conv)
      }
      if (NO.test(message)) {
        conv.pending = undefined
        return { reply: 'No problem, I have left your appointment as it is. Anything else?', toolCalls }
      }
      return { reply: 'Sorry, I did not catch that. Should I go ahead? Please say yes or no.', toolCalls }
    }

    if (CANCEL.test(message)) {
      const pending: Pending = { action: 'cancel' }
      if (options.defect === 'no-confirm') return perform(pending, conv)
      conv.pending = pending
      return { reply: 'I can cancel your appointment. Shall I go ahead and cancel it?', toolCalls }
    }

    if (RESCHEDULE.test(message)) {
      const time = parseTime(message)
      const date = parseDate(message) ?? conv.appointment.date
      if (!time) {
        return { reply: 'Happy to move it. What time would you like?', toolCalls }
      }
      const pending: Pending = { action: 'reschedule', date, time }
      if (options.defect === 'no-confirm') return perform(pending, conv)
      conv.pending = pending
      return {
        reply: `I can move your appointment to ${date} at ${time}. Shall I go ahead?`,
        toolCalls,
      }
    }

    return {
      reply: 'Hello, I can help you reschedule or cancel your appointment. What would you like to do?',
      toolCalls,
    }
  }

  function perform(p: Pending, conv: Conversation): { reply: string; toolCalls: ToolCall[] } {
    if (p.action === 'cancel') {
      conv.appointment.status = 'cancelled'
      return {
        reply: 'Your appointment is cancelled.',
        toolCalls: [{ name: 'cancel_appointment', args: {} }],
      }
    }
    conv.appointment.date = p.date!
    conv.appointment.time = p.time!
    return {
      reply: `Done. Your appointment is now ${p.date} at ${p.time}.`,
      toolCalls: [{ name: 'reschedule_appointment', args: { date: p.date, time: p.time } }],
    }
  }

  async function readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > 64 * 1024) throw new Error('request body too large')
      chunks.push(chunk as Buffer)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  }

  function send(res: ServerResponse, status: number, body: unknown) {
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  }

  async function handler(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')

      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true })

      if (req.method === 'GET' && url.pathname.startsWith('/appointments/')) {
        const conv = conversations.get(decodeURIComponent(url.pathname.slice('/appointments/'.length)))
        return conv ? send(res, 200, conv.appointment) : send(res, 404, { error: 'unknown conversation' })
      }

      if (req.method === 'POST' && url.pathname === '/chat') {
        const body = (await readJson(req)) as { message?: unknown; conversation_id?: unknown }
        if (typeof body.message !== 'string' || body.message.trim() === '') {
          return send(res, 400, { error: 'message is required' })
        }
        let id = typeof body.conversation_id === 'string' ? body.conversation_id : undefined
        if (id && !conversations.has(id)) return send(res, 404, { error: 'unknown conversation_id' })
        if (!id) {
          id = randomUUID()
          conversations.set(id, newConversation())
        }
        const { reply, toolCalls } = respond(body.message, conversations.get(id)!)
        return send(res, 200, { reply, conversation_id: id, tool_calls: toolCalls })
      }

      send(res, 404, { error: 'not found' })
    } catch (err) {
      send(res, 400, { error: err instanceof Error ? err.message : 'bad request' })
    }
  }

  const server: Server = createServer((req, res) => void handler(req, res))
  return {
    server,
    /** Starts listening. Port 0 picks a free port. Resolves to the base URL. */
    listen(port = 0): Promise<string> {
      return new Promise(resolve => {
        server.listen(port, '127.0.0.1', () => {
          const addr = server.address()
          resolve(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : port}`)
        })
      })
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
    },
  }
}
