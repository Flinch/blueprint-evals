import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FRAMEWORK_VERSION } from '../src/index.js'

it('records the version in package.json in every trace', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string }
  expect(FRAMEWORK_VERSION).toBe(pkg.version)
})
