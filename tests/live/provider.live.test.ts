import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAnthropicProvider } from '../../src/index.js'

// Opt-in: makes two tiny paid API calls (well under one cent on Haiku 5.5) to
// confirm the real API accepts the request the provider builds, returns
// structured output, and reports usage the way the cost code expects.
//
//   EVALS_LIVE=1 ANTHROPIC_API_KEY=... npm test -- tests/live
//
// Skipped otherwise, so CI and a plain `npm test` never spend money.

const live = process.env.EVALS_LIVE === '1'

describe.skipIf(!live)('anthropic provider against the real API', () => {
  const provider = createAnthropicProvider({
    models: {
      simulator: { model: 'claude-haiku-5-5', effort: 'low', fallbacks: false },
      judge: { model: 'claude-haiku-5-5', effort: 'low', fallbacks: false },
    },
    pricing: { 'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5 } },
  })

  it('returns schema-validated structured output with usage and cost', async () => {
    const r = await provider.complete({
      role: 'judge',
      messages: [{ role: 'user', content: 'What is the capital of France? Answer in the required format.' }],
      schema: z.object({ capital: z.string() }),
      maxTokens: 2_000,
      timeoutMs: 60_000,
    })
    expect(r.stopReason).toBe('end_turn')
    expect(r.parsed).toMatchObject({ capital: 'Paris' })
    expect(r.usage.inputTokens).toBeGreaterThan(0)
    expect(r.usage.outputTokens).toBeGreaterThan(0)
    expect(r.usage.costUsd).toBeGreaterThan(0)
  })

  it('returns plain text for the simulator role', async () => {
    const r = await provider.complete({
      role: 'simulator',
      messages: [{ role: 'user', content: 'Reply with one short greeting.' }],
      maxTokens: 2_000,
      timeoutMs: 60_000,
    })
    expect(r.text.length).toBeGreaterThan(0)
    expect(r.parsed).toBeUndefined()
  })
})
