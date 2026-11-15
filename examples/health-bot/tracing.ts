// Opt-in Langfuse tracing for the health bot. See LANGFUSE.md.
//
// The bot talks to a small `Tracer` interface. The default is a no-op. The real
// implementation (Langfuse Cloud through its OpenTelemetry-based JS SDK) is only
// loaded when both LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set, with dynamic
// imports, so a bot without keys never loads the SDK, opens a connection or logs.
//
// Rules this file keeps
//  - Telemetry never affects the bot. `guardTracer` wraps every call in try/catch, so a
//    tracer that throws (or rejects) changes nothing about a /chat response.
//  - Nothing here awaits the network on the request path. The SDK records spans in
//    memory and exports them in the background. Only `shutdown` waits, and it is
//    capped at SHUTDOWN_TIMEOUT_MS.
//  - Keys, message text and tool arguments are never logged. A log line holds only a
//    fixed sentence and an error class name.
//  - No user id and no IP address is recorded. The session is the conversation id.
//  - There is no redaction hook yet. Traces contain the conversation text.

export const DEFAULT_LANGFUSE_BASE_URL = 'https://cloud.langfuse.com'
export const SHUTDOWN_TIMEOUT_MS = 5_000

export interface TurnStart {
  /** The bot's conversation_id. Becomes the Langfuse session. */
  sessionId: string
  /** The patient's message. */
  input: string
  /** Trace tags, for example `defect:none`. */
  tags: string[]
  /** Trace metadata, for example the bot model. */
  metadata: Record<string, string>
}

export interface TurnEnd {
  /** The HTTP status the turn produced. */
  status: number
  /** The reply, when the turn produced one. */
  output?: string
  /** A fixed, safe message when the turn failed. */
  error?: string
  toolCallCount?: number
}

export interface GenerationStart {
  model: string
  system: string
  /** The conversation as sent to the model. The tracer must not rely on it staying unchanged. */
  messages: readonly unknown[]
  modelParameters: { max_tokens: number; effort: string }
}

export interface GenerationUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

export interface GenerationEnd {
  /** The assistant content blocks. */
  output?: unknown
  usage?: GenerationUsage
  stopReason?: string | null
  /** A fixed, safe message when the call failed. */
  error?: string
}

export interface ToolStart {
  name: string
  args: Record<string, unknown>
}

export interface ToolEnd {
  status: string
  isError: boolean
}

export interface GenerationTrace {
  end(info: GenerationEnd): void
}
export interface ToolTrace {
  end(info: ToolEnd): void
}
export interface TurnTrace {
  /** One model call (one `messages.create`). */
  generation(info: GenerationStart): GenerationTrace
  /** One tool call, as a child of the turn. */
  toolCall(info: ToolStart): ToolTrace
  end(info: TurnEnd): void
}
export interface Tracer {
  /** One POST /chat turn. */
  startTurn(info: TurnStart): TurnTrace
  /** Sends what is still buffered and stops. Resolves within SHUTDOWN_TIMEOUT_MS. */
  shutdown(): Promise<void>
}

const noopGeneration: GenerationTrace = { end: () => undefined }
const noopTool: ToolTrace = { end: () => undefined }
const noopTurn: TurnTrace = { generation: () => noopGeneration, toolCall: () => noopTool, end: () => undefined }

/** The default tracer. Does nothing, imports nothing. */
export const noopTracer: Tracer = { startTurn: () => noopTurn, shutdown: async () => undefined }

/**
 * Wraps a tracer so that nothing it does can reach the bot: every method is guarded, a
 * failed `startTurn`/`generation`/`toolCall` hands back a no-op handle, and a returned
 * promise that rejects is swallowed. The first failure writes one short line to `log`
 * (an error class name only). Later failures are silent.
 */
export function guardTracer(tracer: Tracer, log: (line: string) => void): Tracer {
  if (tracer === noopTracer) return tracer
  let reported = false
  const failed = (err: unknown) => {
    if (reported) return
    reported = true
    try {
      log(`health-bot: tracing error (${err instanceof Error ? err.name : 'unknown'}), tracing is best effort`)
    } catch {
      // The log itself failed. Nothing more to do.
    }
  }
  const call = <T>(fn: () => T, fallback: T): T => {
    try {
      const result = fn()
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        void Promise.resolve(result).catch(failed)
      }
      return result ?? fallback
    } catch (err) {
      failed(err)
      return fallback
    }
  }
  return {
    startTurn(info) {
      const turn = call(() => tracer.startTurn(info), noopTurn)
      return {
        generation: g => {
          const gen = call(() => turn.generation(g), noopGeneration)
          return { end: e => call(() => gen.end(e), undefined) }
        },
        toolCall: t => {
          const tool = call(() => turn.toolCall(t), noopTool)
          return { end: e => call(() => tool.end(e), undefined) }
        },
        end: e => call(() => turn.end(e), undefined),
      }
    },
    shutdown: () => call(() => tracer.shutdown(), Promise.resolve()).catch(failed),
  }
}

export interface TracingSetup {
  tracer: Tracer
  enabled: boolean
  /** The host of the Langfuse base URL, when enabled. Never a key. */
  host?: string
  /** Set when keys were present but the SDK could not start. */
  failed?: boolean
}

/**
 * Chooses the tracer from the environment. Without both keys this returns the no-op
 * tracer and loads nothing. With keys it loads the SDK and starts it. If that fails for
 * any reason the bot runs untraced and one short line is logged.
 */
export async function createTracerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = line => console.error(line),
): Promise<TracingSetup> {
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim()
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim()
  if (!publicKey || !secretKey) return { tracer: noopTracer, enabled: false }

  try {
    const baseUrl = (env.LANGFUSE_BASE_URL?.trim() || DEFAULT_LANGFUSE_BASE_URL).replace(/\/+$/, '')
    const parsed = new URL(baseUrl)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new TypeError('LANGFUSE_BASE_URL must be an http(s) URL')
    // Imported only now, so a bot without keys never loads the SDK.
    const { startLangfuseTracer } = await import('./langfuse-tracer.js')
    const tracer = await startLangfuseTracer({
      publicKey,
      secretKey,
      baseUrl,
      // The SDK has its own logger. Keep it quiet unless the person asks for it.
      quietSdk: env.LANGFUSE_LOG_LEVEL === undefined && env.LANGFUSE_DEBUG === undefined,
    })
    return { tracer: guardTracer(tracer, log), enabled: true, host: parsed.host }
  } catch (err) {
    try {
      log(`health-bot: Langfuse tracing could not start (${err instanceof Error ? err.name : 'unknown'}), continuing without it`)
    } catch {
      // ignore
    }
    return { tracer: noopTracer, enabled: false, failed: true }
  }
}
