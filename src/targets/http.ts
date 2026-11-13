import { interpolateEnv, type TargetConfig } from '../core/config.js'
import type { RunContext, Target, TargetInput, TargetReply } from '../core/interfaces.js'
import { queryAll, queryOne } from '../core/jsonpath.js'
import type { ToolCall, ToolCallSupport } from '../core/trace.js'

// A generic adapter for any agent with an HTTP endpoint. The request body is
// built from a template and the reply text, session id and tool calls are read
// from the response using JSON paths, so a new agent needs configuration, not
// code.

export type HttpTargetConfig = Extract<TargetConfig, { kind: 'http' }>

export interface HttpTargetOptions {
  /** Override for tests. Defaults to the global fetch. */
  fetch?: typeof fetch
  /** Where ${env:NAME} references are resolved from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
}

const WHOLE_TEMPLATE = /^\{\{\s*([a-z.]+)\s*\}\}$/
const ANY_TEMPLATE = /\{\{\s*([a-z.]+)\s*\}\}/g

type Vars = { 'input.text': unknown; 'input.payload': unknown; session: unknown }

function lookup(name: string, vars: Vars): unknown {
  if (name in vars) return vars[name as keyof Vars]
  throw new Error(`unknown template variable "{{${name}}}". Known: input.text, input.payload, session`)
}

/**
 * Renders a template value. A string that is exactly one placeholder keeps the
 * value's own type (so a payload object stays an object, and a missing session
 * becomes null). A placeholder inside a longer string is spliced in as text.
 */
export function renderTemplate(template: unknown, vars: Vars): unknown {
  if (typeof template === 'string') {
    const whole = WHOLE_TEMPLATE.exec(template)
    if (whole) return lookup(whole[1]!, vars) ?? null
    return template.replace(ANY_TEMPLATE, (_, name: string) => {
      const v = lookup(name, vars)
      return v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v)
    })
  }
  if (Array.isArray(template)) return template.map(item => renderTemplate(item, vars))
  if (template !== null && typeof template === 'object') {
    return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, renderTemplate(v, vars)]))
  }
  return template
}

function extractToolCalls(body: unknown, mapping: NonNullable<HttpTargetConfig['response']['toolCalls']>): ToolCall[] {
  return queryAll(body, mapping.path).map((element, i) => {
    const name = queryOne(element, mapping.name)
    if (typeof name !== 'string' || name === '') {
      throw new Error(`tool call ${i} has no string name at ${mapping.name}`)
    }
    const args = queryOne(element, mapping.arguments)
    // Some agents return arguments as a JSON string. Accept both.
    let parsed: unknown = args
    if (typeof args === 'string') {
      try {
        parsed = JSON.parse(args)
      } catch {
        throw new Error(`tool call "${name}" arguments at ${mapping.arguments} are a string that is not valid JSON`)
      }
    }
    const argsObject =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    return { name, arguments: argsObject }
  })
}

export function createHttpTarget(
  name: string,
  config: HttpTargetConfig,
  options: HttpTargetOptions = {},
): Target<string> {
  const doFetch = options.fetch ?? fetch
  const env = options.env ?? process.env
  const toolCalls: ToolCallSupport = config.toolCalls ?? (config.response.toolCalls ? 'reported' : 'none')

  if (toolCalls !== 'none' && !config.response.toolCalls) {
    throw new Error(`target "${name}" declares toolCalls: ${toolCalls} but has no response.toolCalls mapping`)
  }

  return {
    name,
    kind: 'http',
    capabilities: { multiTurn: true, toolCalls },

    async send(input: TargetInput, session: string | undefined, ctx: RunContext): Promise<TargetReply<string>> {
      const body = renderTemplate(config.request.body, {
        'input.text': input.text,
        'input.payload': input.payload,
        session,
      })
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      for (const [k, v] of Object.entries(config.headers)) headers[k.toLowerCase()] = interpolateEnv(v, env)

      const signals = [AbortSignal.timeout(config.timeoutMs)]
      if (ctx.signal) signals.push(ctx.signal)

      let res: Response
      try {
        res = await doFetch(config.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.any(signals),
        })
      } catch (err) {
        // The caller stopped the run: say so, instead of blaming the target for a timeout.
        if (ctx.signal?.aborted) throw new Error('The run was cancelled.')
        if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
          throw new Error(`target "${name}" did not respond within ${config.timeoutMs}ms`)
        }
        throw new Error(`target "${name}" request failed: ${err instanceof Error ? err.message : String(err)}`)
      }

      const text = await res.text()
      if (!res.ok) {
        // Truncated, and never echoes request headers, which may hold credentials.
        throw new Error(`target "${name}" returned HTTP ${res.status}: ${text.slice(0, 300)}`)
      }

      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error(`target "${name}" returned a non-JSON response: ${text.slice(0, 300)}`)
      }

      const reply = queryOne(json, config.response.text)
      if (typeof reply !== 'string') {
        throw new Error(
          `target "${name}" response has no string at ${config.response.text}. Check response.text in the config.`,
        )
      }

      const nextSession = config.response.session ? queryOne(json, config.response.session) : undefined
      return {
        text: reply,
        toolCalls: config.response.toolCalls ? extractToolCalls(json, config.response.toolCalls) : [],
        raw: json,
        session: typeof nextSession === 'string' || typeof nextSession === 'number' ? String(nextSession) : session,
      }
    },
  }
}
