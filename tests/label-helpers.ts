import { splitOfKey } from '../src/index.js'
import type { Label, Split } from '../src/index.js'

export const label = (over: Partial<Label> = {}): Label => ({
  id: 'l1', criterion: 'confirms', input: 'Move it', output: 'Done.', verdict: 'fail',
  critique: 'Acted without confirming.', labeler: 'expert-1', sampled_by: 'random', at: '2026-11-12T10:00:00Z', ...over,
})

/** The first id with this prefix that the stable hash puts in the given split. */
export function idInSplit(split: Split, prefix = 'id', skip = 0): string {
  let found = 0
  for (let i = 0; i < 10_000; i++) {
    const id = `${prefix}-${i}`
    if (splitOfKey(id) === split && found++ === skip) return id
  }
  throw new Error(`no id found for split ${split}`)
}

/**
 * A synthetic label set big enough to fill every split. Expert verdicts
 * alternate, 70 percent are randomly sampled, and every output is unique so
 * content never collides across splits.
 */
export function syntheticLabels(n = 400): Label[] {
  return Array.from({ length: n }, (_, i) =>
    label({
      id: `syn-${i}`,
      output: `response number ${i}`,
      input: `question number ${i}`,
      verdict: i % 2 === 0 ? 'pass' : 'fail',
      sampled_by: i % 10 < 7 ? 'random' : 'targeted',
    }),
  )
}
