import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnStepChunk } from 'claude-code'

/** Builds a placeholder at run time, so no literal token sits in this file. */
const ph = (label: string, n: number) => `<<${label}_${n}>>`

const CONFIG = JSON.stringify({
  customers: ['Acme Freight A/S'],
  patterns: [{ label: 'SHIPMENT', regex: '\\bSHP\\d{8}\\b' }],
})

type World = {
  files?: Record<string, string>
  reply?: TurnStepChunk[]
  sections?: { id: string; text: string; scope: 'shared' | 'session' }[]
  history?: { role: 'user' | 'assistant'; text: string; toolUses: never[] }[]
}

/**
 * The world beneath the plugin, registered before the first call on `$`: a
 * project folder holding the config file, a model that streams `reply`, a
 * Bash tool that records what it was asked to run, and a system prompt.
 */
function world(on: On, w: World = {}) {
  const files = w.files ?? { '/proj/.claude/customer-mask.json': CONFIG }
  const seen = { requestSent: false, ran: '' }

  mock.env(on, { HOME: '/home/u' })
  on('session.cwd', () => ({ value: '/proj' }))
  on('fs.read', ($, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('ui.status', () => ({ value: undefined }))
  on('turn.step', async function* () {
    seen.requestSent = true
    for (const c of w.reply ?? []) yield c
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
  on('session.messages', () => ({ value: w.history ?? [] }))
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
    expect(text).toContain('<<CUSTOMER_1>>')
    expect(text).toContain('<<SHIPMENT_1>>')
    expect(text).toContain('<<EMAIL_1>>')
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

describe('incoming: turn.step', () => {
  test('the streamed reply shows real values, even with placeholders split across chunks', async ($, on) => {
    world(on, {
      reply: [
        { kind: 'text', index: 0, text: 'Shipment <<SHIP' },
        { kind: 'text', index: 0, text: 'MENT_1>> for <' },
        { kind: 'text', index: 0, text: '<CUSTOMER_1>> is delayed.' },
        { kind: 'stop', stopReason: 'end_turn', usage: null },
      ],
    })
    await appendPrompt($, 'Status of SHP12345678 for Acme Freight A/S?')

    const chunks = await collect($.turn.step({ turnId: 't', index: 0, model: 'claude', messageCount: 1 }))
    expect(textOf(chunks)).toBe('Shipment SHP12345678 for Acme Freight A/S is delayed.')
    expect(chunks.at(-1)?.kind).toBe('stop')
  })

  test('a recorded reply is masked again before it is stored', async ($, on) => {
    world(on)
    await appendPrompt($, 'Acme Freight A/S')
    const stored = await $.session.append({
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Acme Freight A/S is fine.' }] },
      door: 'response',
      origin: { kind: 'model', model: 'claude' },
      uuid: 'u3',
    } as never)
    expect(JSON.stringify(stored.message?.content)).toContain('<<CUSTOMER_1>> is fine.')
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
    world(on, { history: [{ role: 'user', text: 'old: <<CUSTOMER_1>> <<CUSTOMER_2>>', toolUses: [] }] })
    const stored = await appendPrompt($, 'Acme Freight A/S')
    expect(JSON.stringify(stored.message?.content)).toContain('<<CUSTOMER_3>>')
  })
})

describe('tool calls', () => {
  test('placeholders in tool arguments are restored before the tool runs', async ($, on) => {
    const seen = world(on)
    await appendPrompt($, 'Track SHP12345678 for Acme Freight A/S')

    await $.tool.call({ tool: 'Bash', command: 'track --id <<SHIPMENT_1>> --customer "<<CUSTOMER_1>>"' } as never)
    expect(seen.ran).toBe('track --id SHP12345678 --customer "Acme Freight A/S"')
  })
})

describe('tools that send data off the machine', () => {
  test('WebSearch keeps its placeholders by default', async ($, on) => {
    const seen = world(on)
    await appendPrompt($, 'Acme Freight A/S')
    await $.tool.call({ tool: 'WebSearch', query: 'news about <<CUSTOMER_1>>' } as never)
    expect(seen.ran).toBe('news about <<CUSTOMER_1>>')
  })

  test('maskedTools in the config replaces the default list', async ($, on) => {
    const config = JSON.stringify({ customers: ['Acme Freight A/S'], maskedTools: [] })
    const seen = world(on, { files: { '/proj/.claude/customer-mask.json': config } })
    await appendPrompt($, 'Acme Freight A/S')
    await $.tool.call({ tool: 'WebSearch', query: 'news about <<CUSTOMER_1>>' } as never)
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
    await appendPrompt($, 'Acme Freight A/S')
    await $.tool.call({ tool: 'mcp__slack__post_message', text: `about ${ph('CUSTOMER', 1)}` } as never)
    expect(seen.ran).toBe(`about ${ph('CUSTOMER', 1)}`)
  })

  test('a tool listed in unmaskedTools gets real values', async ($, on) => {
    const config = JSON.stringify({ customers: ['Acme Freight A/S'], unmaskedTools: ['mcp__local_db__*'] })
    const seen = world(on, { files: { '/proj/.claude/customer-mask.json': config } })
    await appendPrompt($, 'Acme Freight A/S')
    await $.tool.call({ tool: 'mcp__local_db__query', text: `where name = '${ph('CUSTOMER', 1)}'` } as never)
    expect(seen.ran).toBe("where name = 'Acme Freight A/S'")
  })
})

describe('session title', () => {
  test('the title is set from the masked prompt, so the stored title holds no customer data', async ($, on) => {
    world(on)
    const result = await $.classic.UserPromptSubmit({ prompt: 'Apology to Acme Freight A/S for SHP12345678' } as never)
    expect(result.sessionTitle).toBe('Apology to <<CUSTOMER_1>> for <<SHIPMENT_1>>')
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
    expect(sections.find(s => s.id === 'env')?.text).toContain('repo of <<CUSTOMER_1>>')
    expect(sections.at(-1)?.id).toBe('customer-mask:note')
  })
})
