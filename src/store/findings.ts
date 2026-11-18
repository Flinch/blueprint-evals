import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { itemIdOfLabel, resolveLabels, type Label } from '../calibration/labels.js'
import type { RunResult } from '../core/interfaces.js'
import type { Usage } from '../core/trace.js'
import { assertSafeId, isSafeId, newId, writeFileAtomic } from './fs.js'
import { judgedResponse } from './labels.js'
import type { SuiteRecord } from './suites.js'

// The findings report: what a person failed, and why, as a document a developer
// fixing the system under test can act on. See "Findings" in
// docs/design/0003-ui-and-api.md.
//
// It is built from the current human labels with verdict fail, joined to the
// saved runs. A judge failure nobody has reviewed is counted and left out, so
// everything listed is a verified finding. Building it is a pure read: no model
// is called.

export interface FindingsFilters {
  /** Only runs that started at or after this time (ISO 8601). */
  since?: string
  /** Only criteria of this rubric. */
  rubric?: string
  /** Only this criterion. */
  criterion?: string
}

export interface Finding {
  /** `<runId>:<criterionId>`. */
  itemId: string
  suiteId: string
  runId: string
  /** When the run started. */
  startedAt: string
  scenarioId: string
  /** The last user message before the judged reply, or an excerpt of the label's input when the run has none. */
  userMessage: string
  /** The judged reply: the label's output. */
  output: string
  /** The person's critique. */
  critique: string
  labeler: string
  /** When the current label was saved. */
  labelledAt: string
  /** True when the label was changed after it was first saved, so possibly after seeing the judge. */
  revised: boolean
}

export interface CriterionFindings {
  criterion: string
  /** From the rubric as it is now. Null when no loaded rubric has the criterion. */
  text: string | null
  critical: boolean
  rubricId: string | null
  rubricVersion: string | null
  /** Current fail labels for this criterion in the filter. */
  failed: number
  /** Every current label for this criterion in the filter, pass and fail. */
  labelled: number
  /** Newest run first. */
  findings: Finding[]
}

export interface FindingsReport {
  generatedAt: string
  filters: FindingsFilters
  /** Criteria with at least one finding: critical first, then by the number of failures. */
  criteria: CriterionFindings[]
  totals: { failed: number; labelled: number }
  /** Criteria the judge failed in the saved runs (in the filter) that no person has labelled yet. Not in the report. */
  unreviewedJudgeFailures: number
  /** Current labels whose item is not from a saved run (a hand-written label, or a run that was deleted). Not in the report. */
  notFromSavedRun: number
}

/** The rubric a criterion of a scenario's runs belongs to, as the report needs it. */
export type FindingsRubricLookup = (scenarioId: string, criterion: string) => { id: string; version: string; text: string; critical: boolean } | undefined

const USER_MESSAGE_MAX = 1000

function excerpt(text: string, max = USER_MESSAGE_MAX): string {
  const t = text.trim()
  return t.length <= max ? t : `${t.slice(0, max - 3).trimEnd()}...`
}

/** The last user message before the judged reply. */
function lastUserMessage(result: RunResult): string | undefined {
  const found = judgedResponse(result.trace.turns)
  if (!found) return undefined
  for (let i = found.before.length - 1; i >= 0; i--) {
    const t = found.before[i]!
    if (t.role === 'user' && t.content.trim() !== '') return t.content
  }
  return undefined
}

function judgeFailures(result: RunResult): { id: string; critical: boolean }[] {
  return result.graders.flatMap(g => (g.status === 'pass' || g.status === 'fail' ? g.criteria ?? [] : [])).filter(c => c.verdict === 'fail')
}

const ms = (iso: string) => Date.parse(iso)

/**
 * Builds the report. `labels` is every line of the label file; the current label
 * of each item is used, so a revised item counts once, with its latest verdict.
 * Throws LabelChainError for a broken replace chain.
 */
