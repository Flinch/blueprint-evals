import { createHash } from 'node:crypto'
import { Document, isMap, isScalar, isSeq, parse, parseDocument, type Node, type Pair, type Scalar, type YAMLMap, type YAMLSeq } from 'yaml'
import { z } from 'zod'
import { deepEqual } from '../core/equal.js'
import { AnchorSchema, RubricSchema, type Anchor, type Rubric } from '../core/scenario.js'
import { ApiError } from './http.js'

// Applies an edit from the page to a rubric file. See PUT /api/rubrics/:id in
// docs/design/0003-ui-and-api.md.
//
// The file stays the source of truth and `git diff` stays the review, so an
// edit must change only what was edited. Re-printing the whole parsed document
// (`Document.toString()`) keeps comments but re-wraps every folded block in the
// file, which buries a one-line change in dozens of unrelated ones. Instead the
// yaml Document API is used to find each node's place in the source text
// (`range`) and to print each new value, and only those spans of the original
// text are replaced. Everything else is kept byte for byte, comments included.
// The result is parsed again with the loader's own schema and compared with what
// was asked for before anything is written.

export const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

export interface CriterionEdit {
  id: string
  text: string
  weight?: number
  critical?: boolean
}

export interface RubricEdit {
  criteria: CriterionEdit[]
  context: string | null
  /** Validated here with AnchorSchema, so a bad example is a 422 that names it. */
  anchors: unknown[]
  version?: string
}

export interface AppliedEdit {
  /** The new file text. */
  text: string
  /** The rubric as the loader reads the new text. */
  rubric: Rubric
  /** Ids of the criteria whose wording changed. */
  textChanged: string[]
}

const invalid = (message: string) => new ApiError(422, 'rubric_invalid', message)
const ANCHOR_FIELDS = ['criterion', 'input', 'output', 'verdict', 'critique'] as const
type Splice = { start: number; end: number; text: string }

