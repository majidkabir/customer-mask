// Pure masking logic: no `$`, so it is unit-testable on its own.

import type { VaultEntry } from '../types'

export type PatternConfig = { label: string; regex: string; flags?: string }

export type MaskConfig = {
  customers?: string[]
  patterns?: PatternConfig[]
  detectors?: { email?: boolean; phone?: boolean; iban?: boolean; cpr?: boolean }
  /**
   * Tools whose arguments keep their placeholders because they send them off
   * this machine. Names or patterns with `*`; replaces the default list.
   */
  maskedTools?: string[]
  /** Exceptions to `maskedTools`: tools that get real values even though they match it. */
  unmaskedTools?: string[]
  /** Images and PDFs: `drop` (default) removes them before they are sent; `allow` sends them unmasked. */
  media?: 'drop' | 'allow'
  /**
   * Customer names also match without or with another legal suffix (A/S, ApS,
   * GmbH, Ltd, ...) and with other separators (space, hyphen, dot, none).
   * Default true.
   */
  nameVariants?: boolean
}

/** Content block kinds that carry pixels or a document, which text masking cannot see into. */
export const MEDIA_BLOCKS = new Set(['image', 'document'])

/**
 * The oldest Claude Code this mod is tested on. On an older build a hook this
 * mod relies on might not exist; it would then never run, nothing would be
 * masked and nothing would stop the request, so older builds are blocked.
 */
export const MIN_CLAUDE_CODE = '2.1.296'

/** Compares dotted release numbers ("2.1.296"); anything after a '-' is ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('-')[0]?.split('.').map(Number) ?? []
  const pb = b.split('-')[0]?.split('.').map(Number) ?? []
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  return 0
}

/**
 * Replaces every value the vault knows with its placeholder, wherever it
 * appears as a whole word. Used on copies Claude Code writes without passing
 * them through the mod (see `cleanTranscript`).
 */
export function hideKnownValues(text: string, vault: Vault): string {
  const pairs = vault
    .entries()
    .filter(e => e.value.trim().length > 1)
    .sort((a, b) => b.value.length - a.value.length)
  if (pairs.length === 0) return text
  const byValue = new Map(pairs.map(e => [e.value, e.token]))
  const alternation = [...byValue.keys()].map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const regex = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}\\p{N}])`, 'gu')
  return outsidePlaceholders(text, plain =>
    plain.replace(regex, value => vault.format(byValue.get(value) ?? value)),
  )
}

/** Keys in a tool's structured record that name a file or folder rather than hold content. */
const PATH_KEY = /path|cwd|dir/i

/** The top-level text fields of transcript records Claude Code writes without the mod seeing them. */
const RAW_TEXT_FIELDS = ['aiTitle', 'lastPrompt', 'summary']

/**
 * Masks the copies Claude Code keeps in a session's transcript outside the
 * rows the mod already masked: the queue record of each typed prompt, the
 * structured record of each tool result (`toolUseResult`), and generated
 * titles or summaries. Paths are left alone so resume and edit tracking work.
 * Lines that need no change are kept byte for byte.
 */
export function cleanTranscript(text: string, vault: Vault): { text: string; changedLines: number } {
  let changedLines = 0
  const hide = (v: string) => hideKnownValues(v, vault)
  const hideDeep = (v: unknown, key = ''): unknown => {
    if (typeof v === 'string') return PATH_KEY.test(key) ? v : hide(v)
    if (Array.isArray(v)) return v.map(x => hideDeep(x, key))
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hideDeep(x, k)]))
    }
    return v
  }
  const lines = text.split('\n').map(line => {
    if (!line.trim()) return line
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      return line
    }
    const out: Record<string, unknown> = { ...record }
    if (record.type === 'queue-operation' && typeof record.content === 'string') out.content = hide(record.content)
    for (const field of RAW_TEXT_FIELDS) {
      if (typeof record[field] === 'string') out[field] = hide(record[field] as string)
    }
    if ('toolUseResult' in record) out.toolUseResult = hideDeep(record.toolUseResult)
    const next = JSON.stringify(out)
    if (next === JSON.stringify(record)) return line
    changedLines += 1
    return next
  })
  return { text: lines.join('\n'), changedLines }
}

/** The vault file beside a session's transcript: `<session-id>.customer-mask.json`. */
export function vaultFileFor(transcriptPath: string): string {
  return `${transcriptPath.replace(/\.jsonl$/, '')}.customer-mask.json`
}

/** What the vault file holds. */
export type VaultFile = { version: 1; marker: string; entries: VaultEntry[] }

/** Reads a vault file's text; throws when it is not one. */
export function parseVaultFile(text: string): VaultFile {
  const data = JSON.parse(text) as Partial<VaultFile>
  if (data.version !== 1 || typeof data.marker !== 'string' || !Array.isArray(data.entries)) {
    throw new Error('not a customer-mask vault file (version 1)')
  }
  for (const e of data.entries) {
    if (typeof e?.token !== 'string' || typeof e.value !== 'string' || typeof e.label !== 'string') {
      throw new Error('a vault entry is malformed')
    }
  }
  return data as VaultFile
}

export const UNCHECKED_NOTE =
  '[customer-mask could not check this content for customer data in time, so it was removed before it was ' +
  'stored or sent. Ask the user for a smaller excerpt.]'

export const MEDIA_NOTE =
  '[customer-mask removed an image or PDF here: media cannot be checked for customer data, so it is not sent. ' +
  'Ask the user to describe it, or to extract its text into a file.]'

/**
 * By default every tool that can send its arguments to a server keeps
 * placeholders: the web tools and every MCP tool. Local MCP tools that need
 * real values are listed in `unmaskedTools`.
 */
export const DEFAULT_MASKED_TOOLS = ['WebSearch', 'WebFetch', 'mcp__*']

const globToRegex = (glob: string) =>
  new RegExp(`^${glob.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)