export function buildFindings(input: {
  suites: SuiteRecord[]
  labels: Label[]
  rubricFor: FindingsRubricLookup
  filters?: FindingsFilters
  now?: Date
}): FindingsReport {
  const filters = input.filters ?? {}
  const { current, revised } = resolveLabels(input.labels)

  const runs = new Map<string, { suiteId: string; result: RunResult }>()
  for (const s of input.suites) for (const r of s.results) if (!runs.has(r.trace.runId)) runs.set(r.trace.runId, { suiteId: s.suiteId, result: r })

  const sinceMs = filters.since !== undefined ? ms(filters.since) : undefined
  const inFilter = (result: RunResult, criterion: string, rubricId: string | undefined) =>
    (sinceMs === undefined || ms(result.trace.startedAt) >= sinceMs) &&
    (filters.rubric === undefined || rubricId === filters.rubric) &&
    (filters.criterion === undefined || criterion === filters.criterion)

  const groups = new Map<string, CriterionFindings>()
  let labelled = 0
  let failed = 0
  let notFromSavedRun = 0
  for (const label of current) {
    const itemId = itemIdOfLabel(label)
    const colon = itemId.indexOf(':')
    const run = colon > 0 ? runs.get(itemId.slice(0, colon)) : undefined
    if (!run) {
      notFromSavedRun++
      continue
    }
    const { result } = run
    const scenarioId = result.trace.scenario.id
    const rubric = input.rubricFor(scenarioId, label.criterion)
    if (!inFilter(result, label.criterion, rubric?.id)) continue

    const key = `${rubric?.id ?? ''}\u0000${label.criterion}`
    let group = groups.get(key)
    if (!group) {
      const judged = judgeFailures(result).find(c => c.id === label.criterion)
      group = {
        criterion: label.criterion,
        text: rubric?.text ?? null,
        critical: rubric?.critical ?? judged?.critical ?? false,
        rubricId: rubric?.id ?? null,
        rubricVersion: rubric?.version ?? null,
        failed: 0,
        labelled: 0,
        findings: [],
      }
      groups.set(key, group)
    }
    group.labelled++
    labelled++
    if (label.verdict !== 'fail') continue
    group.failed++
    failed++
    group.findings.push({
      itemId,
      suiteId: run.suiteId,
      runId: result.trace.runId,
      startedAt: result.trace.startedAt,
      scenarioId,
      userMessage: excerpt(lastUserMessage(result) ?? label.input ?? ''),
      output: label.output,
      critique: label.critique,
      labeler: label.labeler,
      labelledAt: label.at,
      revised: revised.has(itemId),
    })
  }

  const labelledIds = new Set(current.map(itemIdOfLabel))
  let unreviewedJudgeFailures = 0
  for (const { result } of runs.values()) {
    for (const c of judgeFailures(result)) {
      if (labelledIds.has(`${result.trace.runId}:${c.id}`)) continue
      if (inFilter(result, c.id, input.rubricFor(result.trace.scenario.id, c.id)?.id)) unreviewedJudgeFailures++
    }
  }

  const criteria = [...groups.values()]
    .filter(g => g.failed > 0)
    .sort((a, b) => Number(b.critical) - Number(a.critical) || b.failed - a.failed || a.criterion.localeCompare(b.criterion) || (a.rubricId ?? '').localeCompare(b.rubricId ?? ''))
  for (const g of criteria) g.findings.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.itemId.localeCompare(b.itemId))

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    filters,
    criteria,
    totals: { failed, labelled },
    unreviewedJudgeFailures,
    notFromSavedRun,
  }
}

// ---------------------------------------------------------------- the AI draft

/** What the model is asked for, per criterion. */
export interface SuggestedFix {
  criterion: string
  /** What the failures have in common. */
  pattern: string
  /** A plain-language change to the assistant's instructions or behavior. */
  proposedChange: string
  /** The findings it rests on. */
  itemIds: string[]
}

/** A saved AI draft of suggested fixes: <workdir>/.evals/findings/<summaryId>.json. */
export interface FindingsSummaryRecord {
  schemaVersion: 1
  summaryId: string
  at: string
  filters: FindingsFilters
  /** A hash of the findings the draft was written from. A report with a different hash has changed since. */
  fingerprint: string
  /** How many findings the model was shown, and which. */
  findings: number
  itemIds: string[]
  model: { provider: string; model: string; effort: string; servedBy?: string }
  usage: Usage
  fixes: SuggestedFix[]
  /** Things to know about the draft, such as item ids the model named that are not findings. */
  warnings: string[]
}

export function saveFindingsSummary(dir: string, input: Omit<FindingsSummaryRecord, 'schemaVersion' | 'summaryId' | 'at'>, now = new Date()): FindingsSummaryRecord {
  const record: FindingsSummaryRecord = { schemaVersion: 1, summaryId: newId(now), at: now.toISOString(), ...input }
  writeFileAtomic(join(dir, `${record.summaryId}.json`), JSON.stringify(record, null, 2) + '\n')
  return record
}

function readFindingsSummary(dir: string, id: string): FindingsSummaryRecord | null {
  assertSafeId(id, 'summary id')
  const file = join(dir, `${id}.json`)
  if (!existsSync(file)) return null
  try {
    const json = JSON.parse(readFileSync(file, 'utf8')) as FindingsSummaryRecord
    return json.schemaVersion === 1 && json.summaryId === id && Array.isArray(json.fixes) ? json : null
  } catch {
    return null
  }
}

/** Saved drafts, newest first. Unreadable files are skipped. */
export function listFindingsSummaries(dir: string): FindingsSummaryRecord[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: FindingsSummaryRecord[] = []
  for (const name of names) {
    const id = name.endsWith('.json') ? name.slice(0, -5) : undefined
    if (id === undefined || !isSafeId(id)) continue
    const r = readFindingsSummary(dir, id)
    if (r) out.push(r)
  }
  return out.sort((a, b) => b.at.localeCompare(a.at) || b.summaryId.localeCompare(a.summaryId))
}

