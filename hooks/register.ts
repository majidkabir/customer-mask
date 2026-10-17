import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnStepChunk } from 'claude-code'

import type { VaultEntry } from '../types'
import {
  buildRules,
  cleanText,
  cleanTranscript,
  DEFAULT_MASKED_TOOLS,
  mask,
  StreamUnmasker,
  compareVersions,
  MEDIA_BLOCKS,
  MIN_CLAUDE_CODE,
  parseVaultFile,
  vaultFileFor,
  type VaultFile,
  MEDIA_NOTE,
  UNCHECKED_NOTE,
  newMarker,
  systemNote,
  toolPolicy,
  unmaskDeep,
  Vault,
  type MaskConfig,
  detectionMode,
  nerFinds,
  nerRules,
  nerSettings,
  NER_DEFAULTS,
  type Detection,
  type NerEntity,
  type NerFind,
  type NerSettings,
  type Rule,
} from './masker'

/*
 * Where data flows and what this mod does there:
 *
 *   person / tools / files ──► session.append ──► stored row + next model request
 *                               (mask)              (placeholders only)
 *   model stream ──► turn.step ──► screen        (unmask text as it streams)
 *   model tool call ──► tool.call ──► tool runs  (unmask arguments)
 *   system prompt / CLAUDE.md / injected text ──► prompt.compose,
 *                               prompt.context, prompt.attachment (mask)
 *
 * The screen shows a row as it was before session.append rewrote it, so the
 * person keeps seeing real values; the model and the transcript file only
 * ever see placeholders.
 */

const NAME = 'customer-mask'
const CONFIG_FILE = '.claude/customer-mask.json'
const TOOL_ENVELOPE = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta'])

const vaultAtom = atom({ plugin: 'customer-mask', key: 'vault' } as const, [] as VaultEntry[])
const markerAtom = atom({ plugin: 'customer-mask', key: 'marker' } as const, null as string | null)

// Module state: rebuilt on every (re)load; the vault itself is restored from $.state.
let vault = new Vault()
let rules = buildRules({})
let configSummary = 'not loaded'
let maskedList: readonly string[] = DEFAULT_MASKED_TOOLS
let unmaskedList: readonly string[] = []
let keepsPlaceholders = toolPolicy(DEFAULT_MASKED_TOOLS, [])
let dropMedia = true
let mediaDropped = 0
let rowsRemoved = 0
/** How names are found, and the NER server's settings (used unless detection is "list"). */
let detection: Detection = 'list'
let ner: NerSettings = NER_DEFAULTS
/** NER answers by text, so text sent again (the system prompt, every request) is not sent to the model again. */
const nerCache = new Map<string, NerFind[]>()
const NER_CACHE_SIZE = 500
const nerStats = { calls: 0, ms: 0, failures: 0 }
/** Rows whose text the user typed: the ones NER checks with scope "prompts". */
const PROMPT_DOORS = new Set(['prompt', 'queue'])
/** The vault file beside this session's transcript, once the session's transcript is known. */
let sessionFile: string | undefined
/** This session's transcript, once known. */
let transcriptPath: string | undefined
/** Set when masking failed: from then on no request leaves this session. */
const blocks = new Map<'load' | 'version' | 'config' | 'vault' | 'ner', string>()
/** Why this session is blocked, if it is: the first reason recorded. */
const blocked = (): string | undefined => blocks.values().next().value
let loading: Promise<void> | undefined

/** Loads config and vault once; never rejects. A failure blocks the session instead. */
function ready($: EngineInterface): Promise<void> {
  loading ??= load($).catch(err => {
    blocks.set('load', `loading the customer-mask config failed (${String(err)}).`)
  })
  return loading
}

