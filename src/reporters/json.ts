import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Reporter, RunEvent, RunResult } from '../core/interfaces.js'
import { FRAMEWORK_VERSION } from '../core/version.js'

// Collects every finished run and writes them, with their full traces, to a
// file. The file is rewritten after each run, so a long suite that is stopped
// part-way still leaves the results it had.

export interface JsonReport {
  frameworkVersion: string
  startedAt: string
  results: RunResult[]
}

export interface JsonReporter extends Reporter {
  readonly results: RunResult[]
  /** Writes the file now. Called once up front so a bad path fails before any money is spent. */
  flush(): void
}

export function createJsonReporter(file: string, options: { startedAt?: Date } = {}): JsonReporter {
  const startedAt = (options.startedAt ?? new Date()).toISOString()
  const results: RunResult[] = []

  function flush() {
    const report: JsonReport = { frameworkVersion: FRAMEWORK_VERSION, startedAt, results }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(report, null, 2) + '\n')
  }

  return {
    results,
    flush,
    onEvent(event: RunEvent) {
      if (event.type !== 'run:end') return
      results.push(event.result)
      flush()
    },
  }
}
