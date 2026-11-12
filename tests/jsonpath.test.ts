import { describe, expect, it } from 'vitest'
import { queryAll, queryOne } from '../src/index.js'

const doc = { reply: 'hi', a: { b: [{ n: 1 }, { n: 2 }] }, 'x-y': 3, list: [] as unknown[] }

describe('jsonpath subset', () => {
  it('reads properties, indexes and quoted keys', () => {
    expect(queryOne(doc, '$.reply')).toBe('hi')
    expect(queryOne(doc, '$.a.b[1].n')).toBe(2)
    expect(queryOne(doc, "$['x-y']")).toBe(3)
  })
  it('fans out with [*]', () => {
    expect(queryAll(doc, '$.a.b[*].n')).toEqual([1, 2])
  })
  it('returns an empty result for a missing path, never throws', () => {
    expect(queryOne(doc, '$.nope.deeper')).toBeUndefined()
    expect(queryAll(doc, '$.list[*]')).toEqual([])
  })
  it('treats $ as the root so relative paths work on an element', () => {
    expect(queryOne({ name: 'f' }, '$.name')).toBe('f')
    expect(queryOne('plain', '$')).toBe('plain')
  })
  it('rejects unsupported syntax loudly instead of returning nothing', () => {
    expect(() => queryAll(doc, '$..n')).toThrow(/unsupported/)
    expect(() => queryAll(doc, '$.a[?(@.n>1)]')).toThrow(/unsupported/)
    expect(() => queryAll(doc, 'reply')).toThrow(/start with/)
  })
})
