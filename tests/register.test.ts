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

  mock.env(on, { HOME: '/home/u' })
  on('session.cwd', () => ({ value: '/proj' }))
  on('fs.read', ($, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('fs.write', ($, e) => {
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
