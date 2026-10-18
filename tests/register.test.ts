import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnStepChunk } from 'claude-code'

/** Builds a placeholder at run time, so no literal token sits in this file. */
const ph = (label: string, n: number, marker = '') =>
  marker ? `<<${label}_${n}.${marker}>>` : `<<${label}_${n}>>`

/** The session marker in masked text (placeholders look like LABEL_n.abcd inside double angle brackets). */
const markerIn = (text: string) => /<<[A-Z][A-Z0-9_]*_\d+\.([a-z0-9]{4})>>/.exec(text)?.[1] ?? ''

const CONFIG = JSON.stringify({
  customers: ['Acme Freight A/S'],
  patterns: [{ label: 'SHIPMENT', regex: '\\bSHP\\d{8}\\b' }],
})

type World = {
  files?: Record<string, string>
  reply?: TurnStepChunk[] | (() => TurnStepChunk[])
  sections?: { id: string; text: string; scope: 'shared' | 'session' }[]
  history?: { role: 'user' | 'assistant'; text: string; toolUses: never[] }[]
  version?: string
  /** Environment variables the mod reads (default: HOME=/home/u). */
  env?: Record<string, string>
  /** What prompt.context and prompt.attachment answer from beneath. */
  contextBlocks?: { name: string; text: string }[]
  attachmentText?: string
  /** Every file write fails (to make a hook throw part-way). */
  failWrites?: boolean
  /** The conversation is not readable yet (early in a headless start). */
  historyUnavailable?: boolean
}

/**
 * The world beneath the plugin, registered before the first call on `$`: a
 * project folder holding the config file, a model that streams `reply`, a
 * Bash tool that records what it was asked to run, and a system prompt.
 */
function world(on: On, w: World = {}) {
  const files = w.files ?? { '/proj/.claude/customer-mask.json': CONFIG }
  const seen = { requestSent: false, ran: '', writes: {} as Record<string, string> }

  mock.env(on, w.env ?? { HOME: '/home/u' })
  on('session.cwd', () => ({ value: '/proj' }))
  on('fs.read', ($, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('fs.exists', ($, e) => ({ value: e.path in files || Object.keys(files).some(f => f.startsWith(`${e.path}/`)) }))
  on('fs.write', ($, e) => {
    if (w.failWrites) return { deny: 'disk full' }
    seen.writes[e.path] = e.text
    files[e.path] = e.text
    return { value: undefined }
  })
  on('classic.SessionStart', () => ({}))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.step', async function* () {
    seen.requestSent = true
    const reply = typeof w.reply === 'function' ? w.reply() : (w.reply ?? [])
    for (const c of reply) yield c
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash') seen.ran = e.command
    if (e.tool === 'WebSearch') seen.ran = e.query
    if (String(e.tool).startsWith('mcp__')) seen.ran = String((e as { text?: unknown }).text)
    return { result: { stdout: 'ok', stderr: '', interrupted: false } } as never
  })
  on('prompt.compose', () => ({ sections: w.sections ?? [] }))
  on('prompt.context', () => ({ blocks: w.contextBlocks ?? [] }) as never)
  on('prompt.attachment', () => ({ text: w.attachmentText ?? null }) as never)
  on('fs.list', ($, e) => {
    const prefix = `${e.path}/`
    const names = Object.keys(files).filter(f => f.startsWith(prefix) && !f.slice(prefix.length).includes('/'))
    return {
      value: names.map(f => ({ name: f.slice(prefix.length), kind: 'file', size: (files[f] ?? '').length, mtimeMs: 0, isLink: false })),
    } as never
  })
  on('classic.UserPromptSubmit', () => ({}))
  on('session.messages', () =>
    w.historyUnavailable ? { deny: 'no session is bound in this process' } : { value: w.history ?? [] },
  )
  on('session.version', () => ({ value: { version: w.version ?? '2.1.296' } }))
  return seen
}

async function appendPrompt($: Engine, text: string, uuid = 'u1') {
  return $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
    door: 'prompt',
    origin: { kind: 'user' },
    uuid,
  } as never)
}

async function collect(stream: AsyncIterable<TurnStepChunk>) {
  const chunks: TurnStepChunk[] = []
  for await (const c of stream) chunks.push(c)
  return chunks
}

const textOf = (chunks: TurnStepChunk[]) =>
  chunks.map(c => (c.kind === 'text' ? c.text : '')).join('')