async function load($: EngineInterface): Promise<void> {
  const { version } = await $.session.version()
  if (compareVersions(version, MIN_CLAUDE_CODE) < 0) {
    blocks.set('version', `Claude Code ${version} is older than ${MIN_CLAUDE_CODE}, the oldest version customer-mask is tested on. Run \`claude update\`.`)
  }

  try {
    applyConfig(await readConfig($))
    await checkNer($)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    blocks.set('config', `${reason} Fix it, then run /customer-mask reload.`)
  }

  // The marker is chosen once per session and kept in $.state, so a hot
  // reload keeps the same placeholders. A session whose vault predates
  // markers keeps the legacy form, so its placeholders still resolve.
  const entries = await read($, vaultAtom)
  const saved = await read($, markerAtom)
  const marker = saved ?? (entries.length > 0 ? '' : newMarker())
  if (saved === null) await update($, markerAtom, () => marker)
  vault = new Vault(marker)
  vault.load(entries, rules)
  await reserveFromTranscript($)

}

/** A config read from the files, ready to apply. */
type LoadedConfig = {
  rules: ReturnType<typeof buildRules>
  maskedList: readonly string[]
  unmaskedList: readonly string[]
  dropMedia: boolean
  detection: Detection
  ner: NerSettings
  summary: string
}

/**
 * Reads and merges the config files (CUSTOMER_MASK_CONFIG, then the user's,
 * then the project's). Throws with a readable reason when a file is not valid
 * JSON, a pattern does not compile, or an option has a wrong value.
 */
async function readConfig($: EngineInterface): Promise<LoadedConfig> {
  const customers: NonNullable<MaskConfig['customers']> = []
  const patterns: NonNullable<MaskConfig['patterns']> = []
  let detectors: MaskConfig['detectors'] = {}
  let toolList: string[] | undefined
  let media: MaskConfig['media']
  let nameVariants: boolean | undefined
  let detectionSetting: unknown
  let nerConfig: MaskConfig['ner'] = {}
  const exceptions: string[] = []
  const sources: string[] = []

  const candidates: string[] = []
  const explicit = await $.env.get('CUSTOMER_MASK_CONFIG')
  if (explicit) candidates.push(explicit)
  // HOME on macOS and Linux; USERPROFILE on Windows, where HOME is usually unset.
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  if (home) candidates.push(`${home}/${CONFIG_FILE}`)
  candidates.push(`${await $.session.cwd()}/${CONFIG_FILE}`)

  for (const path of new Set(candidates)) {
    let text: string
    try {
      text = await $.fs.read(path)
    } catch {
      continue // no file there
    }
    try {
      const part = JSON.parse(text) as MaskConfig
      customers.push(...(part.customers ?? []))
      patterns.push(...(part.patterns ?? []))
      detectors = { ...detectors, ...part.detectors }
      if (part.maskedTools) toolList = part.maskedTools
      exceptions.push(...(part.unmaskedTools ?? []))
      if (part.media) media = part.media
      if (part.nameVariants !== undefined) nameVariants = part.nameVariants
      if (part.detection !== undefined) detectionSetting = part.detection
      if (part.ner) nerConfig = { ...nerConfig, ...part.ner }
      sources.push(path)
    } catch (err) {
      throw new Error(`${path} is not valid JSON (${String(err)}).`)
    }
  }

  const mode = detectionMode(detectionSetting)
  const nerUsed = nerSettings(nerConfig)
  let built: ReturnType<typeof buildRules>
  try {
    built = buildRules({ customers, patterns, detectors, nameVariants, detection: mode })
  } catch (err) {
    throw new Error(`a pattern in the customer-mask config does not compile (${String(err)}).`)
  }
  if (media !== undefined && media !== 'drop' && media !== 'allow') {
    throw new Error(`media must be "drop" or "allow", not ${JSON.stringify(media)}.`)
  }
  const masked = toolList ?? DEFAULT_MASKED_TOOLS
  const isDropping = media !== 'allow'
  const nerText =
    `NER at ${nerUsed.url} (${Object.entries(nerUsed.labels).map(([k, v]) => `${k}→${v}`).join(', ')}; ` +
    `${nerUsed.scope === 'all' ? 'all text' : 'typed prompts only'})`
  return {
    rules: built,
    maskedList: masked,
    unmaskedList: exceptions,
    dropMedia: isDropping,
    detection: mode,
    ner: nerUsed,
    summary:
      `names found by: ${mode === 'list' ? 'the list' : mode === 'ner' ? `${nerText}; the list is not used` : `the list and ${nerText}`}, ` +
      `${customers.length} customer name(s) (${customers.filter(c => typeof c !== 'string' && c.hint).length} with a hint), ` +
      `${patterns.length} custom pattern(s), ` +
      `tools kept masked: ${masked.join(', ') || 'none'}` +
      (exceptions.length ? ` except ${exceptions.join(', ')}` : '') +
      `, images/PDFs: ${isDropping ? 'dropped' : 'sent unmasked'}` +
      (sources.length ? ` from ${sources.join(', ')}` : ' (no config file found; built-in detectors only)'),
  }
}

