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
}

/**
 * A placeholder as it appears in text the model reads: a token (LABEL_n) and,
 * since 0.2, a per-session marker after a dot. The marker means text that only
 * looks like a placeholder (in code, in templates) is never taken for one.
 * Group 1 is the token, group 2 the marker (absent in the legacy form).
 */
const PLACEHOLDER = /<<([A-Z][A-Z0-9_]*_\d+)(?:\.([a-z0-9]{4}))?>>/g

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

  const names = (config.customers ?? [])
    .map(n => n.trim())
    .filter(n => n.length > 1)
    .sort((a, b) => b.length - a.length)
  if (names.length > 0) {
    const alternation = names.map(n => escapeRegex(n).replace(/\s+/g, '\\s+')).join('|')
    rules.push({
      label: 'CUSTOMER',
      regex: new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}\\p{N}])`, 'giu'),
      normalize: v => lower(v).replace(/\s+/g, ' '),
    })
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

/** The two-way table between real values and placeholders, for one session. */
export class Vault {
  private byKey = new Map<string, string>()
  private byToken = new Map<string, VaultEntry>()
  private counters = new Map<string, number>()
  /** This session's marker; '' is the legacy form without one. */
  readonly marker: string

  constructor(marker = '') {
    this.marker = marker
  }

  /** The text that stands for `token` in this session. */
  format(token: string): string {
    return this.marker ? `<<${token}.${this.marker}>>` : `<<${token}>>`
  }

  /** The real value behind a placeholder, only when it carries this session's marker. */
  resolve(token: string, marker: string | undefined): string | undefined {
    return (marker ?? '') === this.marker ? this.valueOf(token) : undefined
  }

  get size() {
    return this.byToken.size
  }

  tokenFor(label: string, value: string, normalize: (v: string) => string): string {
    const key = `${label}\u0000${normalize(value)}`
    const known = this.byKey.get(key)
    if (known !== undefined) return known

    const n = (this.counters.get(label) ?? 0) + 1
    this.counters.set(label, n)
    const token = `${label}_${n}`
    this.byKey.set(key, token)
    this.byToken.set(token, { token, value, label })
    return token
  }

  /**
   * Marks placeholders already in the conversation (a resumed transcript) as
   * taken, so new values never reuse a number that means something else there.
   */
  reserve(text: string): void {
    for (const m of text.matchAll(PLACEHOLDER)) {
      const token = m[1] ?? ''
      const cut = token.lastIndexOf('_')
      const label = token.slice(0, cut)
      const n = Number(token.slice(cut + 1))
      if (n > (this.counters.get(label) ?? 0)) this.counters.set(label, n)
    }
  }

  valueOf(token: string): string | undefined {
    return this.byToken.get(token)?.value
  }

  entries(): VaultEntry[] {
    return [...this.byToken.values()]
  }

  /** Restores entries saved earlier (e.g. before a hot reload); the rule's key is rebuilt. */
  load(entries: readonly VaultEntry[], rules: readonly Rule[]) {
    for (const entry of entries) {
      if (this.byToken.has(entry.token)) continue
      const rule = rules.find(r => r.label === entry.label)
      const normalize = rule?.normalize ?? exact
      this.byKey.set(`${entry.label}\u0000${normalize(entry.value)}`, entry.token)
      this.byToken.set(entry.token, entry)
      const n = Number(entry.token.slice(entry.label.length + 1))
      if (n > (this.counters.get(entry.label) ?? 0)) this.counters.set(entry.label, n)
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
      plain.replace(rule.regex, value => vault.format(vault.tokenFor(rule.label, value, rule.normalize))),
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
  if (i >= 0 && buf.length - i <= 72 && /^<<(?:[A-Z][A-Z0-9_]*(?:\.[a-z0-9]{0,4})?)?>?$/.test(buf.slice(i))) return i
  if (buf.endsWith('<')) return buf.length - 1
  return buf.length
}

/** The note added to the system prompt, with examples in this session's form. */
export function systemNote(vault: Vault): string {
  const a = vault.format('CUSTOMER_1')
  const b = vault.format('EMAIL_2')
  return (
    `Customer data in this conversation has been replaced with placeholders such as ${a} or ${b}. ` +
    'Use a placeholder exactly as written, including the part after the dot, wherever its real value belongs ' +
    '(prose, code, commands, file edits): it is restored automatically before any tool runs and before the user ' +
    'reads your reply. Never guess, reconstruct or invent the real values, and do not comment on the placeholders unless asked.'
  )
}
