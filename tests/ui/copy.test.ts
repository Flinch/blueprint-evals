import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The copy rules for everything a person reads in the UI and the demo data: no
// em-dashes, and no trailing "X, not Y" contrasts.

const root = join(import.meta.dirname, '..', '..')
const walk = (d: string): string[] =>
  readdirSync(d).flatMap(n => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]))

const files = [...walk(join(root, 'ui', 'src')), join(root, 'ui', 'index.html'), join(root, 'scripts', 'seed-demo.ts'), join(root, 'docs', 'design', '0003-ui-and-api.md')].filter(f =>
  /\.(tsx?|css|html|md)$/.test(f),
)

describe('front end and demo copy', () => {
  it('has files to check', () => {
    expect(files.length).toBeGreaterThan(15)
  })

  it('has no em-dashes', () => {
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toContain('—')
  })

  it('has no trailing negative-parallelism contrasts such as "X, not Y"', () => {
    for (const f of files.filter(f => !f.endsWith('.css'))) {
      const lines = readFileSync(f, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return // code comments are not user-facing
        expect(line, `${f}:${i + 1}`).not.toMatch(/[a-z]\., not (the|a|an|this|that)\b|\bnot (just|only) [a-z ]{1,30}, (but )?(also )?[a-z]/i)
        expect(line, `${f}:${i + 1}`).not.toMatch(/\bnot [a-z ]{1,25}, not /i)
      })
    }
  })
})