function applyConfig(c: LoadedConfig): void {
  rules = c.rules
  maskedList = c.maskedList
  unmaskedList = c.unmaskedList
  keepsPlaceholders = toolPolicy(maskedList, unmaskedList)
  dropMedia = c.dropMedia
  detection = c.detection
  ner = c.ner
  nerCache.clear()
  configSummary = c.summary
}

/** Waits for `p` at most `ms` milliseconds; rejects after that. */
async function withTimeout<T>($: EngineInterface, p: Promise<T>, ms: number): Promise<T> {
  let timer: { cancel: () => void } | undefined
  const late = new Promise<never>((_, reject) => {
    timer = $.clock.after(ms, () => reject(new Error(`no answer within ${ms} ms`)))
  })
  try {
    return await Promise.race([p, late])
  } finally {
    timer?.cancel()
  }
}

/**
 * Checks that the NER server answers, when detection uses it. A server that
 * does not answer blocks the session: names would otherwise go unmasked.
 */
async function checkNer($: EngineInterface): Promise<void> {
  if (detection === 'list') {
    blocks.delete('ner')
    return
  }
  try {
    const res = await withTimeout($, $.http.fetch(`${ner.url}/health`), ner.timeoutMs)
    if (!res.ok) throw new Error(`it answered HTTP ${res.status}`)
    blocks.delete('ner')
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    blocks.set(
      'ner',
      `the NER server at ${ner.url} does not answer (${reason}). Start it (see tools/ner-server), then run /customer-mask reload.`,
    )
  }
}

/**
 * Asks the NER server what it finds in `texts` (one request for all of them;
 * text it already answered for comes from the cache). Rejects when the server
 * fails or takes longer than `ner.timeoutMs`; the hook's fail-closed catch
 * then removes the content.
 */
async function nerFind($: EngineInterface, texts: readonly string[]): Promise<NerFind[]> {
  const todo = [...new Set(texts)].filter(t => t.trim() !== '' && !nerCache.has(t))
  if (todo.length > 0) {
    const started = Date.now()
    nerStats.calls += 1
    try {
      const res = await withTimeout(
        $,
        $.http.fetch(`${ner.url}/detect`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ texts: todo, labels: Object.keys(ner.labels), threshold: ner.threshold }),
        }),
        ner.timeoutMs,
      )
      if (!res.ok) throw new Error(`the NER server answered HTTP ${res.status}`)
      const data = JSON.parse(res.text) as { results?: unknown }
      const results = data.results
      if (!Array.isArray(results) || results.length !== todo.length || !results.every(Array.isArray)) {
        throw new Error('the NER server answered in an unknown format')
      }
      todo.forEach((t, i) => {
        if (nerCache.size >= NER_CACHE_SIZE) nerCache.delete(nerCache.keys().next().value as string)
        nerCache.set(t, nerFinds(results[i] as NerEntity[], ner))
      })
    } catch (err) {
      nerStats.failures += 1
      throw err
    } finally {
      nerStats.ms += Date.now() - started
    }
  }
  return texts.flatMap(t => nerCache.get(t) ?? [])
}

/**
 * The rules NER adds for one piece of content: what the model finds in
 * `texts` (when `ask`), plus every value it found earlier this session.
 * None when detection is "list".
 */
async function nerExtra($: EngineInterface, texts: readonly string[], ask: boolean): Promise<Rule[]> {
  if (detection === 'list') return []
  return nerRules(ask ? await nerFind($, texts) : [], vault)
}

