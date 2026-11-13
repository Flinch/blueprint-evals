import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { API_ROUTES } from '../../src/server/index.js'

const root = join(import.meta.dirname, '..', '..')
const doc = readFileSync(join(root, 'docs', 'design', '0003-ui-and-api.md'), 'utf8')
const types = readFileSync(join(root, 'src', 'ui', 'api-types.ts'), 'utf8')

describe('docs/design/0003-ui-and-api.md', () => {
  it('describes every endpoint the server exposes', () => {
    for (const route of API_ROUTES) {
      const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      expect(doc, route).toMatch(new RegExp(`\`${escaped}[\`?]`))
    }
  })

  it('has no endpoint the server does not have', () => {
    const mentioned = [...doc.matchAll(/\*\*`((?:GET|POST) \/api\/[^`?]*)/g)].map(m => m[1]!)
    expect(mentioned.length).toBeGreaterThan(10)
    for (const m of mentioned) expect(API_ROUTES as readonly string[], m).toContain(m)
  })

  it('repeats src/ui/api-types.ts verbatim in its appendix, so the two cannot drift', () => {
    const appendix = /<!-- api-types:start -->\n```ts\n([\s\S]*?)\n```\n<!-- api-types:end -->/.exec(doc)?.[1]
    expect(appendix).toBeDefined()
    expect(appendix!.trim()).toBe(types.trim())
  })

  it('lists every error code in its table', () => {
    const block = /export type ErrorCode =([\s\S]*?)export interface ApiErrorBody/.exec(types)![1]!
    const codes = [...block.matchAll(/\| '([a-z_]+)'/g)].map(m => m[1]!)
    expect(codes.length).toBeGreaterThan(15)
    for (const code of codes) expect(doc, code).toContain(`\`${code}\``)
  })

  it('has no em-dashes, here or in the README', () => {
    expect(doc).not.toContain('—')
    expect(readFileSync(join(root, 'README.md'), 'utf8')).not.toContain('—')
    expect(types).not.toContain('—')
  })

  it('is mentioned in the README, along with the data directory and the local-only binding', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    expect(readme).toMatch(/## Web UI/)
    expect(readme).toMatch(/npx evals ui/)
    expect(readme).toMatch(/127\.0\.0\.1/)
    expect(readme).toMatch(/\.evals\/runs\//)
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toMatch(/^\.evals\/$/m)
  })
})
