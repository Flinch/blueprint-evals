import { Fragment, useCallback, useState, type ReactNode } from 'react'
import type { GraderResult, RunResult, Turn } from '../../../src/ui/api-types'
import type { ModelRef, ToolCall } from '../lib/types'
import { api } from '../api/client'
import { useAsync } from '../api/useAsync'
import { CriticalMarker, Disclosure, ErrorState, JsonBlock, Loading, PageHead, StatusBadge, TagList, Tile, VerdictBadge, Warnings, Banner } from '../components/ui'
import { duration, fullDate, plural, score, tokens, usd } from '../lib/format'
import { href } from '../lib/router'

// ------------------------------------------------------------------ helpers

type GraderKind = 'rubric' | 'goal' | 'check'

export function graderKind(g: GraderResult): GraderKind {
  if (g.grader === 'goal-check') return 'goal'
  if ((g.criteria && g.criteria.length > 0) || g.grader.startsWith('rubric-judge')) return 'rubric'
  return 'check'
}

/** Critiques cite turns as [3]. Each citation becomes a button that jumps to that turn. Text stays text. */
export function CitedText({ text, onCite }: { text: string; onCite(index: number): void }) {
  const parts: ReactNode[] = []
  const re = /\[(\d+)\]/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const n = Number(m[1])
    parts.push(
      <button key={`${m.index}`} type="button" className="cite" onClick={() => onCite(n)} aria-label={`Go to turn ${n}`}>
        [{n}]
      </button>,
    )
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</>
}

function modelText(m: ModelRef | undefined): string {
  if (!m) return 'None used'
  const bits = [`${m.provider}/${m.model}`]
  if (m.effort) bits.push(`effort ${m.effort}`)
  return bits.join(', ')
}

// --------------------------------------------------------------- transcript

