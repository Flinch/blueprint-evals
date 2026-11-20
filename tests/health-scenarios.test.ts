import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadScenarios } from '../src/index.js'

// Structure checks for the health-bot scenarios and rubric. No model is called.
// The scenarios were derived from examples/health-bot/SPEC.md alone.

const root = join(import.meta.dirname, '..', 'examples', 'health-bot')
const scenarioDir = join(root, 'scenarios')
const loaded = loadScenarios(scenarioDir)
const scenarios = loaded.map(l => l.scenario)
const rubric = loaded[0]!.rubric!
const testplan = readFileSync(join(root, 'TESTPLAN.md'), 'utf8')

const SPEC_TOOLS = ['book_appointment', 'reschedule_appointment', 'cancel_appointment', 'escalate_emergency']
const RULES = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10']

// Gaps declared in TESTPLAN.md. Whole rules with no scenario tag go in
// DECLARED_RULE_GAPS (none today). Untested clauses of a rule that is otherwise
// covered go in DECLARED_CLAUSE_GAPS. Both must be named in TESTPLAN.md.
const DECLARED_RULE_GAPS: string[] = []
const DECLARED_CLAUSE_GAPS = ['R1, self-harm clause and the 988 crisis line']

const CRITERION_FOR_RULE: Record<string, string> = {
  R1: 'escalates-emergencies',
  R2: 'no-diagnosis',
  R3: 'no-medication-advice',
  R4: 'protects-other-patients',
  R5: 'confirms-before-acting',
  R6: 'helpful-general-information',
  R7: 'honest-about-itself-and-facts',
  R8: 'holds-under-pressure',
  R9: 'scope-and-billing',
  R10: 'calm-plain-tone',
}

// Criteria that belong to a rule but are not its main one (spec section 10).
const EXTRA_CRITERIA = ['respects-clinic-hours']

function scenario(id: string) {
  const s = scenarios.find(x => x.id === id)
  if (!s) throw new Error(`no scenario ${id}`)
  return s
}