/** The edited rubric, the version it gets and the new file text. Throws ApiError for anything that cannot be applied. */
export function applyRubricEdit(source: string, edit: RubricEdit): AppliedEdit {
  const doc = parseDocument(source)
  if (doc.errors.length > 0) throw invalid(`The file is not valid YAML: ${doc.errors[0]!.message}`)
  const top = doc.contents
  if (!isMap(top)) throw invalid('The file is not a YAML mapping.')
  const parsed = RubricSchema.safeParse(doc.toJS())
  if (!parsed.success) throw invalid(`The file does not validate as a rubric:\n${z.prettifyError(parsed.error)}`)
  const current = parsed.data

  // ---- what was asked for

  const ids = current.criteria.map(c => c.id)
  const given = edit.criteria.map(c => c.id)
  if (!deepEqual(ids, given)) {
    throw invalid(
      `Criteria cannot be added, removed, renamed or reordered from the page, because labels and runs refer to them by id. ` +
        `Send the file's criteria in its order: ${ids.join(', ')}. To change the set, edit the file in your editor.`,
    )
  }
  const problems: string[] = []
  const criteria = current.criteria.map((c, i) => {
    const e = edit.criteria[i]!
    if (e.text.trim() === '') problems.push(`The text of criterion "${c.id}" is empty.`)
    if (e.weight !== undefined && !(Number.isFinite(e.weight) && e.weight > 0)) problems.push(`The weight of criterion "${c.id}" must be a number above 0.`)
    return { id: c.id, text: e.text, weight: e.weight ?? c.weight, critical: e.critical ?? c.critical }
  })
  const anchors: Anchor[] = []
  edit.anchors.forEach((a, i) => {
    const r = AnchorSchema.safeParse(a)
    if (!r.success) problems.push(`Example ${i + 1}: ${z.prettifyError(r.error).replace(/\n/g, ' ')}`)
    else if (r.data.criterion !== undefined && !ids.includes(r.data.criterion)) problems.push(`Example ${i + 1} is about "${r.data.criterion}", which is not a criterion of this rubric.`)
    else anchors.push(r.data)
  })
  if (problems.length > 0) throw invalid(problems.join('\n'))
  const context = edit.context === null || edit.context.trim() === '' ? undefined : edit.context

  const next: Rubric = { id: current.id, version: current.version, criteria, anchors, ...(context !== undefined ? { context } : {}) }
  const comparable: Rubric = { id: current.id, version: current.version, criteria: current.criteria, anchors: current.anchors, ...(current.context !== undefined ? { context: current.context } : {}) }
  if (deepEqual(next, comparable)) throw new ApiError(422, 'no_change', 'Nothing differs from the file, so nothing was saved.')

  // ---- the version

  const versionPair = pairOf(top, 'version')!
  const oldVersion = (versionPair.value as Scalar).value
  let newVersion: string | number
  if (edit.version !== undefined) {
    if (edit.version === current.version) throw invalid(`The new version must differ from the current one, "${current.version}".`)
    newVersion = edit.version
  } else if (typeof oldVersion === 'number' && Number.isInteger(oldVersion) && oldVersion >= 0) {
    newVersion = oldVersion + 1
  } else if (typeof oldVersion === 'string' && /^\d+$/.test(oldVersion)) {
    newVersion = String(Number(oldVersion) + 1)
  } else {
    throw invalid(`This rubric's version, "${current.version}", is not a whole number, so it cannot go up by one by itself. Send the new version in "version".`)
  }
  const expected: Rubric = { ...next, version: String(newVersion) }

  // ---- the splices

  const s = splicer(source)
  const edits: Splice[] = [s.replacePair(versionPair, newVersion)]

  const criteriaSeq = pairOf(top, 'criteria')!.value
  if (!isSeq(criteriaSeq) || criteriaSeq.flow) throw invalid('The criteria are not a block list ("- id: ..."), which the page cannot edit. Edit the file in your editor.')
  current.criteria.forEach((old, i) => {
    const item = criteriaSeq.items[i]
    if (!isMap(item) || item.flow) throw invalid(`Criterion "${old.id}" is not written as a block mapping, which the page cannot edit. Edit the file in your editor.`)
    const now = criteria[i]!
    const inserts: [string, unknown][] = []
    for (const key of ['text', 'weight', 'critical'] as const) {
      if (now[key] === old[key]) continue
      const pair = pairOf(item, key)
      if (pair) edits.push(s.replacePair(pair, now[key]))
      else inserts.push([key, now[key]])
    }
    if (inserts.length > 0) edits.push(s.appendPairs(item, inserts))
  })

  if (context !== current.context) {
    const pair = pairOf(top, 'context')
    if (context === undefined) edits.push(...s.deletePairs(top, [(top.items as Pair[]).indexOf(pair!)]))
    else if (pair) edits.push(s.replacePair(pair, context))
    else edits.push(s.insertAfter(versionPair, 'context', context))
  }

  if (!deepEqual(anchors, current.anchors)) edits.push(...anchorSplices(s, top, current.anchors, anchors))

  const text = s.apply(edits)

  // ---- the same validation the loader does, and nothing but the edit changed

  let reread: unknown
  try {
    reread = parse(text)
  } catch (e) {
    throw new ApiError(500, 'internal', `The edit would leave the file unreadable, so nothing was written: ${e instanceof Error ? e.message : String(e)}`)
  }
  const check = RubricSchema.safeParse(reread)
  if (!check.success) throw invalid(`The edited rubric does not validate, so nothing was written:\n${z.prettifyError(check.error)}`)
  if (!deepEqual(check.data, expected)) throw new ApiError(500, 'internal', 'The edit did not come out as intended when read back, so nothing was written.')

  return { text, rubric: check.data, textChanged: current.criteria.filter((c, i) => c.text !== criteria[i]!.text).map(c => c.id) }
}

// ------------------------------------------------------------------ anchors

/** An anchor with its keys in the file's usual order, and only the ones it has. */
function canonical(a: Anchor): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of ANCHOR_FIELDS) if (a[k] !== undefined) out[k] = a[k]
  return out
}

/** Pairs of indexes into `a` and `b` whose items are equal, in order (a longest common subsequence). */
function matches<T>(a: T[], b: T[]): [number, number][] {
  const n = a.length
  const m = b.length
  const len: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) len[i]![j] = deepEqual(a[i], b[j]) ? len[i + 1]![j + 1]! + 1 : Math.max(len[i + 1]![j]!, len[i]![j + 1]!)
  const out: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (deepEqual(a[i], b[j])) {
      out.push([i, j])
      i++
      j++
    } else if (len[i + 1]![j]! >= len[i]![j + 1]!) i++
    else j++
  }
  return out
}

/**
 * Splices that turn the old examples into the new ones. Unchanged examples keep
 * their text. Between two unchanged ones, removed and added examples are paired
 * in order and the pair is an edit of the old example in place, so an edited
 * example keeps its position, its block style and its comments.
 */