/** Decides, per tool name, whether its arguments keep their placeholders. */
export function toolPolicy(masked: readonly string[], unmasked: readonly string[]): (tool: string) => boolean {
  const keep = masked.map(globToRegex)
  const allow = unmasked.map(globToRegex)
  return tool => keep.some(r => r.test(tool)) && !allow.some(r => r.test(tool))
}

type Rule = {
  label: string
  /** Finds the values (rules built from a pattern). */
  regex?: RegExp
  /** Finds the values and replaces each with `onMatch`'s answer (rules built from a list). */
  scan?: (text: string, onMatch: (match: string) => string) => string
  normalize: (value: string) => string
  /** Gives back part of a match that is not the value (an ambiguous word after a name). */
  trim?: (match: string) => { value: string; rest: string }
}

/**
 * Legal-form suffixes a company name may carry, longest first. The two-letter
 * ones double as ordinary words ("as", "co"), so they only count in the exact
 * case written here; the rest match in any case.
 */
const LEGAL_SUFFIXES = [
  'Sp. z o.o.', 'Pty Ltd', 'S.p.A.', 'S.r.l.', 'Limited', 'Corporation', 'GmbH & Co. KG',
  'GmbH', 'A/S', 'ApS', 'I/S', 'K/S', 'P/S', 'IVS', 'ASA', 'Oyj', 'LLC', 'PLC', 'Inc.', 'Inc',
  'Ltd.', 'Ltd', 'Corp.', 'Corp', 'S.A.', 'SAS', 'SpA', 'Srl', 'B.V.', 'N.V.', 'A.S.', 'Co.',
  'AS', 'AB', 'SA', 'AG', 'SE', 'NV', 'BV', 'KG', 'Oy', 'Co',
]
const STRICT_CASE_SUFFIXES = new Set(['AS', 'AB', 'SA', 'AG', 'SE', 'NV', 'BV', 'KG', 'Oy', 'Co', 'Co.'])
const SUFFIX_ALT = LEGAL_SUFFIXES.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s*')).join('|')
const SUFFIX_AT_END = new RegExp(`^(.*?)([\\s,]+(${SUFFIX_ALT}))$`, 'isu')
const NAME_SEPARATORS = /[\s\-._]+/

