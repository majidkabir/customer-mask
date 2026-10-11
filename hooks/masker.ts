// Pure masking logic: no `$`, so it is unit-testable on its own.

import type { VaultEntry } from '../types'

export type PatternConfig = { label: string; regex: string; flags?: string }

/**
 * A customer with optional extras: a hint (a short, non-identifying
 * description Claude may see instead of the name) and aliases (other text that
 * identifies the customer, such as brands, an address, a website or a company
 * registration number, masked as the same customer).
 */
export type CustomerEntry = { name: string; hint?: string; aliases?: string[] }

export type MaskConfig = {
  /** Names to mask, as strings or as { name, hint }. */
  customers?: Array<string | CustomerEntry>
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
 * Masks text Claude Code stored on its own: first every value the vault knows,
 * then, when `rules` are given, anything else they detect. The second step
 * matters for output the model only saw part of (a long result is cut to a
 * preview), whose unseen values the vault cannot know. New values found here
 * get placeholders like any other; the model never saw them.
 */
export function cleanText(text: string, vault: Vault, rules: readonly Rule[] = []): string {
  const known = hideKnownValues(text, vault)
  return rules.length > 0 ? mask(known, rules, vault, { hints: false }) : known
}

/**
 * Masks the copies Claude Code keeps in a session's transcript outside the
 * rows the mod already masked: the queue record of each typed prompt, the
 * structured record of each tool result (`toolUseResult`), and generated
 * titles or summaries. Paths are left alone so resume and edit tracking work.
 * Lines that need no change are kept byte for byte.
 */
export function cleanTranscript(
  text: string,
  vault: Vault,
  rules: readonly Rule[] = [],
): { text: string; changedLines: number } {
  let changedLines = 0
  const hide = (v: string) => cleanText(v, vault, rules)
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
    if (
      typeof e?.token !== 'string' ||
      typeof e.value !== 'string' ||
      typeof e.label !== 'string' ||
      (e.hint !== undefined && typeof e.hint !== 'string')
    ) {
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

export type Rule = {
  label: string
  /** Finds the values (rules built from a pattern). */
  regex?: RegExp
  /** Finds the values and replaces each with `onMatch`'s answer (rules built from a list). */
  scan?: (text: string, onMatch: (match: string) => string) => string
  normalize: (value: string) => string
  /** Gives back part of a match that is not the value (an ambiguous word after a name). */
  trim?: (match: string) => { value: string; rest: string }
  /** Hints by normalized value: shown once per customer, after its first placeholder. */
  hints?: ReadonlyMap<string, string>
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

/** A placeholder with the hint that may follow it (group 3); used when restoring, to drop a copied hint. */
const PLACEHOLDER_WITH_HINT = /<<([A-Z][A-Z0-9_]*_\d+(?:-\d+)?)(?:\.([a-z0-9]{4}))?>>(?: \[hint: ([^\]\n]{1,200})\])?/g

/** Makes a configured hint safe to put in brackets on one line. */
const cleanHint = (hint: string) => hint.replace(/[\]\[\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)

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

  const customers: Customer[] = (config.customers ?? [])
    .map(c => (typeof c === 'string' ? { name: c } : c))
    .map(c => ({
      name: String(c.name ?? '').trim(),
      hint: c.hint ? cleanHint(String(c.hint)) : '',
      aliases: (Array.isArray(c.aliases) ? c.aliases : [])
        .filter((a): a is string => typeof a === 'string')
        .map(a => a.trim())
        .filter(a => a.length > 1),
    }))
    .filter(c => c.name.length > 1)
  if (customers.length > 0) {
    const names = config.nameVariants === false ? [exactNameRule(customers)] : nameRules(customers)
    // Aliases first, so a longer alias that contains the name ("LEGO House") is taken whole.
    const aliases = aliasRule(customers, config.nameVariants !== false)
    rules.push(...(aliases ? [aliases] : []), ...names)
    // Names glued into a host name ("legogroup.com"), after the names themselves.
    if (config.nameVariants !== false) {
      const glued = gluedHostRule(customers)
      if (glued) rules.push(glued)
    }
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

type Customer = { name: string; hint: string; aliases: string[] }

/** The hints of a list of customers, keyed as `normalize` keys their values. */
function hintMap(customers: readonly Customer[], normalize: (v: string) => string): Map<string, string> {
  const hints = new Map<string, string>()
  for (const c of customers) if (c.hint) hints.set(normalize(c.name), c.hint)
  return hints
}

/** How a name matched as listed is keyed: any case, any run of whitespace. */
const exactKey = (v: string) => lower(v).replace(/\s+/g, ' ')
/** How a name matched with variants is keyed: no legal suffix, case or separators. */
const variantKey = (v: string) => lower(stripSuffix(v)).replace(/[\s\-._,]+/g, '')

/** Whether a customer's name is matched with variants (its core is long enough). */
const usesVariants = (c: Customer) => stripSuffix(c.name).trim().replace(/[^\p{L}\p{N}]/gu, '').length >= 3

/** Names as listed: any case, any run of whitespace between words. */
function exactNameRule(customers: readonly Customer[]): Rule {
  const normalize = exactKey
  return {
    label: 'CUSTOMER',
    scan: nameScanner(customers.map(c => c.name), false),
    normalize,
    hints: hintMap(customers, normalize),
  }
}

/** Names without their legal suffix, with name variants (see `nameScanner`). */
function variantNameRule(customers: readonly Customer[]): Rule {
  const normalize = variantKey
  return {
    label: 'CUSTOMER',
    scan: nameScanner(new Set(customers.map(c => stripSuffix(c.name).trim())), true),
    normalize,
    trim: trimAmbiguousSuffix,
    hints: hintMap(customers, normalize),
  }
}

/** Splits customers into cores matched with variants, and names too short for that, matched as listed. */
function nameRules(customers: readonly Customer[]): Rule[] {
  const cores: Customer[] = []
  const exact: Customer[] = []
  for (const c of customers) (usesVariants(c) ? cores : exact).push(c)
  return [...(cores.length ? [variantNameRule(cores)] : []), ...(exact.length ? [exactNameRule(exact)] : [])]
}

/** The key a customer's own name has in the vault, so aliases and glued names join the same customer. */
function customerKey(c: Customer, variants: boolean): string {
  return variants && usesVariants(c) ? variantKey(c.name) : exactKey(c.name)
}

/**
 * Aliases: other text that identifies a customer (brands, an address, a
 * website, a registration number), matched as listed (any case, any run of
 * whitespace, whole words) and masked as that customer, each alias as its own
 * spelling of it (CUSTOMER_1-2, ...).
 */
function aliasRule(customers: readonly Customer[], variants: boolean): Rule | undefined {
  const owner = new Map<string, string>()
  const hints = new Map<string, string>()
  for (const c of customers) {
    const key = customerKey(c, variants)
    for (const a of c.aliases) if (!owner.has(exactKey(a))) owner.set(exactKey(a), key)
    if (c.hint) hints.set(key, c.hint)
  }
  if (owner.size === 0) return undefined
  return {
    label: 'CUSTOMER',
    scan: nameScanner(
      [...owner.keys()],
      false,
    ),
    normalize: v => owner.get(exactKey(v)) ?? exactKey(v),
    hints,
  }
}

/** A host name: labels of letters, digits and hyphens joined by dots, ending in a top-level domain. */
const HOST = /(?<![\p{L}\p{N}.@-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?![\p{L}\p{N}-])/giu

/**
 * Customer names glued to another word inside a host name ("legogroup.com",
 * "shop-acmefreight.dk"): a label that starts or ends with a customer's name,
 * written without separators, is masked as that customer. Only names of 4 or
 * more letters and digits, so short names don't catch unrelated domains.
 * The whole label is replaced, so the host name is restored exactly.
 */
function gluedHostRule(customers: readonly Customer[]): Rule | undefined {
  const keys = new Set(customers.filter(usesVariants).map(c => variantKey(c.name)).filter(k => k.length >= 4))
  if (keys.size === 0) return undefined
  const hints = new Map(customers.filter(c => c.hint && usesVariants(c)).map(c => [variantKey(c.name), c.hint]))
  /** The customer key a label starts or ends with (the longest), if any. */
  const keyIn = (label: string): string | undefined => {
    const flat = label.toLowerCase().replace(/-/g, '')
    let found: string | undefined
    for (let n = 4; n <= flat.length; n++) {
      for (const part of [flat.slice(0, n), flat.slice(flat.length - n)]) {
        if (keys.has(part) && (found === undefined || part.length > found.length)) found = part
      }
    }
    return found
  }
  return {
    label: 'CUSTOMER',
    scan: (text, onMatch) =>
      text.replace(HOST, host =>
        host
          .split('.')
          .map((label, i, all) => (i < all.length - 1 && keyIn(label) !== undefined ? onMatch(label) : label))
          .join('.'),
      ),
    normalize: v => keyIn(v) ?? variantKey(v),
    hints,
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
  /** Customers whose hint has been shown, by base token. */
  private hintShown = new Set<string>()
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

  /** The hint stored with a token's customer (its first spelling's entry). */
  hintOf(token: string): string | undefined {
    return this.byToken.get(parseToken(token).base)?.hint
  }

  /** The hint to show after this placeholder: its customer's, the first time only. */
  takeHint(token: string): string | undefined {
    const base = parseToken(token).base
    const hint = this.byToken.get(base)?.hint
    if (!hint || this.hintShown.has(base)) return undefined
    this.hintShown.add(base)
    return hint
  }

  tokenFor(label: string, value: string, normalize: (v: string) => string, hint?: string): string {
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
    const isFirstSpelling = !token.includes('-')
    this.byToken.set(token, hint && isFirstSpelling ? { token, value, label, hint } : { token, value, label })
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
      // A loaded customer's hint is already in the conversation it came from.
      if (entry.hint) this.hintShown.add(t.base)
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

/**
 * Replaces customer data with placeholders. `hints: false` is for text the
 * model never reads (the session title): a customer's one-time hint is then
 * kept for the first text it does read.
 */
export function mask(text: string, rules: readonly Rule[], vault: Vault, options: { hints?: boolean } = {}): string {
  const withHints = options.hints !== false
  let result = text
  for (const rule of rules) {
    const onMatch = (match: string) => {
      const { value, rest } = rule.trim ? rule.trim(match) : { value: match, rest: '' }
      const token = vault.tokenFor(rule.label, value, rule.normalize, rule.hints?.get(rule.normalize(value)))
      const hint = withHints ? vault.takeHint(token) : undefined
      return vault.format(token) + (hint ? ` [hint: ${hint}]` : '') + rest
    }
    result = outsidePlaceholders(result, plain =>
      rule.scan ? rule.scan(plain, onMatch) : rule.regex ? plain.replace(rule.regex, onMatch) : plain,
    )
  }
  return result
}

/** Restores this session's placeholders. A hint copied after one is dropped, so it never reaches a file or a tool. */
export function unmask(text: string, vault: Vault): string {
  return text.replace(
    PLACEHOLDER_WITH_HINT,
    (whole, token: string, marker: string | undefined, hint: string | undefined) => {
      const value = vault.resolve(token, marker)
      if (value === undefined) return whole
      if (hint === undefined) return value
      return hint === vault.hintOf(token) ? value : `${value} [hint: ${hint}]`
    },
  )
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
    `A placeholder with a -2, -3 ... after its number, such as ${vault.format('CUSTOMER_1-2')}, is another form of the same value: ` +
    'for a customer, another spelling or another identifier of that customer (a brand, an address, a website). ' +
    'The first time a customer appears, its placeholder may be followed by [hint: ...], a short description the user gave ' +
    'for context; use it to understand the customer, but never write the hint into files, commands or messages. ' +
    'Use a placeholder exactly as written, including the part after the dot, wherever its real value belongs ' +
    '(prose, code, commands, file edits): it is restored automatically before any tool runs and before the user ' +
    'reads your reply. Never guess, reconstruct or invent the real values, and do not comment on the placeholders unless asked.'
  )
}