function anchorSplices(s: Splicer, top: YAMLMap, old: Anchor[], now: Anchor[]): Splice[] {
  const pair = pairOf(top, 'anchors')
  const seq = pair?.value
  if (!pair) return [s.appendToDocument('anchors', now.map(canonical))]
  if (!isSeq(seq) || seq.flow || seq.items.length === 0 || now.length === 0) return [s.replacePair(pair, now.map(canonical))]

  const out: Splice[] = []
  const items = seq.items as Node[]
  const done = [...matches(old, now), [old.length, now.length] as [number, number]]
  let prevOld = -1
  let prevNew = -1
  for (const [oi, ni] of done) {
    const goneOld = range(prevOld + 1, oi)
    const freshNew = range(prevNew + 1, ni)
    const paired = Math.min(goneOld.length, freshNew.length)
    for (let t = 0; t < paired; t++) {
      const node = items[goneOld[t]!]
      if (!isMap(node) || node.flow) throw invalid(`Example ${goneOld[t]! + 1} is not written as a block mapping, which the page cannot edit. Edit the file in your editor.`)
      out.push(...editAnchor(s, node, old[goneOld[t]!]!, now[freshNew[t]!]!))
    }
    for (const k of goneOld.slice(paired)) out.push(s.deleteItem(items[k]!))
    const added = freshNew.slice(paired)
    if (added.length > 0) {
      const after = paired > 0 ? goneOld[paired - 1]! : prevOld
      out.push(s.insertItems(seq, after, added.map(k => canonical(now[k]!))))
    }
    prevOld = oi
    prevNew = ni
  }
  return out
}

function editAnchor(s: Splicer, node: YAMLMap, old: Anchor, now: Anchor): Splice[] {
  const out: Splice[] = []
  const removed: number[] = []
  const inserts: [string, unknown][] = []
  for (const key of ANCHOR_FIELDS) {
    if (old[key] === now[key]) continue
    const pair = pairOf(node, key)
    if (now[key] === undefined) removed.push(node.items.indexOf(pair!))
    else if (pair) out.push(s.replacePair(pair, now[key]))
    else inserts.push([key, now[key]])
  }
  if (removed.length > 0) out.push(...s.deletePairs(node, removed))
  if (inserts.length > 0) out.push(s.appendPairs(node, inserts))
  return out
}

const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i)

function pairOf(map: YAMLMap, key: string): Pair | undefined {
  return (map.items as Pair[]).find(p => isScalar(p.key) && p.key.value === key)
}

// ---------------------------------------------------------------- splicing

type Splicer = ReturnType<typeof splicer>