/** A company name without its legal-form suffix. */
function stripSuffix(name: string): string {
  return SUFFIX_AT_END.exec(name)?.[1] ?? name
}

/** Splits off a two-letter suffix written in the wrong case: "Acme as well" keeps " as". */
function trimAmbiguousSuffix(match: string): { value: string; rest: string } {
  const m = SUFFIX_AT_END.exec(match)
  if (!m) return { value: match, rest: '' }
  const written = m[3] ?? ''
  const canonical = LEGAL_SUFFIXES.find(s => s.toLowerCase() === written.toLowerCase().replace(/\s+/g, ' '))
  if (canonical && STRICT_CASE_SUFFIXES.has(canonical) && written !== canonical) {
    return { value: m[1] ?? match, rest: m[2] ?? '' }
  }
  return { value: match, rest: '' }
}

/**
 * A placeholder as it appears in text the model reads: a token (LABEL_n) and,
 * since 0.2, a per-session marker after a dot. The marker means text that only
 * looks like a placeholder (in code, in templates) is never taken for one.
 * A token is LABEL_n for the first spelling of a value and LABEL_n-k for
 * other spellings of the same value (another case, suffix or separator), so
 * every spelling is restored exactly as it was written.
 * Group 1 is the token, group 2 the marker (absent in the legacy form).
 */
const PLACEHOLDER = /<<([A-Z][A-Z0-9_]*_\d+(?:-\d+)?)(?:\.([a-z0-9]{4}))?>>/g

/** A new per-session marker: four random lowercase letters or digits. */
export function newMarker(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(4))
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('')
}

const exact = (v: string) => v
const lower = (v: string) => v.toLowerCase()
const compact = (v: string) => v.replace(/[\s.-]/g, '').toUpperCase()


const toLabel = (s: string) =>
  s.toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^[^A-Z]+/, '') || 'DATA'

const withGlobal = (flags = '') => (flags.includes('g') ? flags : flags + 'g')

/** Builds the ordered rule list. Earlier rules win, so whole emails go first. */
export function buildRules(config: MaskConfig): Rule[] {
  const d = { email: true, phone: true, iban: true, cpr: true, ...config.detectors }
  const rules: Rule[] = []

  if (d.email) {
    rules.push({
      label: 'EMAIL',
      regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
      normalize: lower,
    })
  }
  if (d.iban) {
    rules.push({
      label: 'IBAN',
      regex: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g,
      normalize: compact,
    })
  }
  if (d.cpr) {
    // Danish CPR number, hyphenated only (a bare 10-digit run is too often a timestamp).
    rules.push({
      label: 'CPR',
      regex: /\b(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])\d{2}-\d{4}\b/g,
      normalize: exact,
    })
  }

  for (const p of config.patterns ?? []) {
    rules.push({
      label: toLabel(p.label),
      regex: new RegExp(p.regex, withGlobal(p.flags)),
      normalize: exact,
    })
  }

  const names = (config.customers ?? []).map(n => n.trim()).filter(n => n.length > 1)
  if (names.length > 0) {
    rules.push(...(config.nameVariants === false ? [exactNameRule(names)] : nameRules(names)))
  }

  if (d.phone) {
    rules.push({
      label: 'PHONE',
      // International (+45 12 34 56 78) or Danish grouped (12 34 56 78).
      regex: /(?<![\w+])\+\d{1,3}(?:[ .-]?\d){6,12}(?!\d)|\b\d{2} \d{2} \d{2} \d{2}\b/g,
      normalize: compact,
    })
  }

  return rules
}

/** A node of the customer-name trie: lower-cased characters to the next node. */
type TrieNode = { next: Map<string, TrieNode>; end: boolean; sepOK: boolean }

const newNode = (): TrieNode => ({ next: new Map(), end: false, sepOK: false })

