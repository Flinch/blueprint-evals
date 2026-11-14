import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

export interface DotEnvResult {
  /** Whether the file existed. */
  found: boolean
  /** The names (never the values) that were applied to the environment. */
  applied: string[]
}

/**
 * Reads a `.env` file into the process environment, so credentials live in one
 * gitignored file instead of being exported in every terminal window.
 *
 * The file wins over variables already in the shell. A stale variable left in a
 * terminal (an old key, a proxy URL) would otherwise silently beat the file, which
 * is the opposite of what a person editing the file expects. A blank value in the
 * file is ignored, so an unfilled `ANTHROPIC_API_KEY=` placeholder never wipes a
 * real key that is already exported.
 *
 * Returns names only. Values are never logged.
 */
export function loadDotEnv(path = '.env', env: NodeJS.ProcessEnv = process.env): DotEnvResult {
  if (!existsSync(path)) return { found: false, applied: [] }
  const parsed = parseEnv(readFileSync(path, 'utf8'))
  const applied: string[] = []
  for (const [name, value] of Object.entries(parsed)) {
    if (value === undefined || value.trim() === '') continue
    env[name] = value.trim()
    applied.push(name)
  }
  return { found: true, applied }
}
