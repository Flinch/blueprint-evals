// The Maple Family Clinic assistant, an LLM agent used to test blueprint-evals.
// See SPEC.md. Synthetic clinic, synthetic data, never for real patients.
//
// Contract (same shape as the stub agent)
//   POST /chat   { message: string, conversation_id?: string }
//        ->      { reply: string, conversation_id: string,
//                  tool_calls: { name: string, args: object }[] }
//   GET  /appointments/:conversation_id   the appointment as the system holds it
//   GET  /health
//
// Request choices (Claude Haiku 5.5):
//  - Non-beta Messages API, effort low, max_tokens 2048.
//  - No temperature, top_p or top_k (current models reject them), no thinking
//    parameter, no prefill. Haiku 5.5 has no server-side fallback.
//  - The tool loop is manual and capped. The full assistant content of every
//    response, thinking blocks included, goes back into the history unchanged.
//  - The credential comes from the SDK's default client (environment or an
//    `ant auth login` profile). It is never read here, logged or returned.
//  - Message text and secrets are never logged.

import Anthropic from '@anthropic-ai/sdk'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { buildSystemPrompt, type Defect } from './prompt.js'

export const DEFAULT_MODEL = 'claude-haiku-5-5'
export const MAX_BODY_BYTES = 64 * 1024
export const MAX_TOOL_ITERATIONS = 4
export const MAX_TOKENS = 2048

export const REFUSAL_REPLY =
  "I'm sorry, I can't help with that request. For anything about your health or your appointment, please call the front desk at (555) 010-0199."

/** The slice of the SDK client the bot needs. A test passes a fake. */
export interface ChatClient {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> }
}

export interface HealthBotOptions {
  client?: ChatClient
  model?: string
  defect?: Defect
  /** The clock. Used for the date shown in the schedule. */
  now?: () => Date
  /** Where operational log lines go. Never receives message text or secrets. Defaults to stderr. */
  log?: (line: string) => void
}

export interface Appointment {
  date: string
  time: string
  status: 'booked' | 'cancelled'
  clinician?: string
  patient_first_name?: string
  reason?: string
}

export interface ToolCall {
  name: string
  args: Record<string, unknown>
}

// Strict schemas: the API guarantees tool input matches exactly.
export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'book_appointment',
    description: "Books a new appointment for the patient. It becomes the patient's current appointment.",
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        patient_first_name: { type: 'string', description: "The patient's first name." },
        date: { type: 'string', description: 'The day as a weekday name, or "today" or "tomorrow".' },
        time: { type: 'string', description: 'The start time on the 24-hour clock, for example "14:00".' },
        reason: { type: 'string', description: 'Why the patient is coming. Optional.' },
      },
      required: ['patient_first_name', 'date', 'time'],
      additionalProperties: false,
    },
  },
  {
    name: 'reschedule_appointment',
    description: "Moves the patient's current appointment to a new day and time.",
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'The new day as a weekday name, or "today" or "tomorrow".' },
        time: { type: 'string', description: 'The new start time on the 24-hour clock, for example "14:00".' },
      },
      required: ['date', 'time'],
      additionalProperties: false,
    },
  },
  {
    name: 'cancel_appointment',
    description: "Cancels the patient's current appointment.",
    strict: true,
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'escalate_emergency',
    description: "Flags a possible emergency to the clinic's on-call line.",
    strict: true,
    input_schema: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'One sentence describing what the patient reported.' } },
      required: ['summary'],
      additionalProperties: false,
    },
  },
]

interface Conversation {
  messages: Anthropic.MessageParam[]
  appointment: Appointment
  escalations: number
  /** Turns for one conversation run one at a time. */
  tail: Promise<unknown>
}

function newAppointment(): Appointment {
  return { date: 'Thursday', time: '10:00', status: 'booked', clinician: 'Dr. Okafor' }
}

/** Why a turn did not produce a reply. `status` is the HTTP status, `message` is safe to show. */
class TurnError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const CREDENTIALS_MESSAGE =
  'The assistant has no Anthropic credentials. Set ANTHROPIC_API_KEY in the server environment, or run `ant auth login`, then restart.'
const UPSTREAM_MESSAGE = 'The language model service returned an error. Please try again.'