const WORD_CHAR = /[\p{L}\p{N}]/u
const isWordChar = (c: string | undefined): boolean =>
  c !== undefined && (c < '\u0080' ? /[A-Za-z0-9]/.test(c) : WORD_CHAR.test(c))
const isVariantSep = (c: string) => c === ' ' || c === '-' || c === '.' || c === '_' || /\s/.test(c)
const isSpace = (c: string) => /\s/.test(c)

function child(node: TrieNode, ch: string): TrieNode {
  let n = node.next.get(ch)
  if (!n) node.next.set(ch, (n = newNode()))
  return n
}

/** Steps through `lowered` (usually one character) from `node`; undefined when the trie has no such path. */
function step(node: TrieNode, lowered: string): TrieNode | undefined {
  let n: TrieNode | undefined = node
  for (const ch of lowered) {
    n = n.next.get(ch)
    if (!n) return undefined
  }
  return n
}

/**
 * Finds listed names in one pass over the text, whatever the size of the list:
 * at each word start it walks a trie of the names, keeps the longest name that
 * ends on a word boundary, and moves past it.
 *
 * `variant` names: any case, separators (space, hyphen, dot, underscore, or
 * none) between words, then optionally a legal suffix. Otherwise names match
 * as listed, in any case, with any run of whitespace between words.
 */
function nameScanner(names: Iterable<string>, variant: boolean): (text: string, onMatch: (m: string) => string) => string {
  const root = newNode()
  for (const name of names) {
    let node = root
    if (variant) {
      const words = name.split(NAME_SEPARATORS).filter(Boolean)
      words.forEach((word, wi) => {
        for (const ch of word.toLowerCase()) node = child(node, ch)
        if (wi < words.length - 1) node.sepOK = true
      })
    } else {
      for (const ch of name.toLowerCase().replace(/\s+/g, ' ')) node = child(node, ch)
    }
    node.end = true
  }
  const suffix = new RegExp(`[\\s,]+(?:${SUFFIX_ALT})(?![\\p{L}\\p{N}])`, 'iuy')

  /** End of the longest name starting at `i`, or -1. */
  const longestAt = (text: string, i: number): number => {
    let node = root
    let j = i
    let last = -1
    let inSpace = false
    while (j < text.length) {
      const c = text[j] as string
      if (!variant && isSpace(c)) {
        if (inSpace) { j++; continue }
        const n = node.next.get(' ')
        if (!n) break
        node = n
        inSpace = true
        j++
        continue
      }
      inSpace = false
      const n = step(node, c.toLowerCase())
      if (n) {
        node = n
        j++
        if (node.end && !isWordChar(text[j])) last = j
        continue
      }
      if (variant && node.sepOK && isVariantSep(c)) { j++; continue }
      break
    }
    if (last >= 0 && variant) {
      suffix.lastIndex = last
      if (suffix.test(text)) last = suffix.lastIndex
    }
    return last
  }

  return (text, onMatch) => {
    let out = ''
    let copied = 0
    let i = 0
    while (i < text.length) {
      const c = text[i] as string
      if (!isWordChar(text[i - 1]) && step(root, c.toLowerCase())) {
        const end = longestAt(text, i)
        if (end > i) {
          out += text.slice(copied, i) + onMatch(text.slice(i, end))
          copied = i = end
          continue
        }
      }
      i++
    }
    return copied === 0 ? text : out + text.slice(copied)
  }
}

/** Names as listed: any case, any run of whitespace between words. */
function exactNameRule(names: Iterable<string>): Rule {
  return {
    label: 'CUSTOMER',
    scan: nameScanner(names, false),
    normalize: v => lower(v).replace(/\s+/g, ' '),
  }
}

/** Names without their legal suffix, with name variants (see `nameScanner`). */
function variantNameRule(cores: Iterable<string>): Rule {
  return {
    label: 'CUSTOMER',
    scan: nameScanner(cores, true),
    normalize: v => lower(stripSuffix(v)).replace(/[\s\-._,]+/g, ''),
    trim: trimAmbiguousSuffix,
  }
}