/**
 * Reads the config files again. A broken config is not applied: the working
 * one stays in force and the reason is returned. A good one replaces it, lifts
 * a block a bad config caused, and re-renders the context Claude got masked.
 */
async function reloadConfig($: EngineInterface): Promise<string> {
  let next: LoadedConfig
  try {
    next = await readConfig($)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return `Not reloaded, the current config stays in force: ${reason}`
  }
  applyConfig(next)
  blocks.delete('config')
  await checkNer($)
  await $.ui.invalidate('prompt.context')
  await $.ui.invalidate('prompt.section')
  $.ui.status(blocked() ? `🔒 ${NAME}: BLOCKED` : `🔒 ${NAME} on`)
  return `Reloaded. Config: ${configSummary}`
}

/**
 * Reserves every placeholder number a resumed conversation already uses. Best
 * effort: early in a headless start the conversation is not readable yet, and
 * session.start runs this again once it is.
 */
async function reserveFromTranscript($: EngineInterface): Promise<void> {
  let messages: Awaited<ReturnType<EngineInterface['session']['messages']>>
  try {
    messages = await $.session.messages()
  } catch {
    return
  }
  for (const m of messages) {
    vault.reserve(m.text)
    for (const r of m.toolResults ?? []) vault.reserve(r.text ?? '')
    for (const u of m.toolUses) vault.reserve(JSON.stringify(u))
  }
}

async function persist($: EngineInterface, before: number): Promise<void> {
  if (vault.size === before) return
  await update($, vaultAtom, () => vault.entries())
  await writeVaultFile($)
}

/** Writes the vault beside the session's transcript, so a resumed session can restore its placeholders. */
async function writeVaultFile($: EngineInterface): Promise<void> {
  if (sessionFile === undefined || vault.size === 0) return
  const data: VaultFile = { version: 1, marker: vault.marker, entries: vault.entries() }
  await $.fs.write(sessionFile, JSON.stringify(data, null, 1))
}

/** Starts this module's vault over: a new marker and no entries. */
async function freshVault($: EngineInterface): Promise<void> {
  vault = new Vault(newMarker())
  await update($, markerAtom, () => vault.marker)
  await update($, vaultAtom, () => [])
}

/**
 * Ties the vault to the session's transcript. On start or resume, a vault file
 * already beside the transcript is adopted (its marker and entries), so the
 * placeholders the transcript holds resolve again. /clear starts a new
 * conversation and a new vault. Anything new is written to the file.
 */
async function attach($: EngineInterface, path: string, source: string): Promise<void> {
  const file = vaultFileFor(path)
  if (file === sessionFile) return
  sessionFile = file
  transcriptPath = path

  if (source === 'clear') {
    await freshVault($)
  } else if (await $.fs.exists(file)) {
    let saved: VaultFile
    try {
      saved = parseVaultFile(await $.fs.read(file))
    } catch (err) {
      blocks.set('vault', `the vault file ${file} cannot be read (${String(err)}). Move it away and restart the session.`)
      return
    }
    // Placeholders minted before the file was found (none, normally) are
    // dropped; the system prompt and first-message context are re-rendered.
    const minted = vault.size > 0 && vault.marker !== saved.marker
    vault = new Vault(saved.marker)
    vault.load(saved.entries, rules)
    await update($, markerAtom, () => vault.marker)
    await update($, vaultAtom, () => vault.entries())
    if (minted) {
      await $.ui.invalidate('prompt.context')
      await $.ui.invalidate('prompt.section')
    }
  }
  await reserveFromTranscript($)
  await writeVaultFile($)
}

/** Masks text with the configured rules, then `extra` (the NER rules for the content at hand). */
function maskText(text: string, options?: { hints?: boolean }, extra: readonly Rule[] = []): string {
  return mask(text, extra.length ? [...rules, ...extra] : rules, vault, options)
}

type Block = { type: string; [field: string]: unknown }

const isMedia = (b: Block) => dropMedia && MEDIA_BLOCKS.has(b.type)

