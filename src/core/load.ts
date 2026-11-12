import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { ConfigSchema, type Config } from './config.js'
import { RubricSchema, ScenarioSchema, type Rubric, type Scenario } from './scenario.js'

// Loads and validates the YAML files. Errors always name the file, because a
// bare "expected string at path.0.x" is no help in a directory of scenarios.

export interface LoadedScenario {
  scenario: Scenario
  /** Present when the scenario names a rubric file. */
  rubric?: Rubric
  file: string
}

function read(file: string): unknown {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    throw new Error(`${file}: cannot read file (${e instanceof Error ? e.message : String(e)})`)
  }
  try {
    return parse(text)
  } catch (e) {
    throw new Error(`${file}: not valid YAML (${e instanceof Error ? e.message : String(e)})`)
  }
}

function validate<T extends z.ZodType>(schema: T, data: unknown, file: string): z.infer<T> {
  const result = schema.safeParse(data)
  if (!result.success) throw new Error(`${file}:\n${z.prettifyError(result.error)}`)
  return result.data
}

export function loadConfig(file: string): Config {
  return validate(ConfigSchema, read(file), file)
}

export function loadRubric(file: string): Rubric {
  return validate(RubricSchema, read(file), file)
}

/** Loads one scenario and the rubric it names (resolved relative to the scenario file). */
export function loadScenario(file: string): LoadedScenario {
  const scenario = validate(ScenarioSchema, read(file), file)
  const rubric = scenario.rubric ? loadRubric(resolve(dirname(file), scenario.rubric)) : undefined
  return { scenario, rubric, file }
}

/** Loads every scenario file under a path (a file, or a directory searched recursively). */
export function loadScenarios(path: string): LoadedScenario[] {
  if (statSync(path).isFile()) return [loadScenario(path)]

  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      // Rubric files live alongside scenarios. Only files with a `target` are scenarios.
      else if (/\.ya?ml$/.test(name) && isScenarioFile(full)) files.push(full)
    }
  }
  walk(path)

  const loaded = files.map(loadScenario)
  const seen = new Map<string, string>()
  for (const l of loaded) {
    const prior = seen.get(l.scenario.id)
    if (prior) throw new Error(`Duplicate scenario id "${l.scenario.id}" in ${prior} and ${l.file}`)
    seen.set(l.scenario.id, l.file)
  }
  return loaded
}

function isScenarioFile(file: string): boolean {
  const data = read(file)
  return typeof data === 'object' && data !== null && 'target' in data
}