describe('outgoing: session.append', () => {
  test('a prompt is stored and sent with placeholders only', async ($, on) => {
    world(on)
    const stored = await appendPrompt($, 'Why is SHP12345678 for Acme Freight A/S late? Mail ops@acme.dk')
    const text = JSON.stringify(stored.message?.content)

    expect(text).not.toContain('Acme Freight')
    expect(text).not.toContain('SHP12345678')
    expect(text).not.toContain('ops@acme.dk')
    const m = markerIn(text)
    expect(m).toMatch(/^[a-z0-9]{4}$/)
    expect(text).toContain(ph('CUSTOMER', 1, m))
    expect(text).toContain(ph('SHIPMENT', 1, m))
    expect(text).toContain(ph('EMAIL', 1, m))
  })

  test('tool results (file contents, command output) are masked too', async ($, on) => {
    world(on)
    const stored = await $.session.append({
      message: {
        type: 'user',
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'customer,shipment\nAcme Freight A/S,SHP87654321' },
        ],
      },
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Read' },
      uuid: 'u2',
    } as never)
    const text = JSON.stringify(stored.message?.content)
    expect(text).not.toContain('Acme')
    expect(text).not.toContain('SHP87654321')
  })
})

describe('failing closed', () => {
  test('a row that cannot be masked is stored with its text removed, not as it was', async ($, on) => {
    world(on)
    const stored = await $.session.append({
      message: {
        type: 'user',
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't9', content: ['Acme Freight A/S', null] }],
      },
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Read' },
      uuid: 'f1',
    } as never)
    const text = JSON.stringify(stored.message?.content)
    expect(text).not.toContain('Acme')
    expect(text).toContain('could not check this content')
  })
})

const TRANSCRIPT = '/home/u/.claude/projects/-proj/s1.jsonl'
const VAULT_FILE = '/home/u/.claude/projects/-proj/s1.customer-mask.json'

describe('vault beside the session', () => {
  test('placeholders are saved beside the transcript', async ($, on) => {
    const seen = world(on)
    await $.classic.SessionStart({ source: 'startup', transcript_path: TRANSCRIPT } as never)
    await appendPrompt($, 'Acme Freight A/S')
    const saved = JSON.parse(seen.writes[VAULT_FILE] ?? '{}')
    expect(saved.version).toBe(1)
    expect(saved.marker).toMatch(/^[a-z0-9]{4}$/)
    expect(saved.entries).toEqual([{ token: 'CUSTOMER_1', value: 'Acme Freight A/S', label: 'CUSTOMER' }])
  })

  test('a resumed session restores its placeholders and continues the numbering', async ($, on) => {
    const vaultFile = JSON.stringify({
      version: 1,
      marker: 'abcd',
      entries: [{ token: 'CUSTOMER_1', value: 'Acme Freight A/S', label: 'CUSTOMER' }],
    })
    const config = JSON.stringify({ customers: ['Acme Freight A/S', 'Nordic Widgets'] })
    const seen = world(on, { files: { '/proj/.claude/customer-mask.json': config, [VAULT_FILE]: vaultFile } })
    await $.classic.SessionStart({ source: 'resume', transcript_path: TRANSCRIPT } as never)

    await $.tool.call({ tool: 'Bash', command: `echo ${ph('CUSTOMER', 1, 'abcd')}` } as never)
    expect(seen.ran).toBe('echo Acme Freight A/S')

    const stored = await appendPrompt($, 'Acme Freight A/S and Nordic Widgets')
    expect(JSON.stringify(stored.message?.content)).toContain(`${ph('CUSTOMER', 1, 'abcd')} and ${ph('CUSTOMER', 2, 'abcd')}`)
  })

  test('/clear starts a new table: old placeholders no longer resolve', async ($, on) => {
    const vaultFile = JSON.stringify({
      version: 1,
      marker: 'abcd',
      entries: [{ token: 'CUSTOMER_1', value: 'Acme Freight A/S', label: 'CUSTOMER' }],
    })
    const seen = world(on, { files: { '/proj/.claude/customer-mask.json': CONFIG, [VAULT_FILE]: vaultFile } })
    await $.classic.SessionStart({ source: 'resume', transcript_path: TRANSCRIPT } as never)
    await $.classic.SessionStart({ source: 'clear', transcript_path: '/home/u/.claude/projects/-proj/s2.jsonl' } as never)
    await $.tool.call({ tool: 'Bash', command: `echo ${ph('CUSTOMER', 1, 'abcd')}` } as never)
    expect(seen.ran).toBe(`echo ${ph('CUSTOMER', 1, 'abcd')}`)
  })

  test('an unreadable vault file blocks the session instead of guessing', async ($, on) => {
    const seen = world(on, { files: { '/proj/.claude/customer-mask.json': CONFIG, [VAULT_FILE]: '{ broken' } })
    await $.classic.SessionStart({ source: 'resume', transcript_path: TRANSCRIPT } as never)
    const chunks = await collect($.turn.step({ turnId: 't', index: 0, model: 'claude', messageCount: 1 }))
    expect(seen.requestSent).toBe(false)
    expect(textOf(chunks)).toContain('vault file')
  })
})

