import { describe, expect, test } from 'claude-code/testing'

import {
  buildRules,
  DEFAULT_MASKED_TOOLS,
  mask,
  newMarker,
  StreamUnmasker,
  toolPolicy,
  unmask,
  unmaskDeep,
  Vault,
} from '../hooks/masker'

/** Builds a placeholder at run time, so no literal token sits in this file. */
const ph = (label: string, n: number, marker = '') =>
  marker ? `<<${label}_${n}.${marker}>>` : `<<${label}_${n}>>`

const config = {
  customers: ['Acme Freight A/S', 'Nordic Widgets'],
  patterns: [{ label: 'shipment', regex: '\\bSHP\\d{8}\\b' }],
}

describe('mask / unmask', () => {
  test('replaces customers, emails, phones, IBAN, CPR and custom IDs, and restores them', () => {
    const rules = buildRules(config)
    const vault = new Vault()
    const input =
      'Acme Freight A/S (ops@acme-freight.dk, +45 12 34 56 78) shipment SHP12345678 ' +
      'pays from DK50 0040 0440 1162 43. Contact CPR 010190-1234. nordic widgets is cc.'

    const masked = mask(input, rules, vault)

    expect(masked).not.toContain('Acme')
    expect(masked).not.toContain('ops@acme-freight.dk')
    expect(masked).not.toContain('12 34 56 78')
    expect(masked).not.toContain('SHP12345678')
    expect(masked).not.toContain('DK50')
    expect(masked).not.toContain('010190-1234')
    expect(masked.toLowerCase()).not.toContain('nordic widgets')
    expect(masked).toContain('<<CUSTOMER_1>>')
    expect(masked).toContain('<<EMAIL_1>>')
    expect(masked).toContain('<<SHIPMENT_1>>')

    expect(unmask(masked, vault)).toBe(input)
  })

  test('the same value always gets the same placeholder, across calls and case', () => {
    const rules = buildRules(config)
    const vault = new Vault()
    const a = mask('Acme Freight A/S', rules, vault)
    const b = mask('ACME FREIGHT A/S and Acme Freight A/S', rules, vault)
    expect(a).toBe('<<CUSTOMER_1>>')
    expect(b).toBe('<<CUSTOMER_1>> and <<CUSTOMER_1>>')
  })

  test('masking is idempotent: placeholders are never masked again', () => {
    const rules = buildRules({ customers: ['Customer'] })
    const vault = new Vault()
    const once = mask('Customer here', rules, vault)
    expect(mask(once, rules, vault)).toBe(once)
  })

  test('customer names match whole words only', () => {
    const rules = buildRules({ customers: ['Lego'] })
    const vault = new Vault()
    expect(mask('Legolas met Lego.', rules, vault)).toBe('Legolas met <<CUSTOMER_1>>.')
  })

  test('ordinary code and numbers are left alone', () => {
    const rules = buildRules(config)
    const vault = new Vault()
    const code = 'const ts = 1728590400123; for (let i = 0; i < 10; i++) a[i] = i << 2;'
    expect(mask(code, rules, vault)).toBe(code)
  })

  test('detectors can be switched off', () => {
    const rules = buildRules({ detectors: { email: false } })
    const vault = new Vault()
    expect(mask('mail a@b.dk', rules, vault)).toBe('mail a@b.dk')
  })

  test('reserved numbers from a resumed transcript are never reused', () => {
    const rules = buildRules(config)
    const vault = new Vault()
    vault.reserve(`earlier: ${ph('CUSTOMER', 1)} and ${ph('CUSTOMER', 4)}, ${ph('EMAIL', 2)}`)
    expect(mask('Nordic Widgets', rules, vault)).toBe('<<CUSTOMER_5>>')
    expect(mask('a@b.dk', rules, vault)).toBe('<<EMAIL_3>>')
  })

  test('unknown placeholders are left as written', () => {
    expect(unmask('see <<CUSTOMER_9>>', new Vault())).toBe('see <<CUSTOMER_9>>')
  })

  test('unmaskDeep restores nested strings and skips envelope keys', () => {
    const rules = buildRules(config)
    const vault = new Vault()
    const token = mask('Nordic Widgets', rules, vault)
    const out = unmaskDeep({ tool: token, args: { list: [token, 3] } }, vault, new Set(['tool']))
    expect(out).toEqual({ tool: token, args: { list: ['Nordic Widgets', 3] } })
  })
})