/** The texts in a row's blocks that masking rewrites (what NER is asked about). */
function textsOf(content: readonly Block[]): string[] {
  const out: string[] = []
  for (const b of content) {
    if (b.type === 'text' && typeof b.text === 'string') out.push(b.text)
    if (b.type === 'tool_result') {
      if (typeof b.content === 'string') out.push(b.content)
      else if (Array.isArray(b.content)) out.push(...textsOf(b.content as Block[]))
    }
  }
  return out
}

/** Masks one block. Inside a tool result, media is replaced with a note (its content is ours to rewrite). */
function maskBlock(block: Block, extra: readonly Rule[]): Block {
  if (block.type === 'text' && typeof block.text === 'string') {
    return { ...block, text: maskText(block.text, undefined, extra) }
  }
  if (block.type === 'tool_result') {
    const c = block.content
    if (typeof c === 'string') return { ...block, content: maskText(c, undefined, extra) }
    if (Array.isArray(c)) {
      return {
        ...block,
        content: (c as Block[]).map(inner => {
          if (!isMedia(inner)) return maskBlock(inner, extra)
          mediaDropped += 1
          return { type: 'text', text: MEDIA_NOTE }
        }),
      }
    }
  }
  return block
}

/**
 * Masks a row's blocks. A row's own media blocks may only be dropped, not
 * replaced, so the note goes into the row's first text block when it has one.
 */
function maskContent(content: readonly Block[], extra: readonly Rule[]): Block[] {
  const kept = content.filter(b => !isMedia(b))
  const dropped = content.length - kept.length
  if (dropped === 0) return content.map(b => maskBlock(b, extra))
  mediaDropped += dropped
  let noted = false
  return kept.map(b => {
    const masked = maskBlock(b, extra)
    if (noted || masked.type !== 'text' || typeof masked.text !== 'string') return masked
    noted = true
    return { ...masked, text: `${masked.text}\n\n${MEDIA_NOTE}` }
  })
}

/** A row's content with every text removed: what is stored when masking it failed. */
function redactContent(content: readonly Block[]): Block[] {
  rowsRemoved += 1
  return content
    .filter(b => !MEDIA_BLOCKS.has(b.type))
    .map(b =>
      b.type === 'text' ? { ...b, text: UNCHECKED_NOTE } : b.type === 'tool_result' ? { ...b, content: UNCHECKED_NOTE } : b,
    )
}

/** Most a mod can read in one call. */
const MAX_READ = 4 * 1024 * 1024

/**
 * Rewrites one file with `clean`'s answer. Reads it again just before writing
 * and gives up rather than overwrite something written in between; a file
 * over 4 MiB cannot be read from a mod and is left (tools/clean-transcripts.mjs
 * does those).
 */
async function rewriteFile($: EngineInterface, path: string, clean: (text: string) => string): Promise<void> {
  let original: string
  try {
    original = await $.fs.read(path)
  } catch {
    return
  }
  const text = clean(original)
  if (text === original) return
  if ((await $.fs.read(path)) !== original) return
  await $.fs.write(path, text)
}

/** The files in a folder of the session's, or none when it does not exist. */
async function filesIn($: EngineInterface, dir: string, suffix: string): Promise<string[]> {
  if (!(await $.fs.exists(dir))) return []
  const entries = await $.fs.list(dir)
  return entries.filter(f => f.kind === 'file' && f.name.endsWith(suffix) && f.size <= MAX_READ).map(f => `${dir}/${f.name}`)
}

/**
 * Masks the copies Claude Code keeps on disk without passing them through the
 * mod: in the transcript and the subagents' transcripts, the prompt queue
 * records and tool results' structured records; in tool-results/, the full
 * output of results too long to show the model whole. Uses the values the
 * vault knows and, for values the model never saw, the detection rules.
 */