describe('early in a headless start', () => {
  test('an unreadable conversation does not block the session', async ($, on) => {
    const seen = world(on, { historyUnavailable: true })
    await $.classic.SessionStart({ source: 'startup', transcript_path: TRANSCRIPT } as never)
    await collect($.turn.step({ turnId: 't', index: 0, model: 'claude', messageCount: 1 }))
    expect(seen.requestSent).toBe(true)
  })
})

describe('cleaning the transcript at session end', () => {
  test('the prompt queue record and tool records are masked when the session ends', async ($, on) => {
    const transcript = [
      JSON.stringify({ type: 'queue-operation', content: 'Ping Acme Freight A/S' }),
      JSON.stringify({ type: 'user', toolUseResult: { stdout: 'Acme Freight A/S ok', cwd: '/proj' } }),
    ].join('\n')
    const seen = world(on, { files: { '/proj/.claude/customer-mask.json': CONFIG, [TRANSCRIPT]: transcript } })
    await $.classic.SessionStart({ source: 'startup', transcript_path: TRANSCRIPT } as never)
    const m = markerIn(JSON.stringify((await appendPrompt($, 'Ping Acme Freight A/S')).message?.content))

    await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } } as never)

    const cleaned = seen.writes[TRANSCRIPT] ?? ''
    expect(cleaned).not.toContain('Acme')
    expect(cleaned).toContain(`Ping ${ph('CUSTOMER', 1, m)}`)
    expect(cleaned).toContain(`${ph('CUSTOMER', 1, m)} ok`)
    expect(cleaned).toContain('"cwd":"/proj"')
  })
})

describe('customer hints in a session', () => {
  test('Claude sees the hint once; a copied hint never reaches the tool', async ($, on) => {
    const config = JSON.stringify({ customers: [{ name: 'Acme Freight A/S', hint: 'Danish freight forwarder' }] })
    const seen = world(on, { files: { '/proj/.claude/customer-mask.json': config } })
    // The title is masked first, as in a session; it must not use up the hint.
    const titled = await $.classic.UserPromptSubmit({ prompt: 'Acme Freight A/S is late' } as never)
    expect(String(titled.sessionTitle)).not.toContain('hint')
    const first = JSON.stringify((await appendPrompt($, 'Acme Freight A/S is late', 'h1')).message?.content)
    const m = markerIn(first)
    expect(first).toContain(`${ph('CUSTOMER', 1, m)} [hint: Danish freight forwarder] is late`)
    const second = JSON.stringify((await appendPrompt($, 'Acme Freight A/S again', 'h2')).message?.content)
    expect(second).not.toContain('hint')

    await $.tool.call({ tool: 'Bash', command: `echo "${ph('CUSTOMER', 1, m)} [hint: Danish freight forwarder]"` } as never)
    expect(seen.ran).toBe('echo "Acme Freight A/S"')
  })
})

const reload = ($: Engine) => $.command.run({ command: 'customer-mask', args: 'reload' } as never)

describe('/customer-mask reload', () => {
  test('a customer added to the config is masked after a reload', async ($, on) => {
    const files: Record<string, string> = { '/proj/.claude/customer-mask.json': CONFIG }
    world(on, { files })
    expect(JSON.stringify((await appendPrompt($, 'Zephyr Cargo ApS', 'r1')).message?.content)).toContain('Zephyr')

    files['/proj/.claude/customer-mask.json'] = JSON.stringify({ customers: ['Acme Freight A/S', 'Zephyr Cargo ApS'] })
    const answer = await reload($)
    expect(JSON.stringify(answer)).toContain('Reloaded')
    expect(JSON.stringify((await appendPrompt($, 'Zephyr Cargo ApS', 'r2')).message?.content)).not.toContain('Zephyr')
  })

  test('a broken config is not applied; the working one stays in force', async ($, on) => {
    const files: Record<string, string> = { '/proj/.claude/customer-mask.json': CONFIG }
    world(on, { files })
    await appendPrompt($, 'warm up', 'r3')
    files['/proj/.claude/customer-mask.json'] = '{ broken'
    expect(JSON.stringify(await reload($))).toContain('Not reloaded')
    expect(JSON.stringify((await appendPrompt($, 'Acme Freight A/S', 'r4')).message?.content)).not.toContain('Acme')
  })

  test('fixing a broken config and reloading lifts the block', async ($, on) => {
    const files: Record<string, string> = { '/proj/.claude/customer-mask.json': '{ broken' }
    world(on, { files })
    const status = async () => JSON.stringify(await $.command.run({ command: 'customer-mask', args: '' } as never))
    expect(await status()).toContain('BLOCKED')

    files['/proj/.claude/customer-mask.json'] = CONFIG
    expect(JSON.stringify(await reload($))).toContain('Reloaded')
    // (The test kit answers one model request per test, so the lifted block is read from the status.)
    expect(await status()).toContain('customer-mask: active')
  })
})