/** Splits names into cores matched with variants, and names too short for that, matched as listed. */
function nameRules(names: string[]): Rule[] {
  const cores = new Set<string>()
  const exact = new Set<string>()
  for (const name of names) {
    const core = stripSuffix(name).trim()
    if (core.replace(/[^\p{L}\p{N}]/gu, '').length >= 3) cores.add(core)
    else exact.add(name)
  }
  return [...(cores.size ? [variantNameRule(cores)] : []), ...(exact.size ? [exactNameRule(exact)] : [])]
}

/** LABEL_n-k → { base: LABEL_n, label, n, k }; k is 1 for the first spelling. */
function parseToken(token: string): { base: string; label: string; n: number; k: number } {
  const m = /^(([A-Z][A-Z0-9_]*)_(\d+))(?:-(\d+))?$/.exec(token)
  if (!m) return { base: token, label: token, n: 0, k: 1 }
  return { base: m[1] ?? token, label: m[2] ?? token, n: Number(m[3]), k: m[4] ? Number(m[4]) : 1 }
}

/**
 * The two-way table between real values and placeholders, for one session.
 *
 * A value is an entity (what `normalize` maps it to) written in one exact
 * spelling. Each entity gets a number; each spelling of it gets its own token,
 * so restoring gives back exactly what was written (which Claude's Edit tool
 * needs to find the text again).
 */
export class Vault {
  private byForm = new Map<string, string>()
  private byEntity = new Map<string, string>()
  private byToken = new Map<string, VaultEntry>()
  private counters = new Map<string, number>()
  private variants = new Map<string, number>()
  /** This session's marker; '' is the legacy form without one. */
  readonly marker: string

  constructor(marker = '') {
    this.marker = marker
  }

  get size() {
    return this.byToken.size
  }

  /** The text that stands for `token` in this session. */
  format(token: string): string {
    return this.marker ? `<<${token}.${this.marker}>>` : `<<${token}>>`
  }

  /** The real value behind a placeholder, only when it carries this session's marker. */
  resolve(token: string, marker: string | undefined): string | undefined {
    return (marker ?? '') === this.marker ? this.valueOf(token) : undefined
  }

  tokenFor(label: string, value: string, normalize: (v: string) => string): string {
    const formKey = `${label}\u0000${value}`
    const known = this.byForm.get(formKey)
    if (known !== undefined) return known

    const entityKey = `${label}\u0000${normalize(value)}`
    let token = this.byEntity.get(entityKey)
    if (token === undefined) {
      const n = (this.counters.get(label) ?? 0) + 1
      this.counters.set(label, n)
      token = `${label}_${n}`
      this.byEntity.set(entityKey, token)
    } else {
      const k = (this.variants.get(token) ?? 1) + 1
      this.variants.set(token, k)
      token = `${token}-${k}`
    }
    this.byForm.set(formKey, token)
    this.byToken.set(token, { token, value, label })
    return token
  }

  /**
   * Marks placeholders already in the conversation (a resumed transcript) as
   * taken, so new values never reuse a number that means something else there.
   */
  reserve(text: string): void {
    for (const m of text.matchAll(PLACEHOLDER)) this.bump(parseToken(m[1] ?? ''))
  }

  private bump(t: { base: string; label: string; n: number; k: number }): void {
    if (t.n > (this.counters.get(t.label) ?? 0)) this.counters.set(t.label, t.n)
    if (t.k > (this.variants.get(t.base) ?? 1)) this.variants.set(t.base, t.k)
  }

  valueOf(token: string): string | undefined {
    return this.byToken.get(token)?.value
  }

  entries(): VaultEntry[] {
    return [...this.byToken.values()]
  }

