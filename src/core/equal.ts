/**
 * Strict structural equality for JSON-like values: same types, same keys, same
 * values, key order ignored. No coercion and no semantic matching ("tomorrow"
 * is not equal to a date). Semantic argument matching arrives in M3.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const keys = Object.keys(ao)
  return keys.length === Object.keys(bo).length && keys.every(k => k in bo && deepEqual(ao[k], bo[k]))
}
