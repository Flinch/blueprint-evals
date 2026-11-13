import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gradersForScenario, loadConfig, loadScenario, loadScenarios, createFakeProvider, ScenarioSchema } from '../src/index.js'

const examples = join(import.meta.dirname, '..', 'examples')

function workdir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'evals-'))
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), body)
  }
  return dir
}

describe('loading the examples', () => {
  it('loads every scenario, skipping the rubric files that sit beside them', () => {
    const loaded = loadScenarios(join(examples, 'scenarios'))
    expect(loaded.map(l => l.scenario.id).sort()).toEqual([
      'asks-for-medical-advice', 'asks-to-cancel-then-declines', 'reschedule-asks-before-acting', 'reschedule-tomorrow-3pm',
    ])
  })
  it('resolves a scenario\'s rubric relative to the scenario file', () => {
    const { rubric } = loadScenario(join(examples, 'scenarios', 'reschedule.yaml'))
    expect(rubric?.id).toBe('scheduling')
    expect(rubric?.criteria.map(c => c.id)).toEqual(['confirms-before-acting', 'no-medical-advice'])
  })
  it('loads the example config', () => {
    expect(loadConfig(join(examples, 'evals.config.yaml')).targets['stub-agent']?.kind).toBe('http')
  })
})

describe('errors name the file', () => {
  it('on an invalid scenario', () => {
    const dir = workdir({ 'bad.yaml': 'id: x\nversion: 1\ntarget: t\nmode: single_shot\n' })
    expect(() => loadScenario(join(dir, 'bad.yaml'))).toThrow(/bad\.yaml[\s\S]*input/)
  })
  it('on malformed YAML', () => {
    const dir = workdir({ 'broken.yaml': 'id: [unclosed\n' })
    expect(() => loadScenario(join(dir, 'broken.yaml'))).toThrow(/broken\.yaml: not valid YAML/)
  })
  it('on a rubric that does not exist', () => {
    const dir = workdir({ 's.yaml': 'id: s\nversion: 1\ntarget: t\npersona: p\nrubric: nope.yaml\n' })
    expect(() => loadScenario(join(dir, 's.yaml'))).toThrow(/nope\.yaml: cannot read file/)
  })
  it('on two scenarios sharing an id', () => {
    const body = 'id: same\nversion: 1\ntarget: t\npersona: p\n'
    const dir = workdir({ 'a.yaml': body, 'sub/b.yaml': body })
    expect(() => loadScenarios(dir)).toThrow(/Duplicate scenario id "same"/)
  })
})

describe('gradersForScenario', () => {
  const provider = createFakeProvider({ json: {} })
  const base = { id: 's', version: 1, target: 't', persona: 'p' }

  it('adds no LLM grader and no degenerate-output guard to a deterministic-only scenario', () => {
    const s = ScenarioSchema.parse({ ...base, checks: [{ type: 'must_not_call', tool: 'x' }] })
    expect(gradersForScenario(s).map(g => g.name)).toEqual(['must_not_call(x)'])
  })
  it('adds the guard, the checks, the judge and the goal check when all are present', () => {
    const { scenario, rubric } = loadScenario(join(examples, 'scenarios', 'reschedule.yaml'))
    const names = gradersForScenario(scenario, { rubric, provider }).map(g => g.name)
    expect(names[0]).toBe('min-content')
    expect(names).toContain('rubric-judge(scheduling@2)')
    expect(names.at(-1)).toBe('goal-check')
  })
  it('refuses to build a scenario that names a rubric without one, or needs a model without one', () => {
    const { scenario, rubric } = loadScenario(join(examples, 'scenarios', 'reschedule.yaml'))
    expect(() => gradersForScenario(scenario, { provider })).toThrow(/names the rubric/)
    expect(() => gradersForScenario(scenario, { rubric })).toThrow(/model provider/)
  })
})
