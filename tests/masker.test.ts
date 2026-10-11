import { describe, expect, test } from 'claude-code/testing'

import { buildRules, mask, StreamUnmasker, unmask, unmaskDeep, Vault } from '../hooks/masker'

/** Builds a placeholder at run time, so no literal token sits in this file. */
const ph = (label: string, n: number) => `<<${label}_${n}>>`

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
