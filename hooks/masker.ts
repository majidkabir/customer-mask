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
  regex: RegExp
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

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

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
    rules.push(config.nameVariants === false ? exactNameRule(names) : variantNameRule(names))
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

const WORD_BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}])'
const WORD_BOUNDARY_AFTER = '(?![\\p{L}\\p{N}])'
const byLengthDesc = (a: string, b: string) => b.length - a.length

/** Names as listed, any case, any run of whitespace between words. */
function exactNameRule(names: string[]): Rule {
  const alternation = [...names].sort(byLengthDesc).map(n => escapeRegex(n).replace(/\s+/g, '\\s+')).join('|')
  return {
    label: 'CUSTOMER',
    regex: new RegExp(`${WORD_BOUNDARY_BEFORE}(?:${alternation})${WORD_BOUNDARY_AFTER}`, 'giu'),
    normalize: v => lower(v).replace(/\s+/g, ' '),
  }
}

/**
 * Names without their legal suffix, any case, with any separator (or none)
 * between words, then optionally any legal suffix. A name whose core would be
 * shorter than three characters is matched as listed.
 */
function variantNameRule(names: string[]): Rule {
  const cores = new Set<string>()
  const exact = new Set<string>()
  for (const name of names) {
    const core = stripSuffix(name).trim()
    if (core.replace(NAME_SEPARATORS, '').length >= 3) cores.add(core)
    else exact.add(name)
  }
  const coreAlt = [...cores]
    .sort(byLengthDesc)
    .map(c => c.split(NAME_SEPARATORS).filter(Boolean).map(escapeRegex).join('[\\s\\-._]*'))
    .join('|')
  const exactAlt = [...exact].sort(byLengthDesc).map(n => escapeRegex(n).replace(/\s+/g, '\\s+')).join('|')
  const parts = [
    ...(coreAlt ? [`(?:${coreAlt})(?:[\\s,]+(?:${SUFFIX_ALT}))?`] : []),
    ...(exactAlt ? [`(?:${exactAlt})`] : []),
  ]
  return {
    label: 'CUSTOMER',
    regex: new RegExp(`${WORD_BOUNDARY_BEFORE}(?:${parts.join('|')})${WORD_BOUNDARY_AFTER}`, 'giu'),
    normalize: v => lower(stripSuffix(v)).replace(/[\s\-._,]+/g, ''),
    trim: trimAmbiguousSuffix,
  }
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
    result = outsidePlaceholders(result, plain =>
      plain.replace(rule.regex, match => {
        const { value, rest } = rule.trim ? rule.trim(match) : { value: match, rest: '' }
        return vault.format(vault.tokenFor(rule.label, value, rule.normalize)) + rest
      }),
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
