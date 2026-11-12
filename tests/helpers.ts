import type { ToolCall, Trace, ToolCallSupport, Turn } from '../src/index.js'

export function makeTrace(
  turns: Omit<Turn, 'index' | 'at'>[],
  opts: { toolCalls?: ToolCallSupport } = {},
): Trace {
  return {
    schemaVersion: 1,
    runId: 'r1',
    scenario: { id: 's', version: '1' },
    target: { name: 't', kind: 'fake', toolCalls: opts.toolCalls ?? 'reported' },
    turns: turns.map((t, index) => ({ ...t, index, at: '2026-11-12T00:00:00.000Z' })),
    startedAt: '2026-11-12T00:00:00.000Z',
    endedAt: '2026-11-12T00:00:01.000Z',
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    metadata: { frameworkVersion: 'test', models: {} },
  }
}

export const user = (content: string): Omit<Turn, 'index' | 'at'> => ({ role: 'user', content })
export const agent = (content: string, toolCalls: ToolCall[] = [], raw?: unknown): Omit<Turn, 'index' | 'at'> => ({
  role: 'assistant',
  content,
  toolCalls,
  ...(raw !== undefined ? { raw } : {}),
})
export const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ name, arguments: args })