describe('cleaning the rest of the session folder', () => {
  test('values the model never saw, subagent transcripts and tool-results files are masked at session end', async ($, on) => {
    const dir = '/home/u/.claude/projects/-proj/s1'
    const files: Record<string, string> = {
      '/proj/.claude/customer-mask.json': CONFIG,
      [TRANSCRIPT]: JSON.stringify({ type: 'user', toolUseResult: { stdout: 'Acme Freight A/S SHP87654321 x@y.dk' } }),
      [`${dir}/subagents/agent-a1.jsonl`]: JSON.stringify({ type: 'user', toolUseResult: { stdout: 'SHP11112222' } }),
      [`${dir}/tool-results/t1.txt`]: 'full output: Acme Freight A/S, SHP99998888, z@y.dk',
    }
    const seen = world(on, { files })
    await $.classic.SessionStart({ source: 'startup', transcript_path: TRANSCRIPT } as never)
    await appendPrompt($, 'Acme Freight A/S')
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } } as never)

    const all = [TRANSCRIPT, `${dir}/subagents/agent-a1.jsonl`, `${dir}/tool-results/t1.txt`].map(f => seen.writes[f] ?? '')
    for (const text of all) {
      expect(text.length).toBeGreaterThan(0)
      expect(text).not.toMatch(/Acme|SHP\d{8}|@y\.dk/)
    }
    // Values found only at the end are in the saved table, so they can still be restored.
    const saved = JSON.parse(seen.writes[VAULT_FILE] ?? '{}')
    expect(saved.entries.map((e: { value: string }) => e.value)).toContain('SHP99998888')
  })
})

describe('failing closed in the prompt hooks', () => {
  // Saving the placeholder table fails after masking started, so the hook throws part-way.
  test('context blocks that cannot be masked are sent as a note, not as they were', async ($, on) => {
    world(on, { contextBlocks: [{ name: 'claudeMd', text: 'Acme Freight A/S notes' }], failWrites: true })
    await $.classic.SessionStart({ source: 'startup', transcript_path: TRANSCRIPT } as never)
    const { blocks } = await $.prompt.context({ blocks: [] } as never)
    expect(blocks.map(b => b.text)).toEqual([expect.stringContaining('could not check this content')])
  })

  test('injected text that cannot be masked is left out', async ($, on) => {
    world(on, { attachmentText: 'Acme Freight A/S was mentioned', failWrites: true })
    await $.classic.SessionStart({ source: 'startup', transcript_path: TRANSCRIPT } as never)
    const result = await $.prompt.attachment({ type: 'todo_reminder', text: 'x' } as never)
    expect(result.text).toBe(null)
  })
})

describe('config file location', () => {
  test('on Windows, where HOME is unset, the user file is read from USERPROFILE', async ($, on) => {
    // (The test engine runs on Linux, where C:\\ is not an absolute path, so a POSIX path stands in.)
    const files = { '/users/me/.claude/customer-mask.json': JSON.stringify({ customers: ['Zephyr Cargo ApS'] }) }
    world(on, { files, env: { USERPROFILE: '/users/me' } })
    expect(JSON.stringify((await appendPrompt($, 'Zephyr Cargo ApS')).message?.content)).not.toContain('Zephyr')
  })
})

describe('aliases and glued names in a session', () => {
  test('a customer alias and a glued host name are masked before the model sees them', async ($, on) => {
    const config = JSON.stringify({ customers: [{ name: 'LEGO A/S', aliases: ['DUPLO'] }] })
    world(on, { files: { '/proj/.claude/customer-mask.json': config } })
    const stored = JSON.stringify((await appendPrompt($, 'DUPLO stock, see legogroup.com')).message?.content)
    expect(stored).not.toMatch(/duplo|lego/i)
  })
})

describe('Claude Code version', () => {
  test('an older Claude Code blocks every request', async ($, on) => {
    const seen = world(on, { version: '2.1.290' })
    const chunks = await collect($.turn.step({ turnId: 't', index: 0, model: 'claude', messageCount: 1 }))
    expect(seen.requestSent).toBe(false)
    expect(textOf(chunks)).toContain('older than')
  })

  test('the tested version and newer ones run', async ($, on) => {
    const seen = world(on, { version: '2.2.0-dev.20261101.t000000.shaabcdef' })
    await collect($.turn.step({ turnId: 't', index: 0, model: 'claude', messageCount: 1 }))
    expect(seen.requestSent).toBe(true)
  })
})