function ToolCallView({ call, index }: { call: ToolCall; index: number }) {
  const [open, setOpen] = useState(false)
  const id = `tc-${index}-${call.name}`
  return (
    <div className="toolcall">
      <button type="button" className="toolcall-head" aria-expanded={open} aria-controls={id} onClick={() => setOpen(o => !o)}>
        <span className="chev" aria-hidden="true">{'▸'}</span>
        <span>Tool call: {call.name}</span>
        {call.error ? <span className="badge badge-error">Error</span> : null}
      </button>
      {open ? (
        <div className="toolcall-body" id={id}>
          <div className="review-label">Arguments</div>
          <JsonBlock value={call.arguments} label={`Arguments for ${call.name}`} />
          {call.result !== undefined ? (
            <>
              <div className="review-label" style={{ marginTop: '0.5rem' }}>Result</div>
              <JsonBlock value={call.result} label={`Result of ${call.name}`} />
            </>
          ) : null}
          {call.error ? (
            <>
              <div className="review-label" style={{ marginTop: '0.5rem' }}>Error</div>
              <div className="small break" style={{ color: 'var(--danger-text)' }}>{call.error}</div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function TurnView({ turn, flash }: { turn: Pick<Turn, 'index' | 'role' | 'content' | 'toolCalls' | 'latencyMs' | 'at'> & { raw?: unknown }; flash?: boolean }) {
  const who = turn.role === 'user' ? 'Simulated user' : turn.role === 'assistant' ? 'Agent' : 'Tool'
  return (
    <div className={`turn ${turn.role}${flash ? ' flash' : ''}`} id={`turn-${turn.index}`}>
      <div className="turn-meta">
        <span className="turn-no" title="Turn number. Critiques cite turns by this number.">[{turn.index}]</span>
        <span>{who}</span>
        {turn.latencyMs !== undefined ? <span>{duration(turn.latencyMs)}</span> : null}
      </div>
      <div className="bubble">{turn.content === '' ? <span className="muted">(no text)</span> : turn.content}</div>
      {turn.toolCalls?.map((c, i) => <ToolCallView key={i} call={c} index={turn.index * 100 + i} />)}
      {turn.raw !== undefined ? (
        <details style={{ marginTop: '0.3rem', width: '100%' }}>
          <summary className="small muted" style={{ cursor: 'pointer' }}>Raw response</summary>
          <JsonBlock value={turn.raw} label={`Raw response for turn ${turn.index}`} />
        </details>
      ) : null}
    </div>
  )
}

// ----------------------------------------------------------------- verdicts

function Evidence({ g, onCite }: { g: GraderResult; onCite(i: number): void }) {
  const turns = [...new Set((g.evidence ?? []).map(e => e.turnIndex).filter((n): n is number => n !== undefined))]
  if (turns.length === 0) return null
  return (
    <div className="small muted" style={{ marginTop: '0.35rem' }}>
      Evidence:{' '}
      {turns.map(n => (
        <button key={n} type="button" className="cite" style={{ marginRight: '0.4rem' }} onClick={() => onCite(n)}>turn [{n}]</button>
      ))}
    </div>
  )
}

function CheckItem({ g, onCite }: { g: GraderResult; onCite(i: number): void }) {
  const skipped = g.status === 'skipped'
  return (
    <div className={`verdict-item${skipped ? ' skipped' : ''}`} data-status={g.status}>
      <div className="verdict-top">
        <StatusBadge status={g.status} />
        <span className="verdict-name">{g.grader}</span>
      </div>
      <div className="verdict-body"><CitedText text={g.reason} onCite={onCite} /></div>
      {skipped ? <div className="small muted" style={{ marginTop: '0.3rem' }}>This check did not run. A skipped check is never counted as a pass.</div> : null}
      {g.warnings?.length ? <ul className="small" style={{ marginTop: '0.4rem', marginLeft: '1.1rem', color: 'var(--warning)' }}>{g.warnings.map((w, i) => <li key={i} className="break">{w}</li>)}</ul> : null}
      <Evidence g={g} onCite={onCite} />
    </div>
  )
}

function RubricBlock({ g, onCite }: { g: GraderResult; onCite(i: number): void }) {
  const decided = g.status === 'pass' || g.status === 'fail'
  return (
    <div className="stack-sm">
      <div className="row">
        <StatusBadge status={g.status} />
        <span className="verdict-name">{g.grader}</span>
        {g.score !== undefined ? <span className="crit-meta" title="Weighted share of criteria passed. It is a diagnostic only.">score {score(g.score)}</span> : null}
        {g.model ? <span className="crit-meta">{g.model.servedBy && g.model.servedBy !== g.model.model ? `answered by ${g.model.servedBy}` : g.model.model}</span> : null}
      </div>
      {!decided ? <div className="small break" style={{ color: g.status === 'error' ? 'var(--warning)' : 'var(--muted)' }}>{g.reason}</div> : null}
      {g.warnings?.length ? <Warnings items={g.warnings} /> : null}
      {g.criteria && g.criteria.length > 0 ? (
        <div className="verdict-list">
          {g.criteria.map(c => (
            <div className="verdict-item" key={c.id} data-verdict={c.verdict}>
              <div className="verdict-top">
                <VerdictBadge verdict={c.verdict} />
                <span className="verdict-name">{c.id}</span>
                {c.critical ? <CriticalMarker /> : null}
                <span className="crit-meta" style={{ marginLeft: 'auto' }}>weight {c.weight}</span>
              </div>
              <div className="verdict-body"><CitedText text={c.critique} onCite={onCite} /></div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function GoalBlock({ g, goalAchieved, onCite }: { g: GraderResult; goalAchieved: boolean | null; onCite(i: number): void }) {
  return (
    <div className="verdict-list">
      <div className={`verdict-item${g.status === 'skipped' ? ' skipped' : ''}`} data-status={g.status}>
        <div className="verdict-top">
          <StatusBadge status={g.status} label={g.status === 'pass' ? 'Goal achieved' : g.status === 'fail' ? 'Goal not achieved' : undefined} />
          <span className="verdict-name">{g.grader}</span>
          {g.model ? <span className="crit-meta">{g.model.servedBy && g.model.servedBy !== g.model.model ? `answered by ${g.model.servedBy}` : g.model.model}</span> : null}
        </div>
        <div className="verdict-body"><CitedText text={g.reason} onCite={onCite} /></div>
        {g.status === 'skipped' ? <div className="small muted" style={{ marginTop: '0.3rem' }}>No goal outcome for this run ({goalAchieved === null ? 'null' : String(goalAchieved)}).</div> : null}
      </div>
    </div>
  )
}

function countBy(graders: GraderResult[]) {
  const c = { pass: 0, fail: 0, error: 0, skipped: 0 }
  for (const g of graders) c[g.status]++
  return c
}

// -------------------------------------------------------------------- page

export function RunDetail({ result, suiteId }: { result: RunResult; suiteId?: string }) {
  const [flash, setFlash] = useState<number | null>(null)
  const jump = useCallback((index: number) => {
    const el = document.getElementById(`turn-${index}`)
    if (!el) return
    el.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    setFlash(index)
    window.setTimeout(() => setFlash(f => (f === index ? null : f)), 2500)
  }, [])

  const { trace } = result
  const rubric = result.graders.filter(g => graderKind(g) === 'rubric')
  const goal = result.graders.filter(g => graderKind(g) === 'goal')
  const checks = result.graders.filter(g => graderKind(g) === 'check')
  const checkCounts = countBy(checks)
  const meta = trace.metadata

  return (
    <>
      <PageHead
        title={trace.scenario.id}
        sub={
          <span className="row" style={{ gap: '0.5rem' }}>
            <StatusBadge status={result.status} />
            <span className="mono small break">{trace.runId}</span>
            <span className="small">version {trace.scenario.version}</span>
            <TagList tags={meta.tags ?? []} />
          </span>
        }
        actions={<a className="btn btn-ghost btn-sm" href={href('/runs', suiteId ? { suite: suiteId } : undefined)}>Back to runs</a>}
      />

      <div className="stats-row">
        <Tile
          lead
          label="Goal"
          value={result.goalAchieved === null ? 'No goal check' : result.goalAchieved ? 'Achieved' : 'Not achieved'}
          sub={result.goalAchieved === null ? 'The scenario has no goal, or the check could not run.' : undefined}
        />
        <Tile label="Score" value={score(result.score)} sub="Weighted share of criteria passed. A diagnostic." />
        <Tile label="Cost" value={usd(result.costUsd)} sub={result.costUsd === null ? 'A model had no price in the config.' : `${tokens(trace.usage.inputTokens)} in, ${tokens(trace.usage.outputTokens)} out`} />
        <Tile label="Duration" value={duration(result.durationMs)} sub={`${plural(trace.turns.length, 'turn')}`} />
      </div>

      {result.error ? (
        <div style={{ marginBottom: '1rem' }}>
          <Banner kind="danger" title="This run ended with an error." role="alert">
            <span className="break">{result.error}</span> An error means the test could not finish, so it says nothing about the agent.
          </Banner>
        </div>
      ) : null}
      <Warnings items={result.warnings} title="Warnings on this run" />

      <div className="section-header">
        <h2 className="section-title">Transcript</h2>
        <span className="section-note">Turn numbers match the [n] citations in the critiques below.</span>
      </div>
      <div className="card">
        {trace.turns.length === 0 ? (
          <p className="muted">This run recorded no turns.</p>
        ) : (
          <div className="transcript" aria-label="Transcript">
            {trace.turns.map(t => <TurnView key={t.index} turn={t} flash={flash === t.index} />)}
          </div>
        )}
      </div>

      {goal.length > 0 ? (
        <>
          <div className="section-header"><h2 className="section-title">Goal check</h2></div>
          {goal.map((g, i) => <GoalBlock key={i} g={g} goalAchieved={result.goalAchieved} onCite={jump} />)}
        </>
      ) : null}

      {rubric.length > 0 ? (
        <>
          <div className="section-header">
            <h2 className="section-title">Rubric criteria</h2>
            <span className="section-note">The judge writes a critique, then decides pass or fail.</span>
          </div>
          <div className="stack">{rubric.map((g, i) => <RubricBlock key={i} g={g} onCite={jump} />)}</div>
        </>
      ) : null}

      <div className="section-header">
        <h2 className="section-title">Checks</h2>
        <span className="section-note">
          {checks.length === 0 ? 'None defined' : `${checkCounts.pass} passed, ${checkCounts.fail} failed, ${checkCounts.error} errored, ${checkCounts.skipped} skipped`}
        </span>
      </div>
      {checks.length === 0 ? (
        <div className="card"><p className="muted">This scenario defines no deterministic checks.</p></div>
      ) : (
        <div className="verdict-list">{checks.map((g, i) => <CheckItem key={i} g={g} onCite={jump} />)}</div>
      )}

      <div className="section-header"><h2 className="section-title">Models, cost and trace</h2></div>
      <div className="grid-2">
        <div className="card-sm">
          <h3 className="sub-title">Models and effort</h3>
          <dl className="facts">
            <dt>Simulator</dt><dd>{modelText(meta.models.simulator)}</dd>
            <dt>Judge</dt><dd>{modelText(meta.models.judge)}</dd>
            {meta.models.judge?.servedBy && meta.models.judge.servedBy !== meta.models.judge.model ? (<><dt>Judge answered</dt><dd>{meta.models.judge.servedBy}</dd></>) : null}
            {meta.models.simulator?.servedBy && meta.models.simulator.servedBy !== meta.models.simulator.model ? (<><dt>Simulator answered</dt><dd>{meta.models.simulator.servedBy}</dd></>) : null}
          </dl>
        </div>
        <div className="card-sm">
          <h3 className="sub-title">Cost and tokens</h3>
          <dl className="facts">
            <dt>Cost</dt><dd>{usd(trace.usage.costUsd)}</dd>
            <dt>Input tokens</dt><dd>{trace.usage.inputTokens.toLocaleString('en-US')}</dd>
            <dt>Output tokens</dt><dd>{trace.usage.outputTokens.toLocaleString('en-US')}</dd>
          </dl>
          {trace.usage.costUsd === null ? <p className="small muted">The cost is unknown because at least one model has no price in the config. It is never shown as zero.</p> : null}
        </div>
        <div className="card-sm">
          <h3 className="sub-title">Target</h3>
          <dl className="facts">
            <dt>Name</dt><dd>{trace.target.name}</dd>
            <dt>Kind</dt><dd>{trace.target.kind}</dd>
            <dt>Tool calls</dt><dd>{trace.target.toolCalls}</dd>
            {trace.target.version ? (<><dt>Version</dt><dd>{trace.target.version}</dd></>) : null}
          </dl>
          {trace.target.toolCalls === 'none' ? <p className="small muted">This target reports no tool calls, so tool checks are skipped.</p> : null}
        </div>
        <div className="card-sm">
          <h3 className="sub-title">Trace</h3>
          <dl className="facts">
            <dt>Started</dt><dd>{fullDate(trace.startedAt)}</dd>
            <dt>Ended</dt><dd>{fullDate(trace.endedAt)}</dd>
            <dt>Framework</dt><dd>{meta.frameworkVersion}</dd>
            {meta.promptVersion ? (<><dt>Prompt version</dt><dd>{meta.promptVersion}</dd></>) : null}
            {meta.targetVersion ? (<><dt>Target version</dt><dd>{meta.targetVersion}</dd></>) : null}
            <dt>Schema</dt><dd>{trace.schemaVersion}</dd>
          </dl>
        </div>
      </div>
      {result.graders.some(g => g.usage) ? (
        <div style={{ marginTop: '1rem' }}>
          <Disclosure title="Cost by grader">
            <div className="table-wrap">
              <table>
                <thead><tr><th>Grader</th><th>Model</th><th>In</th><th>Out</th><th>Cost</th></tr></thead>
                <tbody>
                  {result.graders.filter(g => g.usage).map((g, i) => (
                    <tr key={i}>
                      <td className="mono small break">{g.grader}</td>
                      <td className="mono small">{g.model ? modelText(g.model) : 'n/a'}</td>
                      <td className="num">{g.usage!.inputTokens}</td>
                      <td className="num">{g.usage!.outputTokens}</td>
                      <td className="num">{usd(g.usage!.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Disclosure>
        </div>
      ) : null}
    </>
  )
}

export function RunDetailPage({ runId }: { runId: string }) {
  const run = useAsync(() => api.run(runId), [runId])
  if (run.loading && !run.data) return <Loading label="Loading the run" />
  if (run.error && !run.data) return <ErrorState error={run.error} onRetry={run.reload} title="Could not load this run" />
  if (!run.data) return null
  return <RunDetail result={run.data.result} suiteId={run.data.suiteId} />
}