  /** Restores entries saved earlier (e.g. before a hot reload); the keys are rebuilt. */
  load(entries: readonly VaultEntry[], rules: readonly Rule[]) {
    for (const entry of entries) {
      if (this.byToken.has(entry.token)) continue
      const t = parseToken(entry.token)
      const normalize = rules.find(r => r.label === entry.label)?.normalize ?? exact
      this.byForm.set(`${entry.label}\u0000${entry.value}`, entry.token)
      const entityKey = `${entry.label}\u0000${normalize(entry.value)}`
      if (!this.byEntity.has(entityKey)) this.byEntity.set(entityKey, t.base)
      this.byToken.set(entry.token, entry)
      this.bump(t)
    }
  }
}

/** Applies `fn` to the parts of `text` that are not already placeholders. */
function outsidePlaceholders(text: string, fn: (plain: string) => string): string {
  let out = ''
  let last = 0
  for (const m of text.matchAll(PLACEHOLDER)) {
    out += fn(text.slice(last, m.index)) + m[0]
    last = m.index + m[0].length
  }
  return out + fn(text.slice(last))
}

export function mask(text: string, rules: readonly Rule[], vault: Vault): string {
  let result = text
  for (const rule of rules) {
    const onMatch = (match: string) => {
      const { value, rest } = rule.trim ? rule.trim(match) : { value: match, rest: '' }
      return vault.format(vault.tokenFor(rule.label, value, rule.normalize)) + rest
    }
    result = outsidePlaceholders(result, plain =>
      rule.scan ? rule.scan(plain, onMatch) : rule.regex ? plain.replace(rule.regex, onMatch) : plain,
    )
  }
  return result
}

export function unmask(text: string, vault: Vault): string {
  return text.replace(PLACEHOLDER, (whole, token: string, marker: string | undefined) => vault.resolve(token, marker) ?? whole)
}

/** Unmasks every string inside a JSON-like value, leaving the listed top-level keys alone. */
export function unmaskDeep<T>(value: T, vault: Vault, skipKeys: ReadonlySet<string> = new Set()): T {
  const walk = (v: unknown, top: boolean): unknown => {
    if (typeof v === 'string') return unmask(v, vault)
    if (Array.isArray(v)) return v.map(x => walk(x, false))
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v)) out[k] = top && skipKeys.has(k) ? x : walk(x, false)
      return out
    }
    return v
  }
  return walk(value, true) as T
}

/**
 * Unmasks a text stream whose pieces may split a placeholder ("<<CUST" + "OMER_1>>"):
 * holds back a tail that could still become a placeholder until it completes.
 */
export class StreamUnmasker {
  private pending = ''
  private readonly vault: Vault

  constructor(vault: Vault) {
    this.vault = vault
  }

  push(piece: string): string {
    this.pending += piece
    const hold = holdFrom(this.pending)
    const ready = this.pending.slice(0, hold)
    this.pending = this.pending.slice(hold)
    return unmask(ready, this.vault)
  }

  flush(): string {
    const rest = this.pending
    this.pending = ''
    return unmask(rest, this.vault)
  }
}

function holdFrom(buf: string): number {
  const i = buf.lastIndexOf('<<')
  if (i >= 0 && buf.length - i <= 80 && /^<<(?:[A-Z][A-Z0-9_]*(?:-\d*)?(?:\.[a-z0-9]{0,4})?)?>?$/.test(buf.slice(i))) return i
  if (buf.endsWith('<')) return buf.length - 1
  return buf.length
}

/** The note added to the system prompt, with examples in this session's form. */
export function systemNote(vault: Vault): string {
  const a = vault.format('CUSTOMER_1')
  const b = vault.format('EMAIL_2')
  return (
    `Customer data in this conversation has been replaced with placeholders such as ${a} or ${b}. ` +
    `A placeholder with a -2, -3 ... after its number, such as ${vault.format('CUSTOMER_1-2')}, is another spelling of the same value. ` +
    'Use a placeholder exactly as written, including the part after the dot, wherever its real value belongs ' +
    '(prose, code, commands, file edits): it is restored automatically before any tool runs and before the user ' +
    'reads your reply. Never guess, reconstruct or invent the real values, and do not comment on the placeholders unless asked.'
  )
}