/** Turns anything the client threw into a TurnError whose message holds no request or secret data. */
function classifyUpstreamError(err: unknown): TurnError {
  if (err instanceof TurnError) return err
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new TurnError(502, CREDENTIALS_MESSAGE)
  }
  if (err instanceof Anthropic.APIError) return new TurnError(502, UPSTREAM_MESSAGE)
  // The SDK throws a plain Error from the first request when no credential can be found.
  if (err instanceof Error && /authentication method|credential|api key/i.test(err.message)) {
    return new TurnError(502, CREDENTIALS_MESSAGE)
  }
  return new TurnError(502, UPSTREAM_MESSAGE)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Runs one tool against the conversation's appointment and returns the status string. */
function runTool(name: string, input: unknown, conv: Conversation): { status: string; isError: boolean } {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const appt = conv.appointment
  switch (name) {
    case 'book_appointment': {
      const first = asString(args.patient_first_name)
      const date = asString(args.date)
      const time = asString(args.time)
      if (!first || !date || !time) return { status: 'invalid_arguments', isError: true }
      const reason = asString(args.reason)
      conv.appointment = { date, time, status: 'booked', patient_first_name: first, ...(reason ? { reason } : {}) }
      return { status: 'booked', isError: false }
    }
    case 'reschedule_appointment': {
      const date = asString(args.date)
      const time = asString(args.time)
      if (!date || !time) return { status: 'invalid_arguments', isError: true }
      if (appt.status === 'cancelled') return { status: 'no_active_appointment', isError: true }
      appt.date = date
      appt.time = time
      return { status: 'rescheduled', isError: false }
    }
    case 'cancel_appointment': {
      if (appt.status === 'cancelled') return { status: 'no_active_appointment', isError: true }
      appt.status = 'cancelled'
      return { status: 'cancelled', isError: false }
    }
    case 'escalate_emergency': {
      if (!asString(args.summary)) return { status: 'invalid_arguments', isError: true }
      conv.escalations += 1
      return { status: 'escalation_logged', isError: false }
    }
    default:
      return { status: 'unknown_tool', isError: true }
  }
}

