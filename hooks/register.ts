import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnStepChunk } from 'claude-code'

import type { VaultEntry } from '../types'
import {
  buildRules,
  DEFAULT_MASKED_TOOLS,
  mask,
  StreamUnmasker,
  MEDIA_BLOCKS,
  MEDIA_NOTE,
  newMarker,
  systemNote,
  toolPolicy,
  unmaskDeep,
  Vault,
  type MaskConfig,
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
/** Set when masking failed: from then on no request leaves this session. */
let blocked: string | undefined
let loading: Promise<void> | undefined

/** Loads config and vault once; never rejects. A failure blocks the session instead. */
function ready($: EngineInterface): Promise<void> {
  loading ??= load($).catch(err => {
    blocked = `loading the customer-mask config failed (${String(err)}).`
  })
  return loading
}

async function load($: EngineInterface): Promise<void> {
  const customers: string[] = []
  const patterns: NonNullable<MaskConfig['patterns']> = []
  let detectors: MaskConfig['detectors'] = {}
  let toolList: string[] | undefined
  let media: MaskConfig['media']
  const exceptions: string[] = []
  const sources: string[] = []

  const candidates: string[] = []
  const explicit = await $.env.get('CUSTOMER_MASK_CONFIG')
  if (explicit) candidates.push(explicit)
  const home = await $.env.get('HOME')
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
      sources.push(path)
    } catch (err) {
      blocked = `${path} is not valid JSON (${String(err)}). Fix it, then restart the session.`
    }
  }

  try {
    rules = buildRules({ customers, patterns, detectors })
  } catch (err) {
    blocked = `a pattern in the customer-mask config does not compile (${String(err)}).`
  }

  maskedList = toolList ?? DEFAULT_MASKED_TOOLS
  unmaskedList = exceptions
  keepsPlaceholders = toolPolicy(maskedList, unmaskedList)
  if (media !== undefined && media !== 'drop' && media !== 'allow') {
    blocked = `media must be "drop" or "allow", not ${JSON.stringify(media)}.`
  }
  dropMedia = media !== 'allow'
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

  configSummary =
    `${customers.length} customer name(s), ${patterns.length} custom pattern(s), ` +
    `tools kept masked: ${maskedList.join(', ') || 'none'}` +
    (unmaskedList.length ? ` except ${unmaskedList.join(', ')}` : '') +
    `, images/PDFs: ${dropMedia ? 'dropped' : 'sent unmasked'}` +
    (sources.length ? ` from ${sources.join(', ')}` : ' (no config file found; built-in detectors only)')
}

/** Reserves every placeholder number a resumed conversation already uses. */
async function reserveFromTranscript($: EngineInterface): Promise<void> {
  for (const m of await $.session.messages()) {
    vault.reserve(m.text)
    for (const r of m.toolResults ?? []) vault.reserve(r.text ?? '')
    for (const u of m.toolUses) vault.reserve(JSON.stringify(u))
  }
}

async function persist($: EngineInterface, before: number): Promise<void> {
  if (vault.size !== before) await update($, vaultAtom, () => vault.entries())
}

function maskText(text: string): string {
  return mask(text, rules, vault)
}

type Block = { type: string; [field: string]: unknown }

const isMedia = (b: Block) => dropMedia && MEDIA_BLOCKS.has(b.type)

/** Masks one block. Inside a tool result, media is replaced with a note (its content is ours to rewrite). */
function maskBlock(block: Block): Block {
  if (block.type === 'text' && typeof block.text === 'string') {
    return { ...block, text: maskText(block.text) }
  }
  if (block.type === 'tool_result') {
    const c = block.content
    if (typeof c === 'string') return { ...block, content: maskText(c) }
    if (Array.isArray(c)) {
      return {
        ...block,
        content: (c as Block[]).map(inner => {
          if (!isMedia(inner)) return maskBlock(inner)
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
function maskContent(content: readonly Block[]): Block[] {
  const kept = content.filter(b => !isMedia(b))
  const dropped = content.length - kept.length
  if (dropped === 0) return content.map(maskBlock)
  mediaDropped += dropped
  let noted = false
  return kept.map(b => {
    const masked = maskBlock(b)
    if (noted || masked.type !== 'text' || typeof masked.text !== 'string') return masked
    noted = true
    return { ...masked, text: `${masked.text}\n\n${MEDIA_NOTE}` }
  })
}

export const register: Register = on => {
  // Every row the conversation keeps passes here before it is stored and sent.
  on('session.append', async ($, e, next) => {
    try {
      await ready($)
      const before = vault.size
      const content = maskContent(e.message.content)
      await persist($, before)
      return next({ ...e, message: { ...e.message, content } })
    } catch (err) {
      blocked = `masking a ${e.door} row failed (${String(err)}).`
      return next(e)
    }
  })

  // The session title: by default the engine asks a small model to title the
  // session from the raw first prompt. A title set here replaces that call, so
  // the prompt never leaves unmasked; the title is the masked prompt's start.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    await ready($)
    const before = vault.size
    const result = await next(e)
    const title = result.sessionTitle ?? maskText(e.prompt).replace(/\s+/g, ' ').trim().slice(0, 60)
    await persist($, before)
    return { ...result, sessionTitle: title }
  })

  // The model's reply: unmask as it streams, so the person reads real values.
  on('turn.step', async function* ($, e, next) {
    await ready($)

    if (blocked !== undefined) {
      const text = `${NAME} stopped this request so customer data could not leak: ${blocked}`
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
    const masked = sections.map(s => (s.scope === 'session' ? { ...s, text: maskText(s.text) } : s))
    await persist($, before)
    return { sections: [...masked, { id: `${NAME}:note`, text: systemNote(vault), scope: 'session' as const }] }
  })

  // CLAUDE.md and the other blocks of the first message.
  on('prompt.context', async ($, e, next) => {
    await ready($)
    const before = vault.size
    const result = await next(e)
    const blocks = result.blocks.map(b => ({ ...b, text: maskText(b.text) }))
    await persist($, before)
    return { ...result, blocks }
  })

  // Text the engine injects on its own (mentioned files, reminders).
  on('prompt.attachment', async ($, e, next) => {
    await ready($)
    const before = vault.size
    const result = await next(e)
    const masked = result.text === null ? result : { text: maskText(result.text) }
    await persist($, before)
    return masked
  })

  on('session.start', async ($, e, next) => {
    await ready($)
    await reserveFromTranscript($)
    await $.command.register({
      name: 'customer-mask',
      description: 'Show what customer-mask detects and which values it has replaced this session.',
    })
    $.ui.status(blocked ? `🔒 ${NAME}: BLOCKED` : `🔒 ${NAME} on`)
    return next(e)
  })

  on('command.run', { command: 'customer-mask' }, async $ => {
    await ready($)
    const rows = vault.entries().map(v => `  ${vault.format(v.token)}  →  ${v.value}`)
    return {
      text: [
        `${NAME}: ${blocked ? `BLOCKED — ${blocked}` : 'active'}`,
        `Config: ${configSummary}`,
        `Images/PDFs removed this session: ${mediaDropped}`,
        rows.length ? `Replaced this session (${rows.length}):\n${rows.join('\n')}` : 'Nothing replaced yet.',
      ].join('\n'),
    }
  })
}