/** Two filter sets mean the same report. */
export function sameFilters(a: FindingsFilters, b: FindingsFilters): boolean {
  return a.since === b.since && a.rubric === b.rubric && a.criterion === b.criterion
}

// ------------------------------------------------------------------ markdown

/** A file name for the Markdown download. */
export function findingsFileName(report: Pick<FindingsReport, 'generatedAt'>): string {
  return `findings-${report.generatedAt.slice(0, 10)}.md`
}

const utc = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

const quote = (text: string) =>
  text
    .trim()
    .split('\n')
    .map(l => (l.trim() === '' ? '>' : `> ${l}`))
    .join('\n')

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')

export function filtersSentence(f: FindingsFilters): string {
  const parts = [
    f.since !== undefined ? `runs since ${utc(f.since)}` : 'all saved runs',
    f.rubric !== undefined ? `rubric ${f.rubric}` : 'every rubric',
    f.criterion !== undefined ? `criterion ${f.criterion}` : 'every criterion',
  ]
  return parts.join(', ')
}

/**
 * The report as Markdown, for a developer: a summary table, then a section per
 * criterion with the rule and each finding. An AI draft of suggested fixes, when
 * one is given, goes first, labelled as a draft.
 */
export function findingsMarkdown(report: FindingsReport, draft?: FindingsSummaryRecord | null): string {
  const out: string[] = []
  out.push('# Findings report', '')
  out.push(`Generated ${utc(report.generatedAt)}.`, '')
  out.push(`Filters: ${filtersSentence(report.filters)}.`, '')
  out.push(
    `Each finding is an assistant reply that a person labelled fail, with their critique. ${report.totals.failed} of ${report.totals.labelled} labelled replies failed.`,
    '',
  )
  if (report.unreviewedJudgeFailures > 0) {
    out.push(
      `${report.unreviewedJudgeFailures} ${report.unreviewedJudgeFailures === 1 ? 'failure' : 'failures'} found by the judge ${report.unreviewedJudgeFailures === 1 ? 'has' : 'have'} not been reviewed by a person yet and ${report.unreviewedJudgeFailures === 1 ? 'is' : 'are'} left out. This report covers verified findings only.`,
      '',
    )
  }

  if (draft) {
    out.push('## Suggested fixes (AI draft, review before use)', '')
    out.push(
      `Drafted by ${draft.model.model} on ${utc(draft.at)} from ${draft.findings} ${draft.findings === 1 ? 'finding' : 'findings'}. It is a starting point for a person to check against the findings below.`,
      '',
    )
    for (const fix of draft.fixes) {
      out.push(`### ${fix.criterion}`, '')
      out.push(`**Pattern.** ${fix.pattern.trim()}`, '')
      out.push(`**Proposed change.** ${fix.proposedChange.trim()}`, '')
      if (fix.itemIds.length > 0) out.push(`Based on: ${fix.itemIds.map(id => `\`${id}\``).join(', ')}`, '')
    }
  }

  out.push('## Summary', '')
  if (report.criteria.length === 0) {
    out.push('No labelled failures match these filters.', '')
  } else {
    out.push('| Criterion | Critical | Failed / labelled |', '|---|---|---|')
    for (const c of report.criteria) out.push(`| ${cell(c.criterion)} | ${c.critical ? 'yes' : 'no'} | ${c.failed} / ${c.labelled} |`)
    out.push('')
  }

  for (const c of report.criteria) {
    out.push(`## ${c.criterion}${c.critical ? ' (critical)' : ''}`, '')
    out.push(c.rubricId ? `Rubric ${c.rubricId}, version ${c.rubricVersion}. ${c.failed} of ${c.labelled} labelled replies failed.` : `${c.failed} of ${c.labelled} labelled replies failed.`, '')
    out.push(c.text ? `**Rule.** ${c.text.trim()}` : '**Rule.** No loaded rubric has this criterion, so its wording is not shown.', '')
    c.findings.forEach((f, i) => {
      out.push(`### ${i + 1}. ${f.scenarioId}, run of ${utc(f.startedAt)}`, '')
      out.push(`Item \`${f.itemId}\`. Labelled by ${f.labeler} on ${utc(f.labelledAt)}${f.revised ? ', revised after the first label (possibly after seeing the judge)' : ''}.`, '')
      out.push('**User message**', '', f.userMessage.trim() === '' ? '> (none)' : quote(f.userMessage), '')
      out.push('**Assistant reply**', '', quote(f.output), '')
      out.push(`**Critique.** ${f.critique.trim()}`, '')
    })
  }
  return out.join('\n').replace(/\n+$/, '\n')
}
