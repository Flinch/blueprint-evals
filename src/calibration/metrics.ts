// Judge-versus-expert agreement, measured the way the critique-shadowing
// process asks: as a classifier. See docs/design/0002-judge-methodology.md.
//
// "Positive" is pass. True positive rate is how often the judge passes what the
// expert passed. True negative rate is how often the judge fails what the
// expert failed, and it is the one that matters more here: a judge that passes
// a bad agent is the dangerous error.

export type Verdict = 'pass' | 'fail'

export interface Confusion {
  /** Expert pass, judge pass. */
  tp: number
  /** Expert pass, judge fail. */
  fn: number
  /** Expert fail, judge fail. */
  tn: number
  /** Expert fail, judge pass: the dangerous one. */
  fp: number
}

export interface RateEstimate {
  /** null when there is nothing to measure. */
  rate: number | null
  successes: number
  /** How many items of this class were measured. */
  n: number
  /** 95 percent Wilson score interval, or null when n is 0. */
  interval: [number, number] | null
}

export interface Metrics {
  /** Items measured. */
  n: number
  confusion: Confusion
  /** Of the items the expert passed, the share the judge passed. */
  tpr: RateEstimate
  /** Of the items the expert failed, the share the judge failed. */
  tnr: RateEstimate
  /** Shown only with prevalence, since it is misleading when one class dominates. */
  accuracy: number | null
  /** Share of items the expert passed. */
  prevalencePass: number | null
  /** Cohen's kappa. Secondary: unstable on imbalanced data. null when undefined (no variation). */
  kappa: number | null
  /** True when the sample is too small to trust. The warnings say why. */
  insufficient: boolean
  warnings: string[]
}

/** Per-class minimum and overall minimum, the post's own rules of thumb, used as warnings and not cutoffs. */
export const MIN_PER_CLASS = 30
export const MIN_TOTAL = 60

/**
 * The Wilson score interval for a proportion. Behaves sensibly at small n and
 * at rates near 0 or 1, where the simple normal approximation does not.
 */
export function wilsonInterval(successes: number, n: number, z = 1.96): [number, number] | null {
  if (n <= 0) return null
  const p = successes / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  return [Math.max(0, centre - half), Math.min(1, centre + half)]
}

function estimate(successes: number, n: number): RateEstimate {
  return { rate: n > 0 ? successes / n : null, successes, n, interval: wilsonInterval(successes, n) }
}

export function cohensKappa(c: Confusion): number | null {
  const n = c.tp + c.fn + c.tn + c.fp
  if (n === 0) return null
  const po = (c.tp + c.tn) / n
  const judgePass = (c.tp + c.fp) / n
  const expertPass = (c.tp + c.fn) / n
  const pe = judgePass * expertPass + (1 - judgePass) * (1 - expertPass)
  // pe of 1 means both sides gave the same single answer every time: no variation
  // to measure chance agreement against, so kappa is 0/0 and not a number.
  return pe === 1 ? null : (po - pe) / (1 - pe)
}

export function computeMetrics(pairs: { expert: Verdict; judge: Verdict }[]): Metrics {
  const confusion: Confusion = { tp: 0, fn: 0, tn: 0, fp: 0 }
  for (const { expert, judge } of pairs) {
    if (expert === 'pass') judge === 'pass' ? confusion.tp++ : confusion.fn++
    else judge === 'fail' ? confusion.tn++ : confusion.fp++
  }
  const n = pairs.length
  const expertPass = confusion.tp + confusion.fn
  const expertFail = confusion.tn + confusion.fp

  const warnings: string[] = []
  if (n === 0) warnings.push('No labels were measured.')
  else {
    if (n < MIN_TOTAL) warnings.push(`Only ${n} labels (about ${MIN_TOTAL} or more recommended): the intervals are too wide to support a conclusion.`)
    if (expertPass < MIN_PER_CLASS) warnings.push(`Only ${expertPass} expert-pass labels (${MIN_PER_CLASS} or more recommended): the true positive rate is poorly measured.`)
    if (expertFail < MIN_PER_CLASS) warnings.push(`Only ${expertFail} expert-fail labels (${MIN_PER_CLASS} or more recommended): the true negative rate is poorly measured.`)
    const prevalence = expertPass / n
    if (prevalence > 0.9 || prevalence < 0.1) {
      warnings.push(`${Math.round(prevalence * 100)}% of labels are expert-pass: accuracy is misleading when one class dominates, so read the two rates instead.`)
    }
  }

  return {
    n,
    confusion,
    tpr: estimate(confusion.tp, expertPass),
    tnr: estimate(confusion.tn, expertFail),
    accuracy: n > 0 ? (confusion.tp + confusion.tn) / n : null,
    prevalencePass: n > 0 ? expertPass / n : null,
    kappa: cohensKappa(confusion),
    insufficient: n < MIN_TOTAL || expertPass < MIN_PER_CLASS || expertFail < MIN_PER_CLASS,
    warnings,
  }
}
