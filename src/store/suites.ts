import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Reporter, RunEvent, RunResult } from '../core/interfaces.js'
import { addUsage, ZERO_USAGE, type Usage } from '../core/trace.js'
import { assertSafeId, isSafeId, newId, writeFileAtomic } from './fs.js'

// The run store. Every `evals run` and every run started from the browser saves
// a suite record to <workdir>/.evals/runs/<suiteId>.json. The file is written
// when the suite starts and again after every finished run (atomically), so a
// crashed or killed run leaves the results it had.

/** `failed`: the run machinery itself threw, which a scenario failing never does. */
export type SuiteStatus = 'running' | 'complete' | 'cancelled' | 'failed'

export interface SuiteSummary {
  runs: number
  pass: number
  fail: number
  error: number
  /** Runs with a goal result, and how many of those achieved it. */
  goal: { achieved: number; total: number }
  /** Mean of the runs' derived scores, over runs that have one. */
  avgScore: number | null
  /** Sum of run costs. Null when any run's cost is unknown. */
  costUsd: number | null
  /** Sum of run durations. */
  durationMs: number
  scenarios: string[]
}

export interface SuiteRecord {
  schemaVersion: 1
  suiteId: string
  startedAt: string
  /** Null until the suite ends. A file that still has null long after it started is an interrupted run. */
  endedAt: string | null
  status: SuiteStatus
  /** What started it: the command line, or "evals ui". */
  command: string
  /** Absolute path of the config file the run used. */
  configFile: string
  /** Absolute path of the scenario file or directory the run used. */
  scenarioPath: string
  results: RunResult[]
  summary: SuiteSummary
}

/** A suite record without its results, for listings. */
export type SuiteHeader = Omit<SuiteRecord, 'results'>

export function summarize(results: RunResult[]): SuiteSummary {
  const count = (s: RunResult['status']) => results.filter(r => r.status === s).length
  const withGoal = results.filter(r => r.goalAchieved !== null)
  const scores = results.map(r => r.score).filter((s): s is number => s !== null)
  const costs = results.map(r => r.costUsd)
  return {
    runs: results.length,
    pass: count('pass'),
    fail: count('fail'),
    error: count('error'),
    goal: { achieved: withGoal.filter(r => r.goalAchieved).length, total: withGoal.length },
    avgScore: scores.length === 0 ? null : scores.reduce((a, b) => a + b, 0) / scores.length,
    costUsd: costs.some(c => c === null) ? null : costs.reduce<number>((sum, c) => sum + (c ?? 0), 0),
    durationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
    scenarios: [...new Set(results.map(r => r.trace.scenario.id))],
  }
}

/** Total usage across runs, null-safe, for callers that want tokens as well as cost. */
export function sumUsage(results: RunResult[]): Usage {
  return results.reduce<Usage>((u, r) => addUsage(u, r.trace.usage), ZERO_USAGE)
}

// ------------------------------------------------------------------ writing

export interface SuiteWriterOptions {
  /** The `runs` directory (see storePaths). */
  dir: string
  command: string
  configFile: string
  scenarioPath: string
  startedAt?: Date
  suiteId?: string
}

export interface SuiteWriter extends Reporter {
  readonly suiteId: string
  readonly file: string
  /** Writes the (empty) record now. Throws if the directory is not writable. */
  start(): void
  /** Marks the suite ended and writes the final record. */
  finish(outcome?: { cancelled?: boolean; failed?: boolean; endedAt?: Date }): SuiteRecord
  record(): SuiteRecord
  /** Problems writing after start(). A write failure never fails the run it is recording. */
  readonly warnings: string[]
}

