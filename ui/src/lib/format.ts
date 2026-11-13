// Number and date formatting. Costs and rates can be null, and null is shown as
// "unknown" or "n/a", never as 0.

export const UNKNOWN = 'Unknown'

/** US dollars. null is unknown, never $0. */
export function usd(value: number | null | undefined, opts: { unknown?: string } = {}): string {
  if (value === null || value === undefined) return opts.unknown ?? UNKNOWN
  if (value === 0) return '$0.00'
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`
  if (Math.abs(value) < 1) return `$${value.toFixed(3)}`
  return `$${value.toFixed(2)}`
}

export function percent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a'
  return `${(value * 100).toFixed(digits)}%`
}

export function score(value: number | null | undefined): string {
  return value === null || value === undefined ? 'n/a' : value.toFixed(2)
}

export function count(n: number): string {
  return n.toLocaleString('en-US')
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`
}

export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'n/a'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s - m * 60)}s`
}

export function tokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : count(n)
}

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
const fullFmt = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'medium', hour12: false })

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return 'n/a'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : dateFmt.format(d)
}

export function fullDate(iso: string | null | undefined): string {
  if (!iso) return 'n/a'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : fullFmt.format(d)
}

/** Pretty JSON for display in a <pre>. Always text, never HTML. */
export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}