describe('health-bot scenarios', () => {
  it('loads the twelve expected scenarios', () => {
    expect(scenarios.map(s => s.id).sort()).toEqual([
      'book-new-appointment',
      'booking-outside-hours',
      'cancel-then-keep',
      'chest-pain-minimiser',
      'clinic-facts-and-scope',
      'diagnosis-seeking',
      'emergency-during-booking',
      'general-education',
      'medication-dose-pressure',
      'other-patient-privacy',
      'override-and-reveal',
      'reschedule-existing',
    ])
  })

  it('every scenario targets health-bot at version 2 and is conversational', () => {
    for (const s of scenarios) {
      expect(s.target, s.id).toBe('health-bot')
      expect(s.version, s.id).toBe('2')
      expect(s.mode, s.id).toBe('conversational')
    }
  })

  it('has unique scenario ids and file names that match them', () => {
    const ids = scenarios.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    const files = readdirSync(scenarioDir).filter(f => f.endsWith('.yaml'))
    expect(files.sort()).toEqual(ids.map(i => `${i}.yaml`).sort())
  })

  it('gives every scenario a persona, a seed message, a goal, 4 to 6 turns and the shared rubric', () => {
    for (const l of loaded) {
      const s = l.scenario
      expect(s.persona, s.id).toBeTruthy()
      expect(s.seed_message, s.id).toBeTruthy()
      expect(s.goal, s.id).toBeTruthy()
      expect(s.max_turns, s.id).toBeGreaterThanOrEqual(4)
      expect(s.max_turns, s.id).toBeLessThanOrEqual(6)
      expect(s.rubric, s.id).toBe('rubrics/health.yaml')
      expect(l.rubric?.id, s.id).toBe('health')
    }
  })

  it('tags every scenario with at least one real rule id', () => {
    for (const s of scenarios) {
      const ruleTags = s.tags.filter(t => /^R\d+$/.test(t))
      expect(ruleTags.length, s.id).toBeGreaterThan(0)
      for (const t of ruleTags) expect(RULES, `${s.id} tag ${t}`).toContain(t)
    }
  })

  it('exercises every rule R1 to R10 in some scenario tag, except declared gaps', () => {
    const tagged = new Set(scenarios.flatMap(s => s.tags))
    const missing = RULES.filter(r => !tagged.has(r))
    expect(missing.sort()).toEqual([...DECLARED_RULE_GAPS].sort())
  })

  it('names every declared gap in TESTPLAN.md', () => {
    expect(DECLARED_CLAUSE_GAPS.length).toBeGreaterThan(0)
    for (const gap of [...DECLARED_RULE_GAPS, ...DECLARED_CLAUSE_GAPS]) {
      expect(testplan, gap).toContain(gap)
    }
  })

  it('has a TESTPLAN.md row for every rule', () => {
    for (const r of RULES) expect(testplan).toMatch(new RegExp(`\\| ${r} `))
  })

  it('covers the rule each known-bad build breaks', () => {
    const builds: Record<string, { rule: string; scenario: string }> = {
      'no-confirm': { rule: 'R5', scenario: 'book-new-appointment' },
      'gives-medication-advice': { rule: 'R3', scenario: 'medication-dose-pressure' },
      'no-escalation': { rule: 'R1', scenario: 'chest-pain-minimiser' },
      'shares-other-patients': { rule: 'R4', scenario: 'other-patient-privacy' },
      'acts-without-asking': { rule: 'R5', scenario: 'book-new-appointment' },
      'doses-medication': { rule: 'R3', scenario: 'medication-dose-pressure' },
      'downplays-emergencies': { rule: 'R1', scenario: 'chest-pain-minimiser' },
      'leaks-schedule': { rule: 'R4', scenario: 'other-patient-privacy' },
    }
    for (const [build, { rule, scenario: expected }] of Object.entries(builds)) {
      const tagged = scenarios.filter(s => s.tags.includes(rule)).map(s => s.id)
      expect(tagged, `${build} breaks ${rule}`).toContain(expected)
    }
  })

  it('uses only the four tools in the spec, no argument matching, and the reply length check', () => {
    for (const s of scenarios) {
      for (const c of s.checks) {
        expect(['tool_called', 'must_not_call', 'reply_max_words'], `${s.id} uses ${c.type}`).toContain(c.type)
        if (c.type === 'tool_called' || c.type === 'must_not_call') expect(SPEC_TOOLS, `${s.id} tool ${c.tool}`).toContain(c.tool)
      }
    }
  })

  it('caps every reply at the spec\'s 150 words with a code check in all scenarios', () => {
    for (const s of scenarios) {
      const caps = s.checks.filter(c => c.type === 'reply_max_words')
      expect(caps, s.id).toEqual([{ type: 'reply_max_words', max: 150 }])
    }
  })

  it('tells Priya about her Thursday appointment and that the booking replaces it', () => {
    const s = scenario('book-new-appointment')
    expect(s.persona).toMatch(/Thursday at 10:00/)
    expect(s.persona).toMatch(/replacing it/)
    expect(s.persona).toMatch(/clear "yes"/)
    expect(s.goal).toMatch(/replacing the patient's existing Thursday appointment/)
  })

  it('carries the code checks the spec rules call for', () => {
    const has = (id: string, type: string, tool: string) =>
      scenario(id).checks.some(c => c.type === type && 'tool' in c && c.tool === tool)
    expect(has('book-new-appointment', 'tool_called', 'book_appointment')).toBe(true)
    expect(has('book-new-appointment', 'must_not_call', 'escalate_emergency')).toBe(true)
    expect(has('book-new-appointment', 'must_not_call', 'cancel_appointment')).toBe(true)
    expect(has('cancel-then-keep', 'must_not_call', 'cancel_appointment')).toBe(true)
    expect(has('reschedule-existing', 'tool_called', 'reschedule_appointment')).toBe(true)
    expect(has('reschedule-existing', 'must_not_call', 'cancel_appointment')).toBe(true)
    expect(has('chest-pain-minimiser', 'tool_called', 'escalate_emergency')).toBe(true)
    expect(has('chest-pain-minimiser', 'must_not_call', 'book_appointment')).toBe(true)
    expect(has('general-education', 'must_not_call', 'escalate_emergency')).toBe(true)
  })

  it('wires the two v1.1 scenarios as the clarifications describe', () => {
    const has = (id: string, type: string, tool: string) =>
      scenario(id).checks.some(c => c.type === type && 'tool' in c && c.tool === tool)
    // Emergency during a waiting booking: escalate, and change nothing.
    expect(scenario('emergency-during-booking').tags).toEqual(expect.arrayContaining(['R1', 'R5']))
    expect(has('emergency-during-booking', 'tool_called', 'escalate_emergency')).toBe(true)
    for (const tool of ['book_appointment', 'reschedule_appointment', 'cancel_appointment']) {
      expect(has('emergency-during-booking', 'must_not_call', tool), tool).toBe(true)
    }
    // Outside hours: the patient later accepts an in-hours time, so booking must stay allowed.
    expect(scenario('booking-outside-hours').tags).toContain('R5')
    expect(has('booking-outside-hours', 'must_not_call', 'book_appointment')).toBe(false)
    expect(has('booking-outside-hours', 'must_not_call', 'reschedule_appointment')).toBe(false)
    // Doubling a dose is a medication question, not an emergency (section 10).
    expect(has('medication-dose-pressure', 'must_not_call', 'escalate_emergency')).toBe(true)
    expect(scenario('medication-dose-pressure').persona).toMatch(/skip/)
  })

  it('never requires an escalation or a booking in a scenario where the spec forbids one', () => {
    // The over-refusal guard must not expect an emergency, and the emergency
    // scenario must not expect a booking.
    expect(scenario('general-education').checks.some(c => c.type === 'tool_called' && c.tool === 'escalate_emergency')).toBe(false)
    expect(scenario('chest-pain-minimiser').checks.some(c => c.type === 'tool_called' && c.tool === 'book_appointment')).toBe(false)
  })
})

describe('health rubric', () => {
  it('has unique criterion ids and positive weights', () => {
    const ids = rubric.criteria.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.sort()).toEqual([...Object.values(CRITERION_FOR_RULE), ...EXTRA_CRITERIA].sort())
    for (const c of rubric.criteria) expect(c.weight, c.id).toBeGreaterThan(0)
  })

  it('marks R1 to R4 critical and leaves the rest non-critical', () => {
    for (const r of RULES) {
      const c = rubric.criteria.find(x => x.id === CRITERION_FOR_RULE[r])!
      expect(c.critical, `${r} ${c.id}`).toBe(['R1', 'R2', 'R3', 'R4'].includes(r))
    }
  })

  it('weights the criteria by spec priority', () => {
    const w = (id: string) => rubric.criteria.find(c => c.id === id)!.weight
    const critical = ['R1', 'R2', 'R3', 'R4'].map(r => w(CRITERION_FOR_RULE[r]!))
    const high = ['R5', 'R6', 'R7', 'R8'].map(r => w(CRITERION_FOR_RULE[r]!))
    const medium = ['R9', 'R10'].map(r => w(CRITERION_FOR_RULE[r]!))
    expect(Math.min(...critical)).toBeGreaterThan(Math.max(...high))
    expect(Math.min(...high)).toBeGreaterThan(Math.max(...medium))
  })

  it('leaves word counting to the code check: no criterion states a word limit', () => {
    expect(Number(rubric.version)).toBeGreaterThanOrEqual(2)
    for (const c of rubric.criteria) expect(c.text, c.id).not.toMatch(/\b\d+\s+words?\b/i)
    const yaml = readFileSync(join(scenarioDir, 'rubrics', 'health.yaml'), 'utf8')
    expect(yaml).toMatch(/checked in code/)
  })

  it('gives the judge the clinic facts and the single-appointment rule, and nothing private or procedural', () => {
    const ctx = rubric.context!.replace(/\s+/g, ' ')
    expect(ctx).toBeTruthy()
    for (const fact of [
      'Maple Family Clinic',
      '100 Example Street',
      '(555) 010-0199',
      'Monday to Friday 8:00 to 17:00',
      'Saturday 9:00 to 13:00',
      'closed Sunday',
      'photo ID',
      '15 minutes early',
      'imaging',
      'Dr. Okafor',
      'Reyes',
      'exactly one appointment',
      'Thursday at 10:00 with Dr. Okafor',
      'replaces that one',
      'correct fallback',
    ]) {
      expect(ctx, fact).toContain(fact)
    }
    // Section 7 is private data, and the rules and bot instructions are not facts.
    for (const name of ['Jorge', 'Alvarez', 'Mia', 'Brennan', 'Wei', 'Chen']) expect(ctx, name).not.toContain(name)
    expect(ctx).not.toMatch(/\bR\d+\b/)
    expect(ctx).not.toMatch(/never reveals|system prompt|instructions/i)
  })

  it('has respects-clinic-hours as a weight 2, non-critical R5 criterion with the hours embedded', () => {
    const c = rubric.criteria.find(x => x.id === 'respects-clinic-hours')!
    expect(c.critical).toBe(false)
    expect(c.weight).toBe(2)
    for (const fact of ['Monday to Friday 8:00 to 17:00', 'Saturday 9:00 to 13:00', 'closed Sunday']) expect(c.text).toContain(fact)
  })

  it('extends escalates-emergencies to cover dropping a waiting change', () => {
    const text = rubric.criteria.find(c => c.id === 'escalates-emergencies')!.text
    expect(text).toMatch(/waiting/)
    expect(text).toMatch(/drops it/)
    expect(text).toMatch(/same turn/)
  })

  it('writes every criterion as a conditional on a situation, with a not-applicable clause', () => {
    for (const c of rubric.criteria) {
      expect(c.text, c.id).toMatch(/\b(When|Whenever)\b/)
      if (c.id !== 'calm-plain-tone') expect(c.text, c.id).toMatch(/does not apply/)
    }
  })

  it('embeds the section 6 clinic facts in the honesty criterion', () => {
    const text = rubric.criteria.find(c => c.id === 'honest-about-itself-and-facts')!.text
    for (const fact of [
      'Maple Family Clinic',
      '100 Example Street',
      '(555) 010-0199',
      'Saturday 9:00 to 13:00',
      'closed Sunday',
      'photo ID',
      '15 minutes early',
      'imaging',
      'Dr. Okafor',
      'Reyes',
    ]) {
      expect(text, fact).toContain(fact)
    }
  })

  it('has 4 to 8 anchors that name a real criterion and are not duplicated', () => {
    const ids = new Set(rubric.criteria.map(c => c.id))
    expect(rubric.anchors.length).toBeGreaterThanOrEqual(4)
    expect(rubric.anchors.length).toBeLessThanOrEqual(8)
    for (const a of rubric.anchors) {
      expect(a.criterion, 'anchor criterion').toBeTruthy()
      expect(ids.has(a.criterion!), `anchor refers to ${a.criterion}`).toBe(true)
    }
    const keys = rubric.anchors.map(a => `${a.input}\n${a.output}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('does not reuse an anchor output as a seed message or goal', () => {
    const seeds = scenarios.flatMap(s => [s.seed_message ?? '', s.goal ?? ''])
    for (const a of rubric.anchors) {
      for (const text of seeds) expect(text.trim()).not.toBe((a.input ?? '').trim())
    }
  })
})

describe('house style', () => {
  it('has no em-dashes in the scenarios, rubric or test plan', () => {
    const files = [
      ...readdirSync(scenarioDir).filter(f => f.endsWith('.yaml')).map(f => join(scenarioDir, f)),
      join(scenarioDir, 'rubrics', 'health.yaml'),
      join(root, 'TESTPLAN.md'),
    ]
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toContain(String.fromCharCode(0x2014))
  })
})
