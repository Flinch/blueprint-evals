import type { Reporter, RunEvent, RunResult } from '../core/interfaces.js'

// A plain-text reporter for a terminal: one line when a run starts, one when it
// ends, the reasons for any failure, and a summary table at the end. It writes
// through a function it is given, so a test can capture the output and the CLI
// can send it to stdout. The function receives whole lines, newline included.

export interface ConsoleReporter extends Reporter {
  /** Prints the summary table for every run seen so far. */
  printSummary(): void
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** A dollar amount for a total or a budget. null means a price was missing. */
export function formatUsd(cost: number | null): string {
  if (cost === null) return 'unknown'
  return `$${cost >= 0.01 || cost === 0 ? cost.toFixed(2) : cost.toFixed(4)}`
}

/** Per-run cost, always to four places: single runs usually cost cents or less. */
const runCost = (cost: number | null) => (cost === null ? 'unknown' : `$${cost.toFixed(4)}`)

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

const formatScore = (score: number | null) => (score === null ? '-' : score.toFixed(2))
const formatGoal = (goal: boolean | null) => (goal === null ? '-' : goal ? 'yes' : 'no')
const STATUS = { pass: 'PASS ', fail: 'FAIL ', error: 'ERROR' } as const

/** The reasons a run did not pass: failed checks, failed criteria with the judge's critique, and errors. */
export function failureLines(result: RunResult): string[] {
  const lines: string[] = []
  for (const g of result.graders) {
    if (g.status === 'fail' && !(g.criteria && g.criteria.length > 0)) {
      lines.push(`failed check: ${g.grader}: ${oneLine(g.reason)}`)
    }
    for (const c of g.criteria ?? []) {
      if (c.verdict === 'fail') lines.push(`failed criterion: ${c.id}${c.critical ? ' (critical)' : ''}: ${oneLine(c.critique)}`)
    }
  }
  if (result.error) lines.push(`error: ${oneLine(result.error)}`)
  return lines
}

export function createConsoleReporter(write: (text: string) => void): ConsoleReporter {
  const results: RunResult[] = []
  const out = (line = '') => write(`${line}\n`)

  function printRunEnd(result: RunResult) {
    out(
      `${STATUS[result.status]} ${result.trace.scenario.id}  score ${formatScore(result.score)}  goal ${formatGoal(result.goalAchieved)}  ` +
        `cost ${runCost(result.costUsd)}  ${formatDuration(result.durationMs)}`,
    )
    if (result.status !== 'pass') for (const l of failureLines(result)) out(`        ${l}`)
  }

  return {
    onEvent(event: RunEvent) {
      if (event.type === 'run:start') out(`RUN   ${event.scenarioId}`)
      else if (event.type === 'run:end') {
        results.push(event.result)
        printRunEnd(event.result)
      }
    },

    printSummary() {
      const count = (s: RunResult['status']) => results.filter(r => r.status === s).length
      const withGoal = results.filter(r => r.goalAchieved !== null)
      const costs = results.map(r => r.costUsd)
      const totalCost = costs.some(c => c === null) ? null : costs.reduce<number>((sum, c) => sum + (c ?? 0), 0)
      const warnings = new Set(results.flatMap(r => r.warnings))

      out()
      out('Summary')
      const head = ['status', 'score', 'goal', 'cost', 'time', 'scenario']
      const rows = results.map(r => [
        STATUS[r.status].trim(),
        formatScore(r.score),
        formatGoal(r.goalAchieved),
        runCost(r.costUsd),
        formatDuration(r.durationMs),
        r.trace.scenario.id,
      ])
      const widths = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]!.length)))
      const fmt = (cells: string[]) => '  ' + cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join('  ')
      out(fmt(head))
      for (const r of rows) out(fmt(r))
      out()
      out(`Runs: ${results.length}   pass ${count('pass')}   fail ${count('fail')}   error ${count('error')}`)
      out(
        withGoal.length === 0
          ? 'Goal achieved: n/a (no run had a goal result)'
          : `Goal achieved: ${withGoal.filter(r => r.goalAchieved).length} of ${withGoal.length} runs with a goal result`,
      )
      out(`Total cost: ${formatUsd(totalCost)}${totalCost === null ? ' (a model used in this run has no price in the config)' : ''}`)
      if (warnings.size > 0) {
        out()
        out('Warnings')
        for (const w of warnings) out(`  - ${oneLine(w)}`)
      }
    },
  }
}
