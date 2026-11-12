import type { RunContext, Target, TargetInput, TargetReply, ToolCall, ToolCallSupport } from '../src/index.js'

export interface FakeTarget extends Target<string> {
  inputs: TargetInput[]
  started: number
  ended: number
}

type Reply = { text: string; toolCalls?: ToolCall[]; raw?: unknown }

/** A target whose replies are computed by a function. Records what it was sent. */
export function fakeTarget(
  reply: (input: TargetInput, call: number) => Reply | Promise<Reply>,
  opts: { name?: string; toolCalls?: ToolCallSupport; failOnStart?: boolean; failOnEnd?: boolean } = {},
): FakeTarget {
  const t: FakeTarget = {
    name: opts.name ?? 'fake-target',
    kind: 'fake',
    capabilities: { multiTurn: true, toolCalls: opts.toolCalls ?? 'reported' },
    inputs: [],
    started: 0,
    ended: 0,
    async start(_ctx: RunContext) {
      t.started++
      if (opts.failOnStart) throw new Error('could not start the target')
      return 'session-1'
    },
    async send(input: TargetInput, session: string | undefined): Promise<TargetReply<string>> {
      const n = t.inputs.length
      t.inputs.push(input)
      const r = await reply(input, n)
      return { text: r.text, toolCalls: r.toolCalls ?? [], raw: r.raw, session }
    },
    async end() {
      t.ended++
      if (opts.failOnEnd) throw new Error('cleanup blew up')
    },
  }
  return t
}