describe('incoming: turn.step', () => {
  test('the streamed reply shows real values, even with placeholders split across chunks', async ($, on) => {
    let m = ''
    world(on, {
      reply: () => [
        { kind: 'text', index: 0, text: 'Shipment <' + '<SHIP' },
        { kind: 'text', index: 0, text: `MENT_1.${m.slice(0, 2)}` },
        { kind: 'text', index: 0, text: `${m.slice(2)}>` + '> for <' },
        { kind: 'text', index: 0, text: `<CUSTOMER_1.${m}>` + '> is delayed.' },
        { kind: 'stop', stopReason: 'end_turn', usage: null },
      ],
    })
    m = markerIn(JSON.stringify((await appendPrompt($, 'Status of SHP12345678 for Acme Freight A/S?')).message?.content))

    const chunks = await collect($.turn.step({ turnId: 't', index: 0, model: 'claude', messageCount: 1 }))
    expect(textOf(chunks)).toBe('Shipment SHP12345678 for Acme Freight A/S is delayed.')
    expect(chunks.at(-1)?.kind).toBe('stop')
  })

  test('a recorded reply is masked again before it is stored', async ($, on) => {
    world(on)
    const m = markerIn(JSON.stringify((await appendPrompt($, 'Acme Freight A/S')).message?.content))
    const stored = await $.session.append({
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Acme Freight A/S is fine.' }] },
      door: 'response',
      origin: { kind: 'model', model: 'claude' },
      uuid: 'u3',
    } as never)
    expect(JSON.stringify(stored.message?.content)).toContain(`${ph('CUSTOMER', 1, m)} is fine.`)
  })

  test('a broken config file blocks every request instead of leaking', async ($, on) => {
    const seen = world(on, { files: { '/proj/.claude/customer-mask.json': '{ not json' } })
    const chunks = await collect($.turn.step({ turnId: 't', index: 0, model: 'claude', messageCount: 1 }))
    expect(seen.requestSent).toBe(false)
    expect(textOf(chunks)).toContain('stopped this request')
  })
})

describe('resumed sessions', () => {
  test('a new customer never reuses a placeholder number from the resumed transcript', async ($, on) => {
    world(on, { history: [{ role: 'user', text: `old: ${ph('CUSTOMER', 1)} ${ph('CUSTOMER', 2)}`, toolUses: [] }] })
    const stored = await appendPrompt($, 'Acme Freight A/S')
    const text = JSON.stringify(stored.message?.content)
    expect(text).toContain(ph('CUSTOMER', 3, markerIn(text)))
  })
})

describe('per-session marker', () => {
  test('text that only looks like a placeholder is never restored', async ($, on) => {
    const seen = world(on)
    const m = markerIn(JSON.stringify((await appendPrompt($, 'Acme Freight A/S')).message?.content))
    const other = m === 'zzzz' ? 'yyyy' : 'zzzz'
    const command = `printf '%s %s %s' '${ph('CUSTOMER', 1)}' '${ph('CUSTOMER', 1, other)}' '${ph('CUSTOMER', 1, m)}'`
    await $.tool.call({ tool: 'Bash', command } as never)
    expect(seen.ran).toBe(`printf '%s %s %s' '${ph('CUSTOMER', 1)}' '${ph('CUSTOMER', 1, other)}' 'Acme Freight A/S'`)
  })

  test('the system prompt note shows placeholders in this session\'s form', async ($, on) => {
    world(on)
    const m = markerIn(JSON.stringify((await appendPrompt($, 'Acme Freight A/S')).message?.content))
    const { sections } = await $.prompt.compose({
      model: 'claude', promptModel: 'claude', surfaces: [], tools: [], outputStyle: null, traits: [],
    })
    expect(sections.at(-1)?.text).toContain(ph('CUSTOMER', 1, m))
  })
})

describe('tool calls', () => {
  test('placeholders in tool arguments are restored before the tool runs', async ($, on) => {
    const seen = world(on)
    const m = markerIn(JSON.stringify((await appendPrompt($, 'Track SHP12345678 for Acme Freight A/S')).message?.content))

    await $.tool.call({ tool: 'Bash', command: `track --id ${ph('SHIPMENT', 1, m)} --customer "${ph('CUSTOMER', 1, m)}"` } as never)
    expect(seen.ran).toBe('track --id SHP12345678 --customer "Acme Freight A/S"')
  })
})

