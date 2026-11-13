import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parse } from 'yaml'
import { loadRubric, loadScenario, type LoadedScenario } from '../core/load.js'
import type { Rubric } from '../core/scenario.js'

// A forgiving read of a scenarios directory, for a screen that lists what is
// there. `loadScenarios` stops at the first bad file, which is right for a run.
// This one keeps going and reports each problem, as `evals validate` does.

export interface LoadedRubric {
  rubric: Rubric
  file: string
}

export interface Catalog {
  scenarios: LoadedScenario[]
  rubrics: LoadedRubric[]
  problems: string[]
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

function sniff(file: string): 'scenario' | 'rubric' | undefined {
  try {
    const data = parse(readFileSync(file, 'utf8')) as unknown
    if (typeof data !== 'object' || data === null) return undefined
    if ('target' in data) return 'scenario'
    if ('criteria' in data) return 'rubric'
  } catch {
    // Not valid YAML. Reported by the caller as a problem for files that look like ours.
  }
  return undefined
}

export function loadCatalog(path: string): Catalog {
  const problems: string[] = []
  const scenarios: LoadedScenario[] = []
  const rubrics = new Map<string, LoadedRubric>()
  const ids = new Map<string, string>()

  const addScenario = (file: string) => {
    try {
      const loaded = loadScenario(file)
      const prior = ids.get(loaded.scenario.id)
      if (prior) {
        problems.push(`Duplicate scenario id "${loaded.scenario.id}" in ${prior} and ${file}`)
        return
      }
      ids.set(loaded.scenario.id, file)
      scenarios.push(loaded)
      if (loaded.rubric) {
        const rubricFile = resolve(dirname(file), loaded.scenario.rubric!)
        rubrics.set(rubricFile, { rubric: loaded.rubric, file: rubricFile })
      }
    } catch (e) {
      problems.push(message(e))
    }
  }
  const addRubric = (given: string) => {
    const file = resolve(given)
    if (rubrics.has(file)) return
    try {
      rubrics.set(file, { rubric: loadRubric(file), file })
    } catch (e) {
      problems.push(message(e))
    }
  }

  let isFile = false
  try {
    isFile = statSync(path).isFile()
  } catch (e) {
    return { scenarios, rubrics: [], problems: [message(e)] }
  }
  if (isFile) {
    addScenario(path)
  } else {
    const walk = (dir: string) => {
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name)
        let stat
        try {
          stat = statSync(full)
        } catch {
          continue
        }
        if (stat.isDirectory()) walk(full)
        else if (/\.ya?ml$/.test(name)) {
          const kind = sniff(full)
          if (kind === 'scenario') addScenario(full)
          else if (kind === 'rubric') addRubric(full)
        }
      }
    }
    walk(path)
  }
  return { scenarios, rubrics: [...rubrics.values()], problems }
}
