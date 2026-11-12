import type { CompleteRequest, CompleteResponse, ModelProvider } from '../core/interfaces.js'

// A scripted provider for tests. No network, no cost, deterministic.
//
// It honours the real provider's contract: when a schema is given, `parsed` is
// present only if the scripted output validates against it. A grader must treat
// a missing `parsed` as an invalid response.

export type FakeReply =
  | { json: unknown }
  | { text: string }
  | { error: Error | string }
  | { refusal: true }

export interface FakeProvider extends ModelProvider {
  calls: CompleteRequest[]
}

export function createFakeProvider(
  script: FakeReply | FakeReply[] | ((req: CompleteRequest, call: number) => FakeReply),
  opts: { model?: string; servedBy?: string } = {},
): FakeProvider {
  const calls: CompleteRequest[] = []
  const model = opts.model ?? 'fake-model'

  return {
    calls,
    async complete(req): Promise<CompleteResponse> {
      const n = calls.length
      calls.push(req)
      const reply = typeof script === 'function' ? script(req, n) : Array.isArray(script) ? script[Math.min(n, script.length - 1)]! : script

      if ('error' in reply) throw reply.error instanceof Error ? reply.error : new Error(reply.error)

      const usage = { inputTokens: 100, outputTokens: 50, costUsd: 0 }
      const modelRef = { provider: 'fake', model, ...(opts.servedBy ? { servedBy: opts.servedBy } : {}) }

      if ('refusal' in reply) return { text: '', usage, model: modelRef, stopReason: 'refusal' }

      const text = 'json' in reply ? JSON.stringify(reply.json) : reply.text
      let parsed: unknown
      if (req.schema) {
        try {
          const result = req.schema.safeParse(JSON.parse(text))
          if (result.success) parsed = result.data
        } catch {
          // not JSON: leave parsed undefined
        }
      }
      return { text, parsed, usage, model: modelRef, stopReason: 'end_turn' }
    },
  }
}
