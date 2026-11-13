import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CalibrationReport } from '../calibration/evaluate.js'
import { assertSafeId, isSafeId, newId, writeFileAtomic } from './fs.js'

// Saved calibration reports: <workdir>/.evals/calibration/<calibrationId>.json.
// A calibration is a measurement of one judge on one label set, so the record
// keeps what it was measured with.

export interface CalibrationRecord {
  schemaVersion: 1
  calibrationId: string
  at: string
  rubricId: string
  rubricVersion: string
  /** Absolute path of the label file that was measured. */
  labelsFile: string
  split: 'dev' | 'test'
  selection: 'random' | 'all'
  command: string
  report: CalibrationReport
}

export function saveCalibration(dir: string, input: Omit<CalibrationRecord, 'schemaVersion' | 'calibrationId' | 'at'>, now = new Date()): CalibrationRecord {
  const record: CalibrationRecord = { schemaVersion: 1, calibrationId: newId(now), at: now.toISOString(), ...input }
  writeFileAtomic(join(dir, `${record.calibrationId}.json`), JSON.stringify(record, null, 2) + '\n')
  return record
}

export function readCalibration(dir: string, id: string): CalibrationRecord | null {
  assertSafeId(id, 'calibration id')
  const file = join(dir, `${id}.json`)
  if (!existsSync(file)) return null
  try {
    const json = JSON.parse(readFileSync(file, 'utf8')) as CalibrationRecord
    return json.schemaVersion === 1 && json.calibrationId === id && json.report ? json : null
  } catch {
    return null
  }
}

/** Saved calibrations, newest first. Unreadable files are skipped. */
export function listCalibrations(dir: string): CalibrationRecord[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: CalibrationRecord[] = []
  for (const name of names) {
    const id = name.endsWith('.json') ? name.slice(0, -5) : undefined
    if (id === undefined || !isSafeId(id)) continue
    const r = readCalibration(dir, id)
    if (r) out.push(r)
  }
  return out.sort((a, b) => b.at.localeCompare(a.at) || b.calibrationId.localeCompare(a.calibrationId))
}

export function latestCalibration(dir: string): CalibrationRecord | null {
  return listCalibrations(dir)[0] ?? null
}