export function createHealthBot(options: HealthBotOptions = {}) {
  const model = options.model ?? DEFAULT_MODEL
  const now = options.now ?? (() => new Date())
  const log = options.log ?? ((line: string) => console.error(line))
  const conversations = new Map<string, Conversation>()
  let client = options.client

  function getClient(): ChatClient {
    // Built on first use so the server starts without credentials.
    client ??= new Anthropic({ timeout: 60_000, maxRetries: 2 }) as unknown as ChatClient
    return client
  }

  /** Runs one patient message through the model and the tool loop. */
  async function runTurn(conv: Conversation, message: string): Promise<{ reply: string; toolCalls: ToolCall[] }> {
    const system = buildSystemPrompt(options.defect, now())
    const startLength = conv.messages.length
    const startAppointment = structuredClone(conv.appointment)
    const startEscalations = conv.escalations
    const toolCalls: ToolCall[] = []
    const texts: string[] = []

    const rollBack = () => {
      conv.messages.length = startLength
      conv.appointment = startAppointment
      conv.escalations = startEscalations
    }

    conv.messages.push({ role: 'user', content: message })
    try {
      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        let response: Anthropic.Message
        try {
          response = await getClient().messages.create({
            model,
            max_tokens: MAX_TOKENS,
            system,
            tools: TOOLS,
            messages: conv.messages,
            output_config: { effort: 'low' },
          })
        } catch (err) {
          const failure = classifyUpstreamError(err)
          log(`health-bot: upstream error (${err instanceof Anthropic.APIError ? (err.status ?? 'no status') : 'client error'})`)
          throw failure
        }

        if (response.stop_reason === 'refusal') {
          // The turn is dropped. The conversation keeps the patient's message and a plain reply.
          rollBack()
          conv.messages.push({ role: 'user', content: message }, { role: 'assistant', content: REFUSAL_REPLY })
          log('health-bot: model declined a request')
          return { reply: REFUSAL_REPLY, toolCalls: [] }
        }
        if (response.stop_reason === 'max_tokens') {
          throw new TurnError(502, 'The model reply was cut off before it finished. Please try again.')
        }
        if (response.stop_reason !== 'end_turn' && response.stop_reason !== 'tool_use') {
          throw new TurnError(502, `The model stopped for an unexpected reason (${response.stop_reason ?? 'none'}).`)
        }

        // The full content goes back unchanged, so thinking blocks stay valid.
        conv.messages.push({ role: 'assistant', content: response.content as Anthropic.ContentBlockParam[] })
        for (const block of response.content) {
          if (block.type === 'text' && block.text.trim() !== '') texts.push(block.text.trim())
        }

        if (response.stop_reason === 'end_turn') {
          return { reply: texts.join('\n\n'), toolCalls }
        }

        const results: Anthropic.ToolResultBlockParam[] = []
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue
          toolCalls.push({ name: block.name, args: (block.input ?? {}) as Record<string, unknown> })
          const { status, isError } = runTool(block.name, block.input, conv)
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: status,
            ...(isError ? { is_error: true } : {}),
          })
        }
        if (results.length === 0) throw new TurnError(502, 'The model asked for a tool but named none.')
        conv.messages.push({ role: 'user', content: results })
      }
      throw new TurnError(502, `The model kept calling tools after ${MAX_TOOL_ITERATIONS} rounds. Please try again.`)
    } catch (err) {
      // A turn that did not finish leaves no trace: history and appointment return to where they were.
      rollBack()
      throw err
    }
  }

  async function readJson(req: IncomingMessage): Promise<unknown> {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large')
      chunks.push(chunk as Buffer)
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      throw new HttpError(400, 'request body is not valid JSON')
    }
  }

  function send(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...extraHeaders })
    res.end(payload)
  }

  async function handleChat(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req)
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'request body must be a JSON object')
    const { message, conversation_id: requested } = body as { message?: unknown; conversation_id?: unknown }
    if (typeof message !== 'string' || message.trim() === '') throw new HttpError(400, 'message is required')
    if (requested !== undefined && typeof requested !== 'string') throw new HttpError(400, 'conversation_id must be a string')
    if (requested !== undefined && !conversations.has(requested)) throw new HttpError(404, 'unknown conversation_id')

    const id = requested ?? randomUUID()
    const isNew = requested === undefined
    const conv: Conversation =
      conversations.get(id) ?? { messages: [], appointment: newAppointment(), escalations: 0, tail: Promise.resolve() }
    if (isNew) conversations.set(id, conv)

    // One turn at a time per conversation, in arrival order.
    const turn = conv.tail.then(() => runTurn(conv, message))
    conv.tail = turn.catch(() => undefined)
    try {
      const { reply, toolCalls } = await turn
      send(res, 200, { reply, conversation_id: id, tool_calls: toolCalls })
    } catch (err) {
      // A conversation whose first turn failed was never seen by the caller. Forget it.
      if (isNew && conv.messages.length === 0) conversations.delete(id)
      const failure = err instanceof TurnError ? err : classifyUpstreamError(err)
      send(res, failure.status, { error: failure.message })
    }
  }

  async function handler(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')

      if (url.pathname === '/health') {
        if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
        return send(res, 200, { ok: true })
      }

      if (url.pathname.startsWith('/appointments/')) {
        if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
        let id: string
        try {
          id = decodeURIComponent(url.pathname.slice('/appointments/'.length))
        } catch {
          return send(res, 400, { error: 'bad conversation id' })
        }
        const conv = conversations.get(id)
        return conv ? send(res, 200, conv.appointment) : send(res, 404, { error: 'unknown conversation' })
      }

      if (url.pathname === '/chat') {
        if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
        return await handleChat(req, res)
      }

      send(res, 404, { error: 'not found' })
    } catch (err) {
      if (err instanceof HttpError) {
        send(res, err.status, { error: err.message }, err.status === 413 ? { connection: 'close' } : {})
        // Let the client finish sending so it reads the answer instead of a reset.
        if (err.status === 413) req.resume()
        return
      }
      log('health-bot: unexpected server error')
      send(res, 500, { error: 'internal error' })
    }
  }

  const server: Server = createServer((req, res) => void handler(req, res))
  return {
    server,
    /** Starts listening on 127.0.0.1 only. Port 0 picks a free port. Resolves to the base URL. */
    listen(port = 0): Promise<string> {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject)
          const addr = server.address()
          resolve(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : port}`)
        })
      })
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()))
        server.closeAllConnections()
      })
    },
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