async function cleanSessionFiles($: EngineInterface): Promise<void> {
  if (transcriptPath === undefined) return
  const sessionDir = transcriptPath.replace(/\.jsonl$/, '')
  const transcripts = [transcriptPath, ...(await filesIn($, `${sessionDir}/subagents`, '.jsonl'))]
  for (const path of transcripts) await rewriteFile($, path, t => cleanTranscript(t, vault, rules).text)
  for (const path of await filesIn($, `${sessionDir}/tool-results`, '.txt')) {
    await rewriteFile($, path, t => cleanText(t, vault, rules))
  }
  // Values found only now get placeholders too; keep them, so a resumed
  // session that reads a cleaned file can restore them.
  await writeVaultFile($)
}

export const register: Register = on => {
  // Every row the conversation keeps passes here before it is stored and sent.
  // If masking a row throws or runs out of time, Claude Code would skip this
  // hook and store the row as it was; the .catch stores it with its text
  // removed instead, so a failure never lets customer data through.
  on('session.append', async ($, e, next) => {
    await ready($)
    const before = vault.size
    const extra = await nerExtra($, textsOf(e.message.content), ner.scope === 'all' || PROMPT_DOORS.has(e.door))
    const content = maskContent(e.message.content, extra)
    await persist($, before)
    return next({ ...e, message: { ...e.message, content } })
  }).catch(($, e, next) =>
    next.called ? next(e) : next({ ...e, message: { ...e.message, content: redactContent(e.message.content) } }),
  )

  // The session title: by default the engine asks a small model to title the
  // session from the raw first prompt. A title set here replaces that call, so
  // the prompt never leaves unmasked; the title is the masked prompt's start.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    await ready($)
    if (sessionFile === undefined && e.agent_id === undefined) await attach($, e.transcript_path, 'startup')
    const before = vault.size
    const result = await next(e)
    const extra = result.sessionTitle === undefined ? await nerExtra($, [e.prompt], true) : []
    // The model never reads the title, so it does not use up a customer's one-time hint.
    const title =
      result.sessionTitle ?? maskText(e.prompt, { hints: false }, extra).replace(/\s+/g, ' ').trim().slice(0, 60)
    await persist($, before)
    return { ...result, sessionTitle: title }
  }).catch(async ($, e, next) => ({ ...(await next(e)), sessionTitle: `${NAME}: title withheld` }))

  // The model's reply: unmask as it streams, so the person reads real values.
  on('turn.step', async function* ($, e, next) {
    await ready($)

    const reason = blocked()
    if (reason !== undefined) {
      const text = `${NAME} stopped this request so customer data could not leak: ${reason}`
      yield { kind: 'text', index: 0, text }
      return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
    }

    type Open = { kind: 'text' | 'thinking'; index: number; u: StreamUnmasker }
    const open = new Map<string, Open>()
    const drain = (exceptKey?: string): TurnStepChunk[] => {
      const out: TurnStepChunk[] = []
      for (const [key, s] of open) {
        if (key === exceptKey) continue
        open.delete(key)
        const rest = s.u.flush()
        if (rest) out.push({ kind: s.kind, index: s.index, text: rest })
      }
      return out
    }

    for await (const chunk of next(e)) {
      if (chunk.kind === 'text' || chunk.kind === 'thinking') {
        const key = `${chunk.kind}:${chunk.index}`
        yield* drain(key)
        let s = open.get(key)
        if (!s) open.set(key, (s = { kind: chunk.kind, index: chunk.index, u: new StreamUnmasker(vault) }))
        const text = s.u.push(chunk.text)
        if (text) yield { ...chunk, text }
        continue
      }
      yield* drain()
      yield chunk
    }
    yield* drain()
  })

  // The model's tool calls: restore real values in the arguments before the
  // permission prompt and the tool see them, except for tools that would send
  // them off this machine (maskedTools: the web tools and every MCP tool by
  // default), which keep their placeholders.
  on('tool.call', async ($, e, next) => {
    await ready($)
    return next(keepsPlaceholders(String(e.tool)) ? e : unmaskDeep(e, vault, TOOL_ENVELOPE))
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${NAME} could not restore the customer data in this call's arguments; retry it.` },
  )

  // The system prompt: mask the per-session sections, and explain the placeholders.
  on('prompt.compose', async ($, e, next) => {
    await ready($)
    const before = vault.size
    const { sections } = await next(e)
    const own = sections.filter(s => s.scope === 'session').map(s => s.text)
    const extra = await nerExtra($, own, ner.scope === 'all')
    const masked = sections.map(s => (s.scope === 'session' ? { ...s, text: maskText(s.text, undefined, extra) } : s))
    await persist($, before)
    return { sections: [...masked, { id: `${NAME}:note`, text: systemNote(vault), scope: 'session' as const }] }
  }).catch(async ($, e, next) => {
    // Masking failed: send the per-session sections' text as a note, not as it was.
    const { sections } = await next(e)
    return { sections: sections.map(s => (s.scope === 'session' ? { ...s, text: UNCHECKED_NOTE } : s)) }
  })

  // CLAUDE.md and the other blocks of the first message.
  on('prompt.context', async ($, e, next) => {
    await ready($)
    const before = vault.size
    const result = await next(e)
    const extra = await nerExtra($, result.blocks.map(b => b.text), ner.scope === 'all')
    const blocks = result.blocks.map(b => ({ ...b, text: maskText(b.text, undefined, extra) }))
    await persist($, before)
    return { ...result, blocks }
  }).catch(async ($, e, next) => {
    // Masking failed: send each context block's text as a note, not as it was.
    const result = await next(e)
    return { ...result, blocks: result.blocks.map(b => ({ ...b, text: UNCHECKED_NOTE })) }
  })

  // Text the engine injects on its own (mentioned files, reminders).
  on('prompt.attachment', async ($, e, next) => {
    await ready($)
    const before = vault.size
    const result = await next(e)
    const extra = result.text === null ? [] : await nerExtra($, [result.text], ner.scope === 'all')
    const masked = result.text === null ? result : { text: maskText(result.text, undefined, extra) }
    await persist($, before)
    return masked
  }).catch(() => ({ text: null })) // Masking failed: leave the injected text out.

  // Where the session's transcript is: the vault file goes beside it.
  on('classic.SessionStart', async ($, e, next) => {
    await ready($)
    if (e.agent_id === undefined) await attach($, e.transcript_path, e.source)
    return next(e)
  })

  // When the session ends (or /clear ends a conversation), mask the local
  // copies Claude Code wrote beside the masked rows.
  on('session.end', async ($, e, next) => {
    try {
      await cleanSessionFiles($)
    } catch {
      // Best effort: the rows the model reads are masked either way.
    }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await ready($)
    await reserveFromTranscript($)
    await $.command.register({
      name: 'customer-mask',
      description: 'Show what customer-mask detects and has replaced; "reload" re-reads the config.',
      argumentHint: '[reload]',
    })
    $.ui.status(blocked() ? `🔒 ${NAME}: BLOCKED` : `🔒 ${NAME} on`)
    return next(e)
  })

  on('command.run', { command: 'customer-mask' }, async ($, e) => {
    await ready($)
    const arg = e.args.trim()
    if (arg === 'reload') return { text: await reloadConfig($) }
    if (arg !== '') return { text: `Unknown option "${arg}". Use /customer-mask to see the status, or /customer-mask reload.` }
    const rows = vault.entries().map(v => `  ${vault.format(v.token)}  →  ${v.value}`)
    return {
      text: [
        `${NAME}: ${blocked() ? `BLOCKED — ${blocked()}` : 'active'}`,
        `Config: ${configSummary}`,
        `Images/PDFs removed this session: ${mediaDropped}`,
        `Rows removed because masking failed: ${rowsRemoved}`,
        ...(detection === 'list'
          ? []
          : [
              `NER calls: ${nerStats.calls} (${nerStats.calls ? Math.round(nerStats.ms / nerStats.calls) : 0} ms on average), ` +
                `failed: ${nerStats.failures}, values found: ${vault.learned().length}`,
            ]),
        `Placeholder table saved to: ${sessionFile ?? 'not yet (no transcript known)'}`,
        rows.length ? `Replaced this session (${rows.length}):\n${rows.join('\n')}` : 'Nothing replaced yet.',
      ].join('\n'),
    }
  })
}