export function createSuiteWriter(options: SuiteWriterOptions): SuiteWriter {
  const startedAt = options.startedAt ?? new Date()
  const suiteId = options.suiteId !== undefined ? assertSafeId(options.suiteId, 'suite id') : newId(startedAt)
  const file = join(options.dir, `${suiteId}.json`)
  const results: RunResult[] = []
  const warnings: string[] = []
  let endedAt: string | null = null
  let status: SuiteStatus = 'running'

  const record = (): SuiteRecord => ({
    schemaVersion: 1,
    suiteId,
    startedAt: startedAt.toISOString(),
    endedAt,
    status,
    command: options.command,
    configFile: options.configFile,
    scenarioPath: options.scenarioPath,
    results,
    summary: summarize(results),
  })
  const flush = () => writeFileAtomic(file, JSON.stringify(record(), null, 2) + '\n')

  return {
    suiteId,
    file,
    warnings,
    record,
    start: flush,
    finish(outcome = {}) {
      endedAt = (outcome.endedAt ?? new Date()).toISOString()
      status = outcome.failed ? 'failed' : outcome.cancelled ? 'cancelled' : 'complete'
      try {
        flush()
      } catch (e) {
        warnings.push(`could not write the final record: ${e instanceof Error ? e.message : String(e)}`)
      }
      return record()
    },
    onEvent(event: RunEvent) {
      if (event.type !== 'run:end') return
      results.push(event.result)
      try {
        flush()
      } catch (e) {
        warnings.push(`could not save ${file}: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  }
}

// ------------------------------------------------------------------ reading

export class CorruptRecordError extends Error {
  constructor(readonly file: string, reason: string) {
    super(`${file}: ${reason}`)
    this.name = 'CorruptRecordError'
  }
}

// Just enough structure to trust a file that anyone could have edited. Results
// are checked for the fields the readers touch, and everything else passes through.
const ResultShape = z.looseObject({
  trace: z.looseObject({
    runId: z.string().min(1),
    scenario: z.looseObject({ id: z.string(), version: z.string() }),
    turns: z.array(z.looseObject({ index: z.number(), role: z.string(), content: z.string() })),
    usage: z.looseObject({ costUsd: z.number().nullable() }),
    metadata: z.looseObject({ models: z.looseObject({}) }),
  }),
  graders: z.array(z.looseObject({ grader: z.string(), status: z.enum(['pass', 'fail', 'error', 'skipped']) })),
  status: z.enum(['pass', 'fail', 'error']),
  score: z.number().nullable(),
  goalAchieved: z.boolean().nullable(),
  costUsd: z.number().nullable(),
  durationMs: z.number(),
  warnings: z.array(z.string()),
})

const RecordShape = z.looseObject({
  schemaVersion: z.literal(1),
  suiteId: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: z.enum(['running', 'complete', 'cancelled', 'failed']),
  command: z.string(),
  configFile: z.string(),
  scenarioPath: z.string(),
  results: z.array(ResultShape),
  summary: z.looseObject({ runs: z.number() }),
})

function parseRecord(file: string, text: string, expectedId: string): SuiteRecord {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new CorruptRecordError(file, 'not valid JSON')
  }
  const parsed = RecordShape.safeParse(json)
  if (!parsed.success) throw new CorruptRecordError(file, z.prettifyError(parsed.error).replace(/\n/g, '; '))
  if (parsed.data.suiteId !== expectedId) {
    throw new CorruptRecordError(file, `suiteId "${parsed.data.suiteId}" does not match the file name`)
  }
  const record = parsed.data as unknown as SuiteRecord
  // The summary is derived, so recompute it rather than trust a hand-edited one.
  return { ...record, summary: summarize(record.results) }
}

/** The suite with this id, or null when there is none. Throws InvalidIdError for an unsafe id and CorruptRecordError for a bad file. */
export function readSuite(dir: string, id: string): SuiteRecord | null {
  assertSafeId(id, 'suite id')
  const file = join(dir, `${id}.json`)
  if (!existsSync(file)) return null
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    throw new CorruptRecordError(file, `cannot read file (${e instanceof Error ? e.message : String(e)})`)
  }
  return parseRecord(file, text, id)
}

export interface SuiteListEntry extends SuiteHeader {
  /** For finding a run by id without opening every file again. */
  runIds: string[]
}

export interface SuiteListing {
  /** Newest first. */
  suites: SuiteListEntry[]
  /** One per file that was skipped. Never throws for a corrupt file. */
  warnings: string[]
}

interface CacheEntry {
  mtimeMs: number
  size: number
  entry: SuiteListEntry
}
const listCache = new Map<string, CacheEntry>()

/** Every readable suite, newest first. A corrupt file is skipped with a warning. Parsed headers are cached by file time and size. */
export function listSuites(dir: string): SuiteListing {
  const warnings: string[] = []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return { suites: [], warnings }
  }
  const suites: SuiteListEntry[] = []
  for (const name of names.sort()) {
    const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : undefined
    if (id === undefined || !isSafeId(id)) continue // temporary files, strays
    const file = join(dir, name)
    try {
      const stat = statSync(file)
      if (!stat.isFile()) continue
      const cached = listCache.get(file)
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        suites.push(cached.entry)
        continue
      }
      const record = parseRecord(file, readFileSync(file, 'utf8'), id)
      const { results, ...header } = record
      const entry: SuiteListEntry = { ...header, runIds: results.map(r => r.trace.runId) }
      listCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, entry })
      suites.push(entry)
    } catch (e) {
      listCache.delete(file)
      warnings.push(`Skipped ${name}: ${e instanceof Error ? e.message.replace(`${file}: `, '') : String(e)}`)
    }
  }
  suites.sort((a, b) => (a.startedAt === b.startedAt ? b.suiteId.localeCompare(a.suiteId) : b.startedAt.localeCompare(a.startedAt)))
  return { suites, warnings }
}

/** Finds a run by its id across all suites. */
export function findRun(dir: string, runId: string): { suiteId: string; result: RunResult } | null {
  assertSafeId(runId, 'run id')
  for (const s of listSuites(dir).suites) {
    if (!s.runIds.includes(runId)) continue
    try {
      const record = readSuite(dir, s.suiteId)
      const result = record?.results.find(r => r.trace.runId === runId)
      if (record && result) return { suiteId: record.suiteId, result }
    } catch {
      // Became unreadable between the listing and now: treat as absent.
    }
  }
  return null
}

/**
 * The newest `limit` suites in full, plus how many exist. Files that cannot be
 * read are skipped with a warning.
 */
export function readSuites(dir: string, limit: number): { suites: SuiteRecord[]; total: number; warnings: string[] } {
  const listing = listSuites(dir)
  const warnings = [...listing.warnings]
  const suites: SuiteRecord[] = []
  for (const s of listing.suites.slice(0, limit)) {
    try {
      const record = readSuite(dir, s.suiteId)
      if (record) suites.push(record)
    } catch (e) {
      warnings.push(`Skipped ${s.suiteId}.json: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { suites, total: listing.suites.length, warnings }
}
