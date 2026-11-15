// The real tracer: Langfuse Cloud through its OpenTelemetry-based JS SDK (v6).
// Loaded only by `createTracerFromEnv` in tracing.ts, and only when keys are set.
//
// Shape of what gets recorded (see LANGFUSE.md)
//   session  = the bot's conversation_id
//   trace    = one POST /chat turn            (root observation "chat-turn")
//   generation = one anthropic messages.create call, child of the turn
//   tool span  = one tool call, child of the turn
//
// The Anthropic client is not wrapped or patched. The bot reports each call to the
// tracer by hand, which is the SDK's documented way to record a model call that has
// no integration (`startObservation(..., { asType: 'generation' })`).

import { configureGlobalLogger, LogLevel } from '@langfuse/core'
import { isLangfuseSpan, LangfuseSpanProcessor } from '@langfuse/otel'
import { propagateAttributes, startObservation } from '@langfuse/tracing'
import { NodeSDK } from '@opentelemetry/sdk-node'
import type { SpanExporter } from '@opentelemetry/sdk-trace-base'
import { SHUTDOWN_TIMEOUT_MS, type GenerationUsage, type Tracer } from './tracing.js'

export interface LangfuseTracerOptions {
  publicKey: string
  secretKey: string
  baseUrl: string
  /** Silences the SDK's own console logger. */
  quietSdk?: boolean
  /** Tests only: a replacement exporter, so nothing leaves the process. */
  exporter?: SpanExporter
  /** Tests only: export each span as it ends. The default is the SDK's batched export. */
  exportMode?: 'batched' | 'immediate'
}

export interface LangfuseTracer extends Tracer {
  /** Waits until everything recorded so far has been handed to the exporter. */
  flush(): Promise<void>
}

const TRACE_NAME = 'chat-turn'

/** A deep copy that cannot throw and leaves out thinking signatures (opaque and long). */
function snapshot(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value, (key, v) => (key === 'signature' ? undefined : v)) ?? 'null')
  } catch {
    return '<not serializable>'
  }
}

/** Anthropic reports input tokens apart from cache tokens, which matches Langfuse's separate usage buckets. */
function usageDetails(usage: GenerationUsage | undefined): Record<string, number> | undefined {
  if (!usage) return undefined
  const out: Record<string, number> = {}
  if (typeof usage.input_tokens === 'number') out.input = usage.input_tokens
  if (typeof usage.output_tokens === 'number') out.output = usage.output_tokens
  if (usage.cache_read_input_tokens) out.cache_read_input_tokens = usage.cache_read_input_tokens
  if (usage.cache_creation_input_tokens) out.cache_creation_input_tokens = usage.cache_creation_input_tokens
  return Object.keys(out).length > 0 ? out : undefined
}

export async function startLangfuseTracer(options: LangfuseTracerOptions): Promise<LangfuseTracer> {
  if (options.quietSdk) configureGlobalLogger({ level: LogLevel.NONE })

  const processor = new LangfuseSpanProcessor({
    publicKey: options.publicKey,
    secretKey: options.secretKey,
    baseUrl: options.baseUrl,
    exportMode: options.exportMode ?? 'batched',
    ...(options.exporter ? { exporter: options.exporter } : {}),
    // The Anthropic SDK also emits OpenTelemetry spans once a provider is registered. The bot turns
    // that off, and this filter keeps anything else out too, so only the bot's own observations leave.
    shouldExportSpan: ({ otelSpan }) => isLangfuseSpan(otelSpan),
    // Message text is plain text. Skip the media scan so no upload call is ever made.
    mediaUploadEnabled: false,
  })
  const sdk = new NodeSDK({ spanProcessors: [processor] })
  sdk.start()

  return {
    startTurn(info) {
      // Trace-level attributes only reach observations created inside this callback, so every
      // observation of the turn is created through `inTrace`. That is what puts the session id
      // and tags on the generations and tool spans as well as on the root.
      const attrs = { sessionId: info.sessionId, tags: info.tags, metadata: info.metadata, traceName: TRACE_NAME }
      const inTrace = <T>(fn: () => T): T => propagateAttributes(attrs, fn)

      const root = inTrace(() => startObservation(TRACE_NAME, { input: info.input }))
      let rootEnded = false

      return {
        generation(g) {
          const gen = inTrace(() =>
            root.startObservation(
              'messages.create',
              {
                model: g.model,
                // Chat format, system prompt first, so the UI renders it as a conversation.
                input: snapshot([{ role: 'system', content: g.system }, ...g.messages]),
                modelParameters: g.modelParameters,
              },
              { asType: 'generation' },
            ),
          )
          let ended = false
          return {
            end(e) {
              if (ended) return
              ended = true
              const usage = usageDetails(e.usage)
              gen.update({
                ...(e.output !== undefined ? { output: snapshot({ role: 'assistant', content: e.output }) } : {}),
                ...(usage ? { usageDetails: usage } : {}),
                ...(e.stopReason ? { metadata: { stop_reason: e.stopReason } } : {}),
                ...(e.error ? { level: 'ERROR' as const, statusMessage: e.error } : {}),
              })
              gen.end()
            },
          }
        },
        toolCall(t) {
          const tool = inTrace(() => root.startObservation(t.name, { input: snapshot(t.args) }, { asType: 'tool' }))
          let ended = false
          return {
            end(e) {
              if (ended) return
              ended = true
              tool.update({
                output: { status: e.status },
                ...(e.isError ? { level: 'ERROR' as const, statusMessage: e.status } : {}),
              })
              tool.end()
            },
          }
        },
        end(e) {
          if (rootEnded) return
          rootEnded = true
          root.update({
            ...(e.output !== undefined ? { output: e.output } : {}),
            metadata: { http_status: e.status, ...(e.toolCallCount !== undefined ? { tool_calls: e.toolCallCount } : {}) },
            ...(e.error ? { level: 'ERROR' as const, statusMessage: e.error } : {}),
          })
          root.end()
        },
      }
    },

    async flush() {
      await processor.forceFlush()
    },

    async shutdown() {
      // Flushes what is buffered, then stops. Never waits longer than the cap, and never throws.
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          sdk.shutdown(),
          new Promise<void>(resolve => {
            timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)
          }),
        ])
      } catch {
        // Telemetry failures never matter on the way out.
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
  }
}