/** Text operations on the original source, positioned by the parsed nodes' ranges. */
function splicer(text: string) {
  const lineStart = (pos: number) => text.lastIndexOf('\n', pos - 1) + 1
  const column = (pos: number) => pos - lineStart(pos)
  /** The position after the newline that ends the line `pos` is on (or the end of the text). `pos` just after a newline is already there. */
  const endOfLine = (pos: number) => {
    if (pos > 0 && text[pos - 1] === '\n') return pos
    const i = text.indexOf('\n', pos)
    return i < 0 ? text.length : i + 1
  }
  /** `end` moved back over blank lines, so they stay where they are. */
  const beforeBlankLines = (start: number, end: number) => {
    let e = end
    while (e > start) {
      const from = text.lastIndexOf('\n', e - 2) + 1
      if (from < start || text.slice(from, e).trim() !== '') break
      e = from
    }
    return e
  }
  const rangeOf = (n: unknown): [number, number, number] | undefined => (n as { range?: [number, number, number] } | null)?.range ?? undefined
  const keyStart = (p: Pair) => rangeOf(p.key)![0]
  const nodeEnd = (p: Pair) => rangeOf(p.value)?.[2] ?? rangeOf(p.key)![2]
  /** Where a new line can go after this node: after its last line, before any blank lines that follow it. */
  const after = (start: number, end: number) => beforeBlankLines(start, endOfLine(end))

  /**
   * A new value for a folded block (`>`) that keeps the file's own line breaks
   * wherever the words are unchanged and wraps only the lines in between, so an
   * edited sentence shows in the diff as the lines it touches. Null when the
   * block or the value is not a single plain paragraph, and the caller then
   * prints the whole block again.
   */
  function refold(v: [number, number, number], value: string): Splice | null {
    if (text.includes('\r')) return null
    const headerEnd = endOfLine(v[0])
    const chomp = /^>([-+]?)\s*(#.*)?$/.exec(text.slice(v[0], headerEnd).trim())?.[1]
    const clip = value.endsWith('\n')
    const body = clip ? value.slice(0, -1) : value
    if (chomp === undefined || chomp === '+' || (chomp === '') !== clip) return null
    if (body === '' || body.includes('\n') || body !== body.trim() || /\s{2,}|\t/.test(body)) return null
    const contentEnd = beforeBlankLines(headerEnd, v[1])
    const lines = text.slice(headerEnd, contentEnd).split('\n').slice(0, -1)
    if (lines.length === 0) return null
    const indent = /^ */.exec(lines[0]!)![0].length
    if (lines.some(l => l.trim() === '' || /^ */.exec(l)![0].length !== indent || /\t|\s{2,}/.test(l.trim()) || l !== l.trimEnd())) return null

    const words = body.split(' ')
    const lineWords = lines.map(l => l.trim().split(' '))
    const same = (ws: string[], at: number) => at >= 0 && ws.every((w, i) => words[at + i] === w)
    let head = 0
    let w = 0
    while (head < lines.length && same(lineWords[head]!, w) && w + lineWords[head]!.length <= words.length) w += lineWords[head++]!.length
    let tail = lines.length
    let end = words.length
    while (tail > head && end - lineWords[tail - 1]!.length >= w && same(lineWords[tail - 1]!, end - lineWords[tail - 1]!.length)) end -= lineWords[--tail]!.length

    const width = Math.max(20, 80 - indent)
    const wrapped: string[] = []
    for (const word of words.slice(w, end)) {
      const last = wrapped[wrapped.length - 1]
      if (last !== undefined && last.length + 1 + word.length <= width) wrapped[wrapped.length - 1] = `${last} ${word}`
      else wrapped.push(word)
    }
    const out = [...lines.slice(0, head), ...wrapped.map(l => ' '.repeat(indent) + l), ...lines.slice(tail)]
    return { start: headerEnd, end: contentEnd, text: out.join('\n') + '\n' }
  }

  return {
    /** Replaces a key's value, keeping the key where it is, the value's block style and a trailing comment. */
    replacePair(pair: Pair, value: unknown): Splice {
      const k = keyStart(pair)
      const v = rangeOf(pair.value)
      const kept = isScalar(pair.value) && pair.value.type === 'BLOCK_FOLDED' && typeof value === 'string' && v ? refold(v, value) : null
      if (kept) return kept
      const valueEnd = v ? v[1] : rangeOf(pair.key)![1]
      const style = isScalar(pair.value) ? pair.value.type : undefined
      const out = render({ [String((pair.key as Scalar).value)]: value }, column(k), style)
      const wasOneLine = !text.slice(k, valueEnd).includes('\n')
      if (wasOneLine && !out.includes('\n')) return { start: k, end: valueEnd, text: out }
      // A block replaces whole lines. A comment after a one-line value moves to the key's line, which YAML allows after a block header.
      const comment = wasOneLine ? /#.*/.exec(text.slice(valueEnd, nodeEnd(pair)))?.[0] : undefined
      const lines = out.split('\n')
      if (comment) lines[0] += ` ${comment}`
      return { start: k, end: after(k, nodeEnd(pair)), text: lines.join('\n') + '\n' }
    },

    /** Adds keys after the last key of a block mapping, at its indentation. */
    appendPairs(map: YAMLMap, pairs: [string, unknown][]): Splice {
      const items = map.items as Pair[]
      const at = column(keyStart(items[0]!))
      const pos = after(keyStart(items[0]!), nodeEnd(items[items.length - 1]!))
      const block = pairs.map(([key, value]) => ' '.repeat(at) + render({ [key]: value }, at)).join('\n') + '\n'
      return { start: pos, end: pos, text: (pos > 0 && text[pos - 1] !== '\n' ? '\n' : '') + block }
    },

    /** Adds a top-level key on the line after another one. */
    insertAfter(pair: Pair, key: string, value: unknown): Splice {
      const pos = endOfLine(nodeEnd(pair))
      return { start: pos, end: pos, text: (pos > 0 && text[pos - 1] !== '\n' ? '\n' : '') + render({ [key]: value }, 0) + '\n' }
    },

    /** Adds a top-level key at the end of the file. */
    appendToDocument(key: string, value: unknown): Splice {
      const pos = text.length
      return { start: pos, end: pos, text: (pos > 0 && !text.endsWith('\n') ? '\n' : '') + render({ [key]: value }, 0) + '\n' }
    },

    /**
     * Removes keys from a block mapping, whole lines at a time. Comments above a
     * removed key stay, for the person reviewing the diff to keep or delete. The
     * first key of a list item shares the line with the dash, so removing it
     * pulls the next remaining key up onto that line.
     */
    deletePairs(map: YAMLMap, indexes: number[]): Splice[] {
      const items = map.items as Pair[]
      const gone = new Set(indexes)
      const out: Splice[] = []
      let from = 0
      if (gone.has(0)) {
        const keep = items.findIndex((_, i) => !gone.has(i))
        if (keep < 0) throw new ApiError(500, 'internal', 'An edit tried to remove every key of a mapping.')
        out.push({ start: keyStart(items[0]!), end: keyStart(items[keep]!), text: '' })
        from = keep
      }
      for (const i of [...gone].filter(i => i > from)) {
        const start = lineStart(keyStart(items[i]!))
        out.push({ start, end: after(start, nodeEnd(items[i]!)), text: '' })
      }
      return out
    },

    /** Removes one item of a block list, whole lines. */
    deleteItem(item: Node): Splice {
      const r = rangeOf(item)!
      const start = lineStart(r[0])
      return { start, end: after(start, r[2]), text: '' }
    },

    /** Adds items to a block list after item `index` (-1: before the first), at the list's indentation. */
    insertItems(seq: YAMLSeq, index: number, values: unknown[]): Splice {
      const items = seq.items as Node[]
      const first = rangeOf(items[0])![0]
      const dash = text.lastIndexOf('-', first) - lineStart(first)
      const pos = index < 0 ? lineStart(first) : after(lineStart(rangeOf(items[index])![0]), rangeOf(items[index])![2])
      const block = renderRaw(values, dash)
        .split('\n')
        .map(l => (l === '' ? l : ' '.repeat(dash) + l))
        .join('\n') + '\n'
      return { start: pos, end: pos, text: (pos > 0 && text[pos - 1] !== '\n' ? '\n' : '') + block }
    },

    apply(splices: Splice[]): string {
      // Ascending by start; at one position a removal or replacement comes before an insertion, which is kept in the order it was made.
      const sorted = splices.map((sp, i) => ({ ...sp, i })).sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.i - b.i)
      // New text follows the file's line endings.
      const eol = (t: string) => (text.includes('\r\n') ? t.replace(/\r?\n/g, '\r\n') : t)
      let out = ''
      let at = 0
      for (const sp of sorted) {
        if (sp.start < at) throw new ApiError(500, 'internal', 'Two parts of the edit overlap in the file, so nothing was written.')
        out += text.slice(at, sp.start) + eol(sp.text)
        at = sp.end
      }
      return out + text.slice(at)
    },
  }
}