describe('tools that send data off the machine', () => {
  test('WebSearch keeps its placeholders by default', async ($, on) => {
    const seen = world(on)
    const m = markerIn(JSON.stringify((await appendPrompt($, 'Acme Freight A/S')).message?.content))
    await $.tool.call({ tool: 'WebSearch', query: `news about ${ph('CUSTOMER', 1, m)}` } as never)
    expect(seen.ran).toBe(`news about ${ph('CUSTOMER', 1, m)}`)
  })

  test('maskedTools in the config replaces the default list', async ($, on) => {
    const config = JSON.stringify({ customers: ['Acme Freight A/S'], maskedTools: [] })
    const seen = world(on, { files: { '/proj/.claude/customer-mask.json': config } })
    const m = markerIn(JSON.stringify((await appendPrompt($, 'Acme Freight A/S')).message?.content))
    await $.tool.call({ tool: 'WebSearch', query: `news about ${ph('CUSTOMER', 1, m)}` } as never)
    expect(seen.ran).toBe('news about Acme Freight A/S')
  })
})

const IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }
const PDF = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } }

describe('images and PDFs', () => {
  test('an image a tool returns is replaced with a note', async ($, on) => {
    world(on)
    const stored = await $.session.append({
      message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [IMAGE] }] },
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Read' },
      uuid: 'm1',
    } as never)
    const text = JSON.stringify(stored.message?.content)
    expect(text).not.toContain('"image"')
    expect(text).toContain('customer-mask removed an image or PDF')
  })

  test('an image or PDF pasted into a prompt is dropped and the prompt text notes it', async ($, on) => {
    world(on)
    const stored = await $.session.append({
      message: { type: 'user', role: 'user', content: [IMAGE, PDF, { type: 'text', text: 'What does this say?' }] },
      door: 'prompt',
      origin: { kind: 'user' },
      uuid: 'm2',
    } as never)
    const blocks = stored.message?.content ?? []
    expect(blocks.map(b => b.type)).toEqual(['text'])
    expect(String(blocks[0]?.text)).toContain('What does this say?')
    expect(String(blocks[0]?.text)).toContain('customer-mask removed an image or PDF')
  })

  test('media: "allow" sends them through', async ($, on) => {
    const config = JSON.stringify({ customers: ['Acme Freight A/S'], media: 'allow' })
    world(on, { files: { '/proj/.claude/customer-mask.json': config } })
    const stored = await $.session.append({
      message: { type: 'user', role: 'user', content: [IMAGE, { type: 'text', text: 'hi' }] },
      door: 'prompt',
      origin: { kind: 'user' },
      uuid: 'm3',
    } as never)
    expect((stored.message?.content ?? []).map(b => b.type)).toEqual(['image', 'text'])
  })

  test('an invalid media value blocks the session', async ($, on) => {
    const config = JSON.stringify({ media: 'sometimes' })
    const seen = world(on, { files: { '/proj/.claude/customer-mask.json': config } })
    const chunks = await collect($.turn.step({ turnId: 't', index: 0, model: 'claude', messageCount: 1 }))
    expect(seen.requestSent).toBe(false)
    expect(textOf(chunks)).toContain('media must be')
  })
})

describe('MCP tools', () => {
  test('an MCP tool keeps its placeholders by default', async ($, on) => {
    const seen = world(on)
    const m = markerIn(JSON.stringify((await appendPrompt($, 'Acme Freight A/S')).message?.content))
    await $.tool.call({ tool: 'mcp__slack__post_message', text: `about ${ph('CUSTOMER', 1, m)}` } as never)
    expect(seen.ran).toBe(`about ${ph('CUSTOMER', 1, m)}`)
  })

  test('a tool listed in unmaskedTools gets real values', async ($, on) => {
    const config = JSON.stringify({ customers: ['Acme Freight A/S'], unmaskedTools: ['mcp__local_db__*'] })
    const seen = world(on, { files: { '/proj/.claude/customer-mask.json': config } })
    const m = markerIn(JSON.stringify((await appendPrompt($, 'Acme Freight A/S')).message?.content))
    await $.tool.call({ tool: 'mcp__local_db__query', text: `where name = '${ph('CUSTOMER', 1, m)}'` } as never)
    expect(seen.ran).toBe("where name = 'Acme Freight A/S'")
  })
})

describe('session title', () => {
  test('the title is set from the masked prompt, so the stored title holds no customer data', async ($, on) => {
    world(on)
    const result = await $.classic.UserPromptSubmit({ prompt: 'Apology to Acme Freight A/S for SHP12345678' } as never)
    const m = markerIn(String(result.sessionTitle))
    expect(result.sessionTitle).toBe(`Apology to ${ph('CUSTOMER', 1, m)} for ${ph('SHIPMENT', 1, m)}`)
  })
})

