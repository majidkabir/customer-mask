import { describe, expect, test } from 'claude-code/testing'

import {
  buildRules,
  cleanTranscript,
  compareVersions,
  DEFAULT_MASKED_TOOLS,
  hideKnownValues,
  mask,
  newMarker,
  parseVaultFile,
  StreamUnmasker,
  toolPolicy,
  unmask,
  unmaskDeep,
  Vault,
  vaultFileFor,
} from '../hooks/masker'

/** Builds a placeholder at run time, so no literal token sits in this file. */
const ph = (label: string, n: number | string, marker = '') =>
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

  test('the same spelling always gets the same placeholder; other spellings share its number', () => {
    const rules = buildRules(config)
    const vault = new Vault()
    expect(mask('Acme Freight A/S', rules, vault)).toBe(ph('CUSTOMER', 1))
    const b = mask('ACME FREIGHT A/S and Acme Freight A/S', rules, vault)
    expect(b).toBe(`${ph('CUSTOMER', '1-2')} and ${ph('CUSTOMER', 1)}`)
    expect(unmask(b, vault)).toBe('ACME FREIGHT A/S and Acme Freight A/S')
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

describe('customer name variants', () => {
  const rules = buildRules({ customers: ['Acme Freight A/S'] })
  const masks = (text: string) => mask(text, rules, new Vault())

  test('matches without, or with another, legal suffix', () => {
    expect(masks('Acme Freight is late')).toBe(`${ph('CUSTOMER', 1)} is late`)
    expect(masks('Acme Freight ApS')).toBe(ph('CUSTOMER', 1))
    expect(masks('Acme Freight GmbH')).toBe(ph('CUSTOMER', 1))
    expect(masks('Acme Freight, Inc.')).toBe(ph('CUSTOMER', 1))
    expect(masks('Acme Freight AS')).toBe(ph('CUSTOMER', 1))
  })

  test('matches other separators and case', () => {
    expect(masks('acme-freight')).toBe(ph('CUSTOMER', 1))
    expect(masks('ACME.FREIGHT')).toBe(ph('CUSTOMER', 1))
    expect(masks('AcmeFreight')).toBe(ph('CUSTOMER', 1))
    expect(masks('acme_freight_id')).toBe(`${ph('CUSTOMER', 1)}_id`)
  })

  test('a two-letter suffix in the wrong case is an ordinary word and stays', () => {
    expect(masks('Acme Freight as well')).toBe(`${ph('CUSTOMER', 1)} as well`)
    expect(masks('Acme Freight co-signed')).toBe(`${ph('CUSTOMER', 1)} co-signed`)
  })

  test('whole words only', () => {
    expect(masks('AcmeFreightClient')).toBe('AcmeFreightClient')
    expect(masks('MegaAcme Freight')).toBe('MegaAcme Freight')
  })

  test('all spellings are one customer and each is restored exactly', () => {
    const vault = new Vault()
    const text = 'Acme Freight A/S, acme-freight and ACME FREIGHT'
    const masked = mask(text, rules, vault)
    expect(masked).toBe(`${ph('CUSTOMER', 1)}, ${ph('CUSTOMER', '1-2')} and ${ph('CUSTOMER', '1-3')}`)
    expect(unmask(masked, vault)).toBe(text)
  })

  test('a name whose core would be too short is matched only as listed', () => {
    const r = buildRules({ customers: ['AB A/S'] })
    expect(mask('AB A/S', r, new Vault())).toBe(ph('CUSTOMER', 1))
    expect(mask('AB is a word', r, new Vault())).toBe('AB is a word')
  })

  test('nameVariants: false matches names only as listed', () => {
    const r = buildRules({ customers: ['Acme Freight A/S'], nameVariants: false })
    expect(mask('Acme Freight is late', r, new Vault())).toBe('Acme Freight is late')
    expect(mask('acme freight a/s', r, new Vault())).toBe(ph('CUSTOMER', 1))
  })

  test('a vault restored after a reload keeps variants and numbering', () => {
    const v1 = new Vault('k3f9')
    mask('Acme Freight A/S and ACME FREIGHT', rules, v1)
    const v2 = new Vault('k3f9')
    v2.load(v1.entries(), rules)
    expect(mask('Acme Freight', rules, v2)).toBe(ph('CUSTOMER', '1-3', 'k3f9'))
    expect(mask('ACME FREIGHT', rules, v2)).toBe(ph('CUSTOMER', '1-2', 'k3f9'))
    expect(mask('Nordic Widgets', buildRules({ customers: ['Nordic Widgets'] }), v2)).toBe(ph('CUSTOMER', 2, 'k3f9'))
  })

  test('the stream unmasker handles variant tokens split anywhere', () => {
    const vault = new Vault('k3f9')
    mask('Acme Freight A/S and ACME FREIGHT', rules, vault)
    const whole = `x ${ph('CUSTOMER', '1-2', 'k3f9')} y`
    for (let cut = 1; cut < whole.length; cut++) {
      const s = new StreamUnmasker(vault)
      expect(s.push(whole.slice(0, cut)) + s.push(whole.slice(cut)) + s.flush()).toBe('x ACME FREIGHT y')
    }
  })
})

describe('compareVersions', () => {
  test('orders releases numerically and ignores build suffixes', () => {
    expect(compareVersions('2.1.296', '2.1.296')).toBe(0)
    expect(compareVersions('2.1.290', '2.1.296')).toBe(-1)
    expect(compareVersions('2.1.1000', '2.1.296')).toBe(1)
    expect(compareVersions('2.2.0-dev.20261101', '2.1.296')).toBe(1)
    expect(compareVersions('3', '2.9.9')).toBe(1)
  })
})

describe('vault file', () => {
  test('sits beside the transcript', () => {
    expect(vaultFileFor('/h/.claude/projects/-p/abc.jsonl')).toBe('/h/.claude/projects/-p/abc.customer-mask.json')
  })

  test('round-trips, and rejects anything else', () => {
    const data = { version: 1, marker: 'abcd', entries: [{ token: 'EMAIL_1', value: 'a@b.dk', label: 'EMAIL' }] }
    expect(parseVaultFile(JSON.stringify(data))).toEqual(data)
    expect(() => parseVaultFile('{"version":2,"marker":"x","entries":[]}')).toThrow()
    expect(() => parseVaultFile('{"version":1,"marker":"x","entries":[{"token":1}]}')).toThrow()
    expect(() => parseVaultFile('nope')).toThrow()
  })
})

describe('cleaning the transcript', () => {
  const vaultWith = () => {
    const v = new Vault('k3f9')
    mask('Acme Freight A/S SHP12345678', buildRules(config), v)
    return v
  }

  test('hideKnownValues replaces known values as whole words only', () => {
    const v = vaultWith()
    expect(hideKnownValues('Acme Freight A/S, SHP12345678; xSHP12345678', v)).toBe(
      `${ph('CUSTOMER', 1, 'k3f9')}, ${ph('SHIPMENT', 1, 'k3f9')}; xSHP12345678`,
    )
  })

  test('masks queue records and tool results; leaves paths, other lines and placeholders alone', () => {
    const v = vaultWith()
    const lines = [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'Why is SHP12345678 late?' }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: ph('CUSTOMER', 1, 'k3f9') }] },
        toolUseResult: { type: 'text', file: { filePath: '/p/Acme Freight A/S/x.csv', content: 'Acme Freight A/S,1' } },
      }),
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}',
      '',
    ]
    const { text, changedLines } = cleanTranscript(lines.join('\n'), v)
    const out = text.split('\n')
    expect(changedLines).toBe(2)
    expect(JSON.parse(out[0] ?? '').content).toBe(`Why is ${ph('SHIPMENT', 1, 'k3f9')} late?`)
    const tool = JSON.parse(out[1] ?? '').toolUseResult
    expect(tool.file.content).toBe(`${ph('CUSTOMER', 1, 'k3f9')},1`)
    expect(tool.file.filePath).toBe('/p/Acme Freight A/S/x.csv')
    expect(out[2]).toBe(lines[2])
    expect(out[3]).toBe('')
  })

  test('an empty vault changes nothing', () => {
    const line = JSON.stringify({ type: 'queue-operation', content: 'Acme Freight A/S' })
    expect(cleanTranscript(line, new Vault('k3f9'))).toEqual({ text: line, changedLines: 0 })
  })
})

