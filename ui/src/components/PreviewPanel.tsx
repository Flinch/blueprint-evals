import type { ReactNode } from 'react'
import type { PreviewData } from '../../../src/ui/api-types'
import type { ModelPlan } from '../lib/types'
import { count, plural, usd } from '../lib/format'
import { Banner, Disclosure } from './ui'

// The cost preview, with the same numbers `evals run` and `evals calibrate`
// print before they ask. Upper bounds are labelled as upper bounds.

function ModelRow({ role, plan }: { role: string; plan: ModelPlan | undefined }) {
  return (
    <tr>
      <td>{role}</td>
      {plan ? (
        <>
          <td className="mono small break">{plan.provider}/{plan.model}</td>
          <td className="mono small">{plan.effort}{plan.effortIsDefault ? ' (default)' : ''}</td>
          <td>
            {plan.priced ? <span className="badge badge-pass">Priced</span> : <span className="badge badge-warning">No price, cost unknown</span>}
          </td>
        </>
      ) : (
        <td colSpan={3} className="muted small">Not used in this plan</td>
      )}
    </tr>
  )
}

export function PreviewPanel({ preview, lines, warnings = [], children }: { preview: PreviewData; lines: string[]; warnings?: string[]; children?: ReactNode }) {
  const calls = preview.calls
  const allWarnings = [...preview.warnings, ...warnings]
  const isRun = preview.kind === 'run'
  return (
    <section className="card stack" aria-label="Cost preview">
      <div className="row-between">
        <h3 className="section-title">Cost preview</h3>
        <span className="small muted">The same numbers the command line shows</span>
      </div>

      {!preview.anyModelCalls ? (
        <Banner kind="success">This plan makes no model calls, so it costs nothing.</Banner>
      ) : null}

      {allWarnings.length > 0 ? (
        <Banner kind="warning" title={allWarnings.length === 1 ? 'Warning.' : `${allWarnings.length} warnings.`} role="alert">
          <ul>
            {allWarnings.map((w, i) => <li key={i} className="break">{w}</li>)}
          </ul>
        </Banner>
      ) : null}

      <dl className="facts">
        {isRun && preview.scenarios ? (
          <>
            <dt>Scenarios</dt>
            <dd>{preview.scenarios.selected}</dd>
            <dt>Call a model</dt>
            <dd>{preview.scenarios.withModel}</dd>
            <dt>Checks only</dt>
            <dd>{preview.scenarios.deterministicOnly}</dd>
          </>
        ) : null}
        {!isRun && preview.judgements ? (
          <>
            <dt>Labels to judge</dt>
            <dd>{preview.judgements.count}</dd>
            <dt>Split</dt>
            <dd>{preview.judgements.split}</dd>
            <dt>Selection</dt>
            <dd>{preview.judgements.selection}</dd>
          </>
        ) : null}
      </dl>

      <div>
        <h4 className="sub-title">{isRun ? 'Model calls, at most' : 'Judge calls, exactly'}</h4>
        <div className="table-wrap">
          <table>
            <tbody>
              {isRun ? (
                <>
                  <tr><td>Simulated user</td><td className="num">{count(calls.simulator)}</td></tr>
                  <tr><td>Rubric judge</td><td className="num">{count(calls.rubric)}</td></tr>
                  <tr><td>Goal check</td><td className="num">{count(calls.goal)}</td></tr>
                </>
              ) : (
                <tr><td>Judge</td><td className="num">{count(calls.judge)}</td></tr>
              )}
              <tr><td><strong>Total</strong></td><td className="num"><strong>{count(calls.total)}</strong></td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h4 className="sub-title">Models</h4>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Role</th><th>Model</th><th>Effort</th><th>Price</th></tr></thead>
            <tbody>
              {isRun ? <ModelRow role="Simulator" plan={preview.models.simulator} /> : null}
              <ModelRow role="Judge" plan={preview.models.judge} />
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h4 className="sub-title">Spend limit</h4>
        {preview.cap ? (
          <dl className="facts">
            <dt>Cap per scenario</dt>
            <dd>{usd(preview.cap.usd)}</dd>
            <dt>Where it comes from</dt>
            <dd>{preview.cap.source}</dd>
            <dt>Worst case total</dt>
            <dd>{usd(preview.cap.worstCaseUsd)}</dd>
          </dl>
        ) : (
          <p className="small">{isRun ? 'No cost cap is set, so there is no worst-case figure.' : 'Calibration has no cost cap. The judge calls above are the whole spend.'}</p>
        )}
      </div>

      {preview.notes.length > 0 ? (
        <div>
          <h4 className="sub-title">Notes</h4>
          <ul className="small" style={{ marginLeft: '1.1rem' }}>
            {preview.notes.map((n, i) => <li key={i} className="break">{n}</li>)}
          </ul>
        </div>
      ) : null}

      {children}

      <Disclosure title="The text the command line prints">
        <pre className="json" aria-label="Command line preview text">{lines.join('\n')}</pre>
      </Disclosure>
    </section>
  )
}

/** One sentence that says what a confirmation covers. Used in both confirmation dialogs. */
export function scopeSentence(preview: PreviewData): string {
  if (preview.kind === 'run') {
    const n = preview.scenarios?.selected ?? 0
    return `${plural(n, 'scenario')}, with up to ${plural(preview.calls.total, 'model call')}.`
  }
  return `${plural(preview.judgements?.count ?? 0, 'label')} to judge, with exactly ${plural(preview.calls.judge, 'judge call')}.`
}
