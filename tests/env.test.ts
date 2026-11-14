import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadDotEnv } from '../src/env.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function envFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dotenv-'))
  dirs.push(dir)
  const path = join(dir, '.env')
  writeFileSync(path, contents)
  return path
}

describe('loadDotEnv', () => {
  it('does nothing when there is no file', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(loadDotEnv(join(tmpdir(), 'no-such-dir', '.env'), env)).toEqual({ found: false, applied: [] })
    expect(env).toEqual({})
  })

  it('applies values, handling comments and quotes, and returns names only', () => {
    const env: NodeJS.ProcessEnv = {}
    const result = loadDotEnv(envFile('# credentials\nANTHROPIC_API_KEY="sk-ant-test"\nPORT=4020\n'), env)
    expect(env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-test', PORT: '4020' })
    expect(result).toEqual({ found: true, applied: ['ANTHROPIC_API_KEY', 'PORT'] })
    expect(JSON.stringify(result)).not.toContain('sk-ant-test')
  })

  it('lets the file win over a stale variable already in the shell', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:6767' }
    loadDotEnv(envFile('ANTHROPIC_BASE_URL=https://api.anthropic.com\n'), env)
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com')
  })

  it('ignores a blank placeholder, so it never wipes a key that is already set', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'sk-ant-from-shell' }
    const result = loadDotEnv(envFile('ANTHROPIC_API_KEY=\n'), env)
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-from-shell')
    expect(result.applied).toEqual([])
  })
})
