import { existsSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import type { Config } from '../core/config.js'
import type { ModelProvider } from '../core/interfaces.js'
import { UsageError } from '../engine/errors.js'
import { createAnthropicProvider } from '../models/anthropic.js'

/** Everything the CLI touches in the outside world, injectable so tests can capture it. */
export interface CliIo {
  /** Receives text as written, newlines included. */
  stdout(text: string): void
  stderr(text: string): void
  env: NodeJS.ProcessEnv
  cwd: string
  /** True when a person can answer a question. False in CI and when output is piped. */
  isTTY: boolean
  confirm(question: string): Promise<boolean>
  /** Builds the model provider. Defaults to the Anthropic provider built from the config. */
  createProvider?(config: Config): ModelProvider
  /** Passed to http targets. Defaults to the global fetch. */
  fetch?: typeof fetch
  /** Where the `.evals/` data directory lives. Defaults to `cwd`. */
  workdir?: string
  /** Long-running commands (`evals ui`) stop when this aborts. The real entry point aborts it on Ctrl+C. */
  signal?: AbortSignal
  /** Opens a URL in the user's browser. Defaults to the platform's opener. */
  openUrl?(url: string): void
}

/** Something the user can fix on the command line or in their files. Exit code 2. */
export { UsageError } from '../engine/errors.js'

export const DEFAULT_CONFIG = 'evals.config.yaml'

export function print(write: (text: string) => void, text = ''): void {
  write(`${text}\n`)
}

/** Turns the errors node:util's parseArgs throws into usage errors. */
export function parseOrUsage<T>(parse: () => T): T {
  try {
    return parse()
  } catch (e) {
    const code = (e as { code?: string }).code
    if (e instanceof Error && typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS')) throw new UsageError(e.message)
    throw e
  }
}

/** Runs a loader and re-throws its error as a usage error, since the fix is in the user's files. */
export function orUsage<T>(load: () => T): T {
  try {
    return load()
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e))
  }
}

export const abs = (io: CliIo, path: string) => resolve(io.cwd, path)
export const shown = (io: CliIo, path: string) => relative(io.cwd, path) || '.'

export function requireFile(io: CliIo, path: string, what: string, hint = ''): string {
  const full = abs(io, path)
  if (!existsSync(full) || !statSync(full).isFile()) throw new UsageError(`${what} not found: ${shown(io, full)}${hint}`)
  return full
}

/** The scenarios path: the one given, else ./scenarios if it exists. */
export function scenariosPath(io: CliIo, given: string | undefined): string {
  if (given !== undefined) {
    const full = abs(io, given)
    if (!existsSync(full)) throw new UsageError(`scenarios path not found: ${shown(io, full)}`)
    return full
  }
  const fallback = abs(io, 'scenarios')
  if (existsSync(fallback) && statSync(fallback).isDirectory()) return fallback
  throw new UsageError('no scenarios path given and there is no "scenarios" directory here. Pass a path, for example: evals validate examples/scenarios')
}

export function configPath(io: CliIo, given: string | undefined): string {
  return requireFile(io, given ?? DEFAULT_CONFIG, 'config file', given === undefined ? ` (looked for ${DEFAULT_CONFIG} in the current directory, or pass --config)` : '')
}

export function parseMaxCost(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  const n = Number(text)
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--max-cost must be a positive number of US dollars, got "${text}"`)
  return n
}

export type SpendDecision = 'go' | 'declined'

/**
 * The gate in front of anything that can spend money. `--yes` passes it. A
 * person at a terminal is asked. Anywhere else (CI, a pipe) there is nobody to
 * ask, so it refuses instead of guessing.
 */
export async function confirmSpend(io: CliIo, yes: boolean, what: string): Promise<SpendDecision> {
  if (yes) return 'go'
  if (!io.isTTY) {
    throw new UsageError(
      `${what} can call a model, which costs money, and there is no terminal to ask for confirmation. Nothing was run. Pass --yes to go ahead.`,
    )
  }
  return (await io.confirm('Continue? [y/N]')) ? 'go' : 'declined'
}

/** The real provider: Anthropic, with the config's models and prices. */
export function defaultProvider(config: Config): ModelProvider {
  return createAnthropicProvider({ models: config.models, pricing: config.pricing })
}