describe('system prompt', () => {
  test('explains the placeholders and masks per-session sections', async ($, on) => {
    world(on, {
      sections: [
        { id: 'intro', text: 'You are Claude Code.', scope: 'shared' },
        { id: 'env', text: 'Branch: fix/acme-freight-a-s; repo of Acme Freight A/S', scope: 'session' },
      ],
    })
    await appendPrompt($, 'Acme Freight A/S')
    const { sections } = await $.prompt.compose({
      model: 'claude',
      promptModel: 'claude',
      surfaces: [],
      tools: [],
      outputStyle: null,
      traits: [],
    })
    expect(sections.find(s => s.id === 'intro')?.text).toBe('You are Claude Code.')
    const env = sections.find(s => s.id === 'env')?.text ?? ''
    expect(env).toContain(`repo of ${ph('CUSTOMER', 1, markerIn(env))}`)
    expect(sections.at(-1)?.id).toBe('customer-mask:note')
  })
})

/** A config like CONFIG with NER detection settings added. */
const nerConfig = (extra: Record<string, unknown>) =>
  JSON.stringify({ ...(JSON.parse(CONFIG) as object), ...extra })

/**
 * A stand-in for the local NER server, beneath the plugin: answers /health,
 * and on /detect finds each of `names` (with its label) in every text it gets.
 */
function nerServer(on: On, names: Record<string, string>, w: { down?: boolean; slowMs?: number } = {}) {
  const clock = mock.clock(on)
  const seen = { detects: 0, texts: [] as string[] }
  const answer = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
  on('http.fetch', async ($, e) => {
    if (w.down) return { deny: 'connect ECONNREFUSED 127.0.0.1:8765' }
    if (e.url.endsWith('/health')) return answer({ ok: true })
    seen.detects += 1
    const { texts } = JSON.parse(e.init?.body ?? '{}') as { texts: string[] }
    seen.texts.push(...texts)
    if (w.slowMs) await clock.sleep(w.slowMs)
    return answer({
      results: texts.map(t =>
        Object.entries(names)
          .filter(([n]) => t.includes(n))
          .map(([n, label]) => ({ text: n, label, score: 0.9 })),
      ),
    })
  })
  return { seen, clock }
}

const NER_FILE = (extra: Record<string, unknown>) => ({ '/proj/.claude/customer-mask.json': nerConfig(extra) })

describe('NER detection', () => {
  test('detection "ner": names the model finds are masked, the list is not used, patterns still are', async ($, on) => {
    world(on, { files: NER_FILE({ detection: 'ner' }) })
    nerServer(on, { 'Nordlys Trading': 'company', 'Lars Holm': 'person' })
    const stored = await appendPrompt($, 'Lars Holm at Nordlys Trading asks about SHP12345678 and Acme Freight A/S')
    const text = JSON.stringify(stored.message?.content)
    const m = markerIn(text)
    expect(text).not.toContain('Nordlys')
    expect(text).not.toContain('Lars Holm')
    expect(text).toContain(`${ph('PERSON', 1, m)} at ${ph('CUSTOMER', 1, m)}`)
    expect(text).toContain(ph('SHIPMENT', 1, m))
    // Not found by the model, and the list is off in this mode.
    expect(text).toContain('Acme Freight A/S')
  })

  test('detection "both": the list and the model together', async ($, on) => {
    world(on, { files: NER_FILE({ detection: 'both' }) })
    nerServer(on, { 'Nordlys Trading': 'company' })
    const stored = await appendPrompt($, 'Acme Freight A/S and Nordlys Trading')
    const text = JSON.stringify(stored.message?.content)
    expect(text).not.toContain('Acme')
    expect(text).not.toContain('Nordlys')
  })

  test('"list" (the default) never calls the NER server', async ($, on) => {
    world(on)
    const { seen } = nerServer(on, { 'Nordlys Trading': 'company' })
    const stored = await appendPrompt($, 'Nordlys Trading')
    expect(JSON.stringify(stored.message?.content)).toContain('Nordlys Trading')
    expect(seen.detects).toBe(0)
  })

  test('a value found once stays masked where the model is not asked (scope "prompts")', async ($, on) => {
    world(on, { files: NER_FILE({ detection: 'ner', ner: { scope: 'prompts' } }) })
    const { seen } = nerServer(on, { 'Nordlys Trading': 'company' })
    await appendPrompt($, 'Check Nordlys Trading')
    const stored = await $.session.append({
      message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'NORDLYS TRADING,42' }] },
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Read' },
      uuid: 'u2',
    } as never)
    const text = JSON.stringify(stored.message?.content)
    expect(text).not.toMatch(/nordlys/i)
    expect(seen.texts).toEqual(['Check Nordlys Trading'])
  })

  test('real values come back in tool calls; the table records what the model found', async ($, on) => {
    const seen = world(on, { files: NER_FILE({ detection: 'ner' }) })
    nerServer(on, { 'Nordlys Trading': 'company' })
    await $.classic.SessionStart({ source: 'startup', transcript_path: TRANSCRIPT } as never)
    const stored = await appendPrompt($, 'Nordlys Trading')
    const m = markerIn(JSON.stringify(stored.message?.content))
    await $.tool.call({ tool: 'Bash', command: `echo ${ph('CUSTOMER', 1, m)}` } as never)
    expect(seen.ran).toBe('echo Nordlys Trading')
    const saved = JSON.parse(seen.writes[VAULT_FILE] ?? '{}')
    expect(saved.entries).toEqual([{ token: 'CUSTOMER_1', value: 'Nordlys Trading', label: 'CUSTOMER', source: 'ner' }])
  })

  test('words on the ignore list are left alone', async ($, on) => {
    world(on, { files: NER_FILE({ detection: 'ner', ner: { ignore: ['kubernetes'] } }) })
    nerServer(on, { Kubernetes: 'company', Bash: 'person', 'Nordlys Trading': 'company' })
    const stored = await appendPrompt($, 'Kubernetes and Bash for Nordlys Trading')
    const text = JSON.stringify(stored.message?.content)
    // Kubernetes is on this config's list; Bash is one of Claude Code's own words, always left alone.
    expect(text).toContain('Kubernetes and Bash for')
    expect(text).not.toContain('Nordlys')
  })

  test('the same text is sent to the server once (the system prompt, every request)', async ($, on) => {
    world(on, {
      files: NER_FILE({ detection: 'ner' }),
      sections: [{ id: 'env', text: 'Repo of Nordlys Trading', scope: 'session' }],
    })
    const { seen } = nerServer(on, { 'Nordlys Trading': 'company' })
    const input = { model: 'claude', promptModel: 'claude', surfaces: [], tools: [], outputStyle: null, traits: [] }
    await $.prompt.compose(input)
    const { sections } = await $.prompt.compose(input)
    expect(sections.find(s => s.id === 'env')?.text).not.toContain('Nordlys')
    expect(seen.detects).toBe(1)
  })
})