/**
 * Prints a value as YAML, the way it is written at column `at`: lines after the
 * first are indented by `at`, and no trailing newline. Long prose in a new
 * example becomes a folded block (`>`), as the example rubrics write it; an
 * existing value keeps its own style (`style`).
 */
function render(value: unknown, at: number, style?: Scalar.Type): string {
  return renderRaw(value, at, style)
    .split('\n')
    .map((l, i) => (i === 0 || l === '' ? l : ' '.repeat(at) + l))
    .join('\n')
}

/** `render` without the indentation: the text as it would be at column 0, wrapped for column `at`. */
function renderRaw(value: unknown, at: number, style?: Scalar.Type): string {
  const doc = new Document(value, { aliasDuplicateObjects: false })
  let folded = false
  const styleScalar = (node: unknown, own?: Scalar.Type) => {
    if (!isScalar(node) || typeof node.value !== 'string') return
    const v = node.value
    if (own === 'BLOCK_FOLDED' || own === 'BLOCK_LITERAL') node.type = own
    else if (v.includes('\n')) node.type = 'BLOCK_LITERAL'
    else if (own) node.type = own
    if (node.type === 'BLOCK_FOLDED') folded = true
  }
  const prose = (map: unknown) => {
    if (!isMap(map)) return
    for (const p of map.items as Pair[]) {
      const key = isScalar(p.key) ? p.key.value : undefined
      if ((key === 'input' || key === 'output' || key === 'critique') && isScalar(p.value) && typeof p.value.value === 'string' && !p.value.value.includes('\n') && p.value.value.length > 60) {
        styleScalar(p.value, 'BLOCK_FOLDED')
      } else styleScalar(p.value)
    }
  }
  const root = doc.contents
  if (isMap(root)) {
    for (const p of root.items as Pair[]) {
      if (isSeq(p.value)) for (const item of p.value.items) prose(item)
      else styleScalar(p.value, style)
    }
  } else if (isSeq(root)) for (const item of root.items) prose(item)
  // Folded text wraps to keep lines within 80 columns in the file. Anything else stays on one line, as a plain value in the file usually is.
  return doc.toString({ lineWidth: folded ? Math.max(40, 80 - at) : 0, minContentWidth: 20 }).replace(/\n$/, '')
}
