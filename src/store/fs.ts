import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/**
 * Writes a file so a reader never sees half of it: the text goes to a temporary
 * file in the same directory, then is renamed over the target. Rename is atomic
 * on one filesystem.
 */
export function writeFileAtomic(file: string, text: string): void {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  // A leading dot and a .tmp suffix keep the temporary file out of every listing.
  const tmp = join(dir, `.${basename(file)}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    writeFileSync(tmp, text)
    renameSync(tmp, file)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

/** A short, sortable, file-name-safe timestamp: 20261113T025900Z. */
export function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

export function newId(date = new Date()): string {
  return `${compactTimestamp(date)}-${randomBytes(4).toString('hex')}`
}

/** Ids become file names, so only a safe alphabet is allowed: no separators, no dots at the start, no "..". */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export class InvalidIdError extends Error {
  constructor(what: string) {
    super(`invalid ${what}`)
    this.name = 'InvalidIdError'
  }
}

export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_ID.test(id) && !id.includes('..')
}

export function assertSafeId(id: unknown, what: string): string {
  if (!isSafeId(id)) throw new InvalidIdError(what)
  return id
}