describe('NER failing closed', () => {
  test('a server that does not answer at start blocks every request', async ($, on) => {
    const seen = world(on, { files: NER_FILE({ detection: 'ner' }) })
    nerServer(on, {}, { down: true })
    const chunks = await collect($.turn.step({ turnId: 't', index: 0 } as never))
    expect(textOf(chunks)).toContain('NER server at http://127.0.0.1:8765 does not answer')
    expect(seen.requestSent).toBe(false)
  })

  test('a call that takes longer than ner.timeoutMs removes the row instead of storing it unmasked', async ($, on) => {
    world(on, { files: NER_FILE({ detection: 'ner', ner: { timeoutMs: 1000 } }) })
    const { clock } = nerServer(on, { 'Nordlys Trading': 'company' }, { slowMs: 5000 })
    const pending = appendPrompt($, 'Nordlys Trading')
    await clock.advance(1500)
    const stored = await pending
    const text = JSON.stringify(stored.message?.content)
    expect(text).not.toContain('Nordlys')
    expect(text).toContain('could not check this content')
  })

  test('a bad NER setting blocks the session with the reason', async ($, on) => {
    world(on, { files: NER_FILE({ detection: 'ner', ner: { timeoutMs: 20000 } }) })
    nerServer(on, {})
    const chunks = await collect($.turn.step({ turnId: 't', index: 0 } as never))
    expect(textOf(chunks)).toContain('ner.timeoutMs must be from 100 to 8000')
  })

  test('an unknown detection mode blocks the session with the reason', async ($, on) => {
    world(on, { files: NER_FILE({ detection: 'ai' }) })
    const chunks = await collect($.turn.step({ turnId: 't', index: 0 } as never))
    expect(textOf(chunks)).toContain('detection must be "list", "ner" or "both"')
  })
})

describe('prompt cache: the system prompt stays the same', () => {
  test('a customer in the system prompt gets no hint there, so every build is identical; the hint goes to the first row', async ($, on) => {
    const config = JSON.stringify({ customers: [{ name: 'Acme Freight A/S', hint: 'Danish freight forwarder' }] })
    world(on, {
      files: { '/proj/.claude/customer-mask.json': config },
      sections: [{ id: 'env', text: 'Branch: main; repo of Acme Freight A/S', scope: 'session' }],
    })
    const input = { model: 'claude', promptModel: 'claude', surfaces: [], tools: [], outputStyle: null, traits: [] }
    const first = (await $.prompt.compose(input)).sections.find(s => s.id === 'env')?.text ?? ''
    const second = (await $.prompt.compose(input)).sections.find(s => s.id === 'env')?.text ?? ''
    expect(first).toBe(second)
    expect(first).not.toContain('hint')
    expect(first).not.toContain('Acme')
    const stored = await appendPrompt($, 'Status for Acme Freight A/S?')
    expect(JSON.stringify(stored.message?.content)).toContain('[hint: Danish freight forwarder]')
  })
})
