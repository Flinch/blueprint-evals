import type { TrendPoint } from '../../../src/ui/api-types'
import { percent, shortDate } from '../lib/format'

// Inline SVG, no chart library. Colors come from the theme tokens in styles.css.

const W = 720
const H = 230
const PAD = { left: 40, right: 14, top: 14, bottom: 30 }

interface Pt {
  x: number
  y: number
  p: TrendPoint
}

function segments(points: (Pt | null)[]): Pt[][] {
  const out: Pt[][] = []
  let cur: Pt[] = []
  for (const p of points) {
    if (p === null) {
      if (cur.length) out.push(cur)
      cur = []
    } else cur.push(p)
  }
  if (cur.length) out.push(cur)
  return out
}

const pathOf = (pts: Pt[]) => pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')

/** Goal-achieved rate and pass rate per suite, oldest on the left. A suite with no rate leaves a gap. */
export function TrendChart({ points }: { points: TrendPoint[] }) {
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const x = (i: number) => PAD.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW)
  const y = (v: number) => PAD.top + (1 - v) * innerH

  const goal = points.map((p, i) => (p.goalRate === null ? null : { x: x(i), y: y(p.goalRate), p }))
  const pass = points.map((p, i) => (p.passRate === null ? null : { x: x(i), y: y(p.passRate), p }))
  const last = points[points.length - 1]
  const summary = last
    ? `Trend across ${points.length} suites. Latest suite: goal-achieved rate ${percent(last.goalRate)}, pass rate ${percent(last.passRate)}.`
    : 'No suites.'

  const labelIdx = points.length <= 1 ? [0] : [0, Math.floor((points.length - 1) / 2), points.length - 1]

  return (
    <div className="chart-wrap">
      <div className="legend" aria-hidden="true">
        <span><i />Goal achieved</span>
        <span><i className="dash" />Pass rate</span>
      </div>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} preserveAspectRatio="xMidYMid meet">
        {[0, 0.25, 0.5, 0.75, 1].map(v => (
          <g key={v}>
            <line className="grid" x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
            <text x={PAD.left - 6} y={y(v) + 3} textAnchor="end">{Math.round(v * 100)}%</text>
          </g>
        ))}
        {segments(pass).map((s, i) => (s.length > 1 ? <path key={`pl${i}`} className="line-pass" d={pathOf(s)} /> : null))}
        {segments(goal).map((s, i) => (s.length > 1 ? <path key={`gl${i}`} className="line-goal" d={pathOf(s)} /> : null))}
        {pass.map((p, i) =>
          p ? (
            <circle key={`p${i}`} className="dot-pass" cx={p.x} cy={p.y} r={3.5}>
              <title>{`${shortDate(p.p.startedAt)}: pass rate ${percent(p.p.passRate)} (${p.p.pass} of ${p.p.runs} runs)`}</title>
            </circle>
          ) : null,
        )}
        {goal.map((p, i) =>
          p ? (
            <circle key={`g${i}`} className="dot-goal" cx={p.x} cy={p.y} r={3.5}>
              <title>{`${shortDate(p.p.startedAt)}: goal achieved ${percent(p.p.goalRate)}`}</title>
            </circle>
          ) : null,
        )}
        {labelIdx.map(i => (
          <text key={i} x={x(i)} y={H - 8} textAnchor={i === 0 && points.length > 1 ? 'start' : i === points.length - 1 && points.length > 1 ? 'end' : 'middle'}>
            {shortDate(points[i]?.startedAt)}
          </text>
        ))}
      </svg>
    </div>
  )
}

/** A rate with its interval: a track from 0 to 100 percent, the interval as a band, the rate as a marker. */
export function IntervalBar({ rate, interval, label }: { rate: number | null; interval: [number, number] | null; label: string }) {
  if (rate === null || interval === null) {
    return <div className="muted small">No labels of this class, so there is no interval to draw.</div>
  }
  const lo = Math.max(0, Math.min(1, interval[0])) * 100
  const hi = Math.max(0, Math.min(1, interval[1])) * 100
  return (
    <div>
      <div className="rate-track" role="img" aria-label={`${label}: ${percent(rate)}, 95 percent interval ${percent(interval[0])} to ${percent(interval[1])}`}>
        <div className="rate-interval" style={{ left: `${lo}%`, width: `${Math.max(hi - lo, 0.5)}%` }} />
        <div className="rate-point" style={{ left: `${Math.max(0, Math.min(1, rate)) * 100}%` }} />
      </div>
      <div className="rate-scale" aria-hidden="true">
        <span>0%</span>
        <span>50%</span>
        <span>100%</span>
      </div>
    </div>
  )
}

/** pass / fail / error as a stacked bar. */
export function OutcomeBar({ pass, fail, error, label }: { pass: number; fail: number; error: number; label: string }) {
  const total = pass + fail + error
  const seg = (n: number) => (total === 0 ? 0 : (n / total) * 100)
  return (
    <div className="stack-bar" role="img" aria-label={`${label}: ${pass} pass, ${fail} fail, ${error} error`}>
      <span className="seg-pass" style={{ width: `${seg(pass)}%` }} />
      <span className="seg-fail" style={{ width: `${seg(fail)}%` }} />
      <span className="seg-error" style={{ width: `${seg(error)}%` }} />
    </div>
  )
}
