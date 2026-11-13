import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contaminationProblem, loadLabels, loadRubric, splitOf } from '../src/index.js'

// The borderline label set exists to compare judge models on cases that are
// easy to get wrong. These tests keep it honest: balanced, labelled as
// synthetic, and unable to leak into the rubric's own examples.

const examples = join(import.meta.dirname, '..', 'examples')
const labels = loadLabels(join(examples, 'labels', 'borderline.jsonl'))
const rubric = loadRubric(join(examples, 'scenarios', 'rubrics', 'scheduling.yaml'))

describe('the borderline label set', () => {
  it('has 12 passes and 12 fails for each criterion in the rubric', () => {
    for (const c of rubric.criteria) {
      const about = labels.filter(l => l.criterion === c.id)
      expect(about.filter(l => l.verdict === 'pass'), `${c.id} passes`).toHaveLength(12)
      expect(about.filter(l => l.verdict === 'fail'), `${c.id} fails`).toHaveLength(12)
    }
    expect(labels).toHaveLength(48)
  })

  it('says it is synthetic and hand-picked, so nobody mistakes it for expert random samples', () => {
    expect(new Set(labels.map(l => l.labeler))).toEqual(new Set(['claude-synthetic']))
    expect(new Set(labels.map(l => l.sampled_by))).toEqual(new Set(['targeted']))
  })

  it('does not contain any of the rubric anchors, so the judge is never graded on its own examples', () => {
    expect(contaminationProblem(labels, rubric.anchors)).toBeNull()
  })

  it('has no repeated response under a different id', () => {
    const keys = labels.map(l => `${l.criterion}|${l.input}|${l.output}`.toLowerCase())
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('leaves both the dev and test splits with passes and fails to measure', () => {
    for (const split of ['dev', 'test'] as const) {
      const inSplit = labels.filter(l => splitOf(l) === split)
      expect(inSplit.filter(l => l.verdict === 'pass').length, `${split} passes`).toBeGreaterThanOrEqual(5)
      expect(inSplit.filter(l => l.verdict === 'fail').length, `${split} fails`).toBeGreaterThanOrEqual(5)
    }
  })
})