describe('customer hints', () => {
  const rules = buildRules({ customers: [{ name: 'Acme Freight A/S', hint: 'Danish freight forwarder' }, 'Nordic Widgets'] })

  test('the hint follows the first placeholder of that customer only', () => {
    const v = new Vault('k3f9')
    const first = mask('Acme Freight A/S and Nordic Widgets', rules, v)
    expect(first).toBe(`${ph('CUSTOMER', 1, 'k3f9')} [hint: Danish freight forwarder] and ${ph('CUSTOMER', 2, 'k3f9')}`)
    expect(mask('Acme Freight A/S again, ACME FREIGHT too', rules, v)).toBe(
      `${ph('CUSTOMER', 1, 'k3f9')} again, ${ph('CUSTOMER', '1-2', 'k3f9')} too`,
    )
  })

  test('a copied hint is dropped when restoring; any other bracket stays', () => {
    const v = new Vault('k3f9')
    mask('Acme Freight A/S', rules, v)
    const p1 = ph('CUSTOMER', 1, 'k3f9')
    expect(unmask(`${p1} [hint: Danish freight forwarder],1`, v)).toBe('Acme Freight A/S,1')
    expect(unmask(`${p1} [hint: something else]`, v)).toBe('Acme Freight A/S [hint: something else]')
    expect(unmaskDeep({ command: `echo "${p1} [hint: Danish freight forwarder]"` }, v)).toEqual({ command: 'echo "Acme Freight A/S"' })
  })

  test('hints are saved with the vault and not shown again after a reload', () => {
    const v1 = new Vault('k3f9')
    mask('Acme Freight A/S', rules, v1)
    expect(v1.entries()[0]?.hint).toBe('Danish freight forwarder')
    const v2 = new Vault('k3f9')
    v2.load(v1.entries(), rules)
    expect(mask('Acme Freight A/S', rules, v2)).toBe(ph('CUSTOMER', 1, 'k3f9'))
    expect(unmask(`${ph('CUSTOMER', 1, 'k3f9')} [hint: Danish freight forwarder]`, v2)).toBe('Acme Freight A/S')
  })

  test('hints are cleaned to one short line', () => {
    const r = buildRules({ customers: [{ name: 'Acme Freight A/S', hint: 'Freight\n[forwarder] ' + 'x'.repeat(300) }] })
    const out = mask('Acme Freight A/S', r, new Vault('k3f9'))
    const hint = /\[hint: ([^\]]*)\]/.exec(out)?.[1] ?? ''
    expect(hint.startsWith('Freight forwarder x')).toBe(true)
    expect(hint.length).toBe(120)
  })
})
