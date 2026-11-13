import { readFileSync } from 'node:fs'

// Defence in depth for "never return a secret value". Nothing in the API is
// built from the environment, but a target can echo a header back in an error
// or a reply, and a saved trace holds whatever the target said. So every
// outgoing body is scrubbed of the values of the environment variables that
// look like secrets, and of any variable the config refers to with ${env:NAME}.

const SECRET_NAME = /key|token|secret|password|passwd|credential|auth|cookie|session/i
const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g
/** Shorter values would shred ordinary text, and are not credentials anyway. */
const MIN_LENGTH = 6

export function secretValues(env: NodeJS.ProcessEnv, configFile: string | null): string[] {
  const names = new Set(Object.keys(env).filter(n => SECRET_NAME.test(n)))
  if (configFile) {
    try {
      for (const m of readFileSync(configFile, 'utf8').matchAll(ENV_REF)) names.add(m[1]!)
    } catch {
      // No readable config: only the name pattern applies.
    }
  }
  const values = new Set<string>()
  for (const n of names) {
    const v = env[n]
    if (typeof v === 'string' && v.length >= MIN_LENGTH) values.add(v)
  }
  // Longest first, so a secret that contains another is replaced whole.
  return [...values].sort((a, b) => b.length - a.length)
}

/** Replaces each secret value, raw and as it appears inside a JSON string, with [redacted]. */
export function createScrubber(values: string[]): (text: string) => string {
  const needles = values.flatMap(v => {
    const escaped = JSON.stringify(v).slice(1, -1)
    return escaped === v ? [v] : [v, escaped]
  })
  if (needles.length === 0) return text => text
  return text => {
    let out = text
    for (const n of needles) if (out.includes(n)) out = out.split(n).join('[redacted]')
    return out
  }
}
