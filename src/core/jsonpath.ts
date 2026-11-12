// A deliberately small JSONPath subset, enough to locate fields in an agent's
// HTTP response without pulling in a dependency:
//
//   $            the root
//   $.a.b        property access
//   $.a[0]       array index
//   $.a[*]       every element of an array (fan-out)
//   $.a['b-c']   property names that are not identifiers
//
// Anything else (filters, recursive descent, slices) is rejected at parse time
// with a clear message rather than silently returning nothing.

type Step = { kind: 'key'; key: string } | { kind: 'index'; index: number } | { kind: 'all' }

export function parsePath(path: string): Step[] {
  if (path === '$') return []
  if (!path.startsWith('$')) throw new Error(`JSON path must start with "$": ${path}`)
  const steps: Step[] = []
  let i = 1
  while (i < path.length) {
    const ch = path[i]
    if (ch === '.') {
      const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(path.slice(i + 1))
      if (!m) throw new Error(`unsupported JSON path syntax at position ${i}: ${path}`)
      steps.push({ kind: 'key', key: m[0] })
      i += 1 + m[0].length
    } else if (ch === '[') {
      const end = path.indexOf(']', i)
      if (end === -1) throw new Error(`unterminated "[" in JSON path: ${path}`)
      const inner = path.slice(i + 1, end)
      if (inner === '*') steps.push({ kind: 'all' })
      else if (/^\d+$/.test(inner)) steps.push({ kind: 'index', index: Number(inner) })
      else if (/^'[^']*'$/.test(inner)) steps.push({ kind: 'key', key: inner.slice(1, -1) })
      else throw new Error(`unsupported JSON path segment "[${inner}]": ${path}`)
      i = end + 1
    } else {
      throw new Error(`unsupported JSON path syntax at position ${i}: ${path}`)
    }
  }
  return steps
}

/** Returns every value the path matches. A missing path yields an empty array. */
export function queryAll(root: unknown, path: string): unknown[] {
  let current: unknown[] = [root]
  for (const step of parsePath(path)) {
    const next: unknown[] = []
    for (const value of current) {
      if (step.kind === 'key') {
        if (value !== null && typeof value === 'object' && !Array.isArray(value) && step.key in value) {
          next.push((value as Record<string, unknown>)[step.key])
        }
      } else if (step.kind === 'index') {
        if (Array.isArray(value) && step.index < value.length) next.push(value[step.index])
      } else if (Array.isArray(value)) {
        next.push(...value)
      }
    }
    current = next
  }
  return current
}

/** Returns the first match, or undefined. */
export function queryOne(root: unknown, path: string): unknown {
  return queryAll(root, path)[0]
}