describe('StreamUnmasker', () => {
  test('restores a placeholder split across many pieces', () => {
    const rules = buildRules(config)
    const vault = new Vault()
    mask('Acme Freight A/S', rules, vault)
    const s = new StreamUnmasker(vault)
    const pieces = ['Hello <', '<CUST', 'OMER', '_1', '>', '> and a < b', ' done']
    const out = pieces.map(p => s.push(p)).join('') + s.flush()
    expect(out).toBe('Hello Acme Freight A/S and a < b done')
  })

  test('never holds back more than a placeholder could need', () => {
    const s = new StreamUnmasker(new Vault())
    expect(s.push('plain text')).toBe('plain text')
    expect(s.push(' x <<NOT A TOKEN')).toBe(' x <<NOT A TOKEN')
  })
})

describe('toolPolicy', () => {
  test('web tools and every MCP tool keep placeholders by default', () => {
    const keeps = toolPolicy(DEFAULT_MASKED_TOOLS, [])
    expect(keeps('WebSearch')).toBe(true)
    expect(keeps('WebFetch')).toBe(true)
    expect(keeps('mcp__slack__post_message')).toBe(true)
    expect(keeps('Bash')).toBe(false)
    expect(keeps('Edit')).toBe(false)
  })

  test('unmaskedTools exceptions win, with wildcards', () => {
    const keeps = toolPolicy(DEFAULT_MASKED_TOOLS, ['mcp__local_db__*'])
    expect(keeps('mcp__local_db__query')).toBe(false)
    expect(keeps('mcp__slack__post_message')).toBe(true)
  })

  test('patterns are matched whole and literally apart from *', () => {
    const keeps = toolPolicy(['mcp__a.b__*'], [])
    expect(keeps('mcp__a.b__x')).toBe(true)
    expect(keeps('mcp__aXb__x')).toBe(false)
    expect(keeps('xmcp__a.b__x')).toBe(false)
  })
})

describe('per-session marker', () => {
  test('newMarker is four lowercase letters or digits, and varies', () => {
    const seen = new Set(Array.from({ length: 20 }, () => newMarker()))
    for (const m of seen) expect(m).toMatch(/^[a-z0-9]{4}$/)
    expect(seen.size).toBeGreaterThan(1)
  })

  test('a marked vault writes and restores its own form only', () => {
    const vault = new Vault('k3f9')
    const masked = mask('Nordic Widgets', buildRules(config), vault)
    expect(masked).toBe(ph('CUSTOMER', 1, 'k3f9'))
    expect(unmask(masked, vault)).toBe('Nordic Widgets')
    expect(unmask(ph('CUSTOMER', 1), vault)).toBe(ph('CUSTOMER', 1))
    expect(unmask(ph('CUSTOMER', 1, 'aaaa'), vault)).toBe(ph('CUSTOMER', 1, 'aaaa'))
  })

  test('placeholders from another session are not masked again', () => {
    const vault = new Vault('k3f9')
    const text = `see ${ph('CUSTOMER', 7, 'aaaa')}`
    expect(mask(text, buildRules({ customers: ['CUSTOMER'] }), vault)).toBe(text)
  })

  test('the stream unmasker restores a marked placeholder split anywhere', () => {
    const vault = new Vault('k3f9')
    mask('Acme Freight A/S', buildRules(config), vault)
    const whole = `Hi ${ph('CUSTOMER', 1, 'k3f9')}!`
    for (let cut = 1; cut < whole.length; cut++) {
      const s = new StreamUnmasker(vault)
      const out = s.push(whole.slice(0, cut)) + s.push(whole.slice(cut)) + s.flush()
      expect(out).toBe('Hi Acme Freight A/S!')
    }
  })
})
