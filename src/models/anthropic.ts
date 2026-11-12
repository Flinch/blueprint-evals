import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { CompleteRequest, CompleteResponse, ModelProvider } from '../core/interfaces.js'
import type { Effort, Usage } from '../core/trace.js'

// The default model provider. Every LLM call the framework makes (the simulated
// user and the judges) goes through here.
//
// Choices worth knowing about:
//  - Thinking is left at the API default. Current models (Opus 5.5 and later)
//    run adaptive thinking and reject attempts to disable it, so effort is the
//    only depth control. Effort is set explicitly per call: Opus 5.5 defaults to
//    `medium`, and a judge should not silently inherit that.
//  - Sampling parameters (temperature and friends) are not sent: current models
//    reject them. Reproducibility comes from pinned versions and repeated
//    trials (M2), not from temperature 0.
//  - Structured output is requested for judges, and the result is validated
//    again here. The API enforces the JSON structure but not value ranges such
//    as "score between 0 and 1".
//  - A safety refusal comes back as stopReason "refusal", never as text, so a
//    grader cannot mistake it for a verdict.
//  - Server-side fallbacks are on by default: a declined request is retried on
//    another model inside the same call. The model that actually answered is
//    reported in `model.servedBy` so judge-calibration statistics can exclude
//    verdicts the pinned judge did not produce.
//  - Requests stream. Long judge calls with thinking can exceed HTTP timeouts
//    when buffered.

export interface ModelSettings {
  model: string
  effort?: Effort
  /** Retry a declined request on another model inside the same call. Default true. */
  fallbacks?: boolean
}

export interface Pricing {
  inputPerMTok: number
  outputPerMTok: number
}

export interface AnthropicProviderOptions {
  models: { simulator: ModelSettings; judge: ModelSettings }
  /** USD per million tokens, keyed by model id. A model with no entry has unknown cost (null). */
  pricing?: Record<string, Pricing>
  /** Defaults to a client that reads ANTHROPIC_API_KEY (or an `ant auth login` profile). */
  client?: Pick<Anthropic, 'beta'>
}

const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
const DEFAULT_MAX_TOKENS = { simulator: 4_096, judge: 16_000 } as const

export function buildRequest(req: CompleteRequest, settings: ModelSettings) {
  const effort = req.effort ?? settings.effort
  const useFallbacks = settings.fallbacks !== false
  return {
    model: settings.model,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS[req.role],
    ...(req.system ? { system: req.system } : {}),
    messages: req.messages,
    output_config: {
      ...(effort ? { effort } : {}),
      ...(req.schema ? { format: zodOutputFormat(req.schema) } : {}),
    },
    ...(useFallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
  }
}

function priceUsd(model: string, input: number, output: number, pricing: Record<string, Pricing>): number | null {
  const p = pricing[model]
  if (!p) return null
  return (input * p.inputPerMTok + output * p.outputPerMTok) / 1_000_000
}

/**
 * Tokens and cost for one call. When the API reports per-iteration usage (as it
 * does when a fallback ran), each iteration is priced at its own model's rates,
 * because a declined attempt and the rescuing attempt bill differently.
 * Cache tokens are counted as ordinary input, a conservative overestimate: the
 * framework does not use prompt caching.
 */
export function usageFrom(
  message: { model: string; usage: Anthropic.Beta.BetaUsage },
  requestedModel: string,
  pricing: Record<string, Pricing>,
): { usage: Usage; servedBy?: string } {
  const u = message.usage
  const iterations = (u.iterations ?? []).filter(
    (it): it is Extract<typeof it, { type: 'message' | 'fallback_message' }> => it.type === 'message' || it.type === 'fallback_message',
  )

  if (iterations.length > 0) {
    let input = 0
    let output = 0
    let cost: number | null = 0
    for (const it of iterations) {
      const inTok = it.input_tokens + it.cache_creation_input_tokens + it.cache_read_input_tokens
      input += inTok
      output += it.output_tokens
      const c = priceUsd(it.model ?? requestedModel, inTok, it.output_tokens, pricing)
      cost = cost === null || c === null ? null : cost + c
    }
    const fallback = iterations.find(it => it.type === 'fallback_message')
    return { usage: { inputTokens: input, outputTokens: output, costUsd: cost }, servedBy: fallback?.model }
  }

  const input = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
  return {
    usage: { inputTokens: input, outputTokens: u.output_tokens, costUsd: priceUsd(message.model || requestedModel, input, u.output_tokens, pricing) },
  }
}

function describeError(err: unknown, timeoutMs: number): Error {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    const shown = timeoutMs < 1000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1000)}s`
    return new Error(`The model call exceeded its ${shown} deadline and was cancelled.`)
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return new Error('Anthropic rejected the credentials (401). Check ANTHROPIC_API_KEY.')
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new Error('Anthropic rate limit reached (429) after retries.')
  }
  if (err instanceof Anthropic.APIError) {
    return new Error(`Anthropic API error ${err.status ?? ''}: ${err.message}`.trim())
  }
  return err instanceof Error ? err : new Error(String(err))
}

export function createAnthropicProvider(options: AnthropicProviderOptions): ModelProvider {
  const client = options.client ?? new Anthropic()
  const pricing = options.pricing ?? {}

  return {
    async complete(req: CompleteRequest): Promise<CompleteResponse> {
      const settings = options.models[req.role]
      const params = buildRequest(req, settings)

      // One deadline for the whole call. The SDK retries timeouts on its own,
      // which would multiply a per-attempt timeout, so the deadline is a signal.
      const signals = [AbortSignal.timeout(req.timeoutMs)]
      if (req.signal) signals.push(req.signal)

      let message
      try {
        message = await client.beta.messages.stream(params, { signal: AbortSignal.any(signals) }).finalMessage()
      } catch (err) {
        throw describeError(err, req.timeoutMs)
      }

      const { usage, servedBy } = usageFrom(message, settings.model, pricing)
      const effort = req.effort ?? settings.effort
      const model = {
        provider: 'anthropic',
        model: settings.model,
        ...(effort ? { effort } : {}),
        ...(servedBy ? { servedBy } : {}),
      }
      const stopReason = message.stop_reason ?? 'unknown'

      // Only the model's text. Thinking and fallback-boundary blocks are not output.
      const text = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map(b => b.text)
        .join('')

      if (stopReason === 'refusal') return { text: '', usage, model, stopReason }

      let parsed: unknown
      if (req.schema && text) {
        try {
          const result = req.schema.safeParse(JSON.parse(text))
          if (result.success) parsed = result.data
        } catch {
          // not JSON: parsed stays undefined, and the grader reports it as invalid output
        }
      }
      return { text, parsed, usage, model, stopReason }
    },
  }
}
