import { expect, test } from 'claude-code/testing'

import { buildRules, mask, Vault } from '../hooks/masker'

// How long building the rules and masking take for large customer lists and
// large tool results (a 1 MB log). Run with `claude plugin test .`.

/** The test runner prints console output; the hooks environment's types leave it out. */
declare const console: { log: (...args: unknown[]) => void }

const SUFFIXES = ['A/S', 'ApS', 'GmbH', 'Ltd', 'AB', '']
const WORDS = ['Nordic', 'Baltic', 'Freight', 'Logistics', 'Cargo', 'Trans', 'Shipping', 'Line', 'Group', 'Global',
  'Express', 'Haulage', 'Carriers', 'Marine', 'Air', 'Rail', 'Road', 'Supply', 'Chain', 'Partners']

function names(count: number): string[] {
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const a = WORDS[i % WORDS.length], b = WORDS[(i * 7 + 3) % WORDS.length]
    out.push(`${a} ${b} ${i.toString(36)} ${SUFFIXES[i % SUFFIXES.length]}`.trim())
  }
  return out
}

function text(bytes: number, list: string[]): string {
  const line = 'INFO 2026-10-11T12:00:00Z shipment SHP12345678 status=IN_TRANSIT user=ops@example.dk eta=+45 12 34 56 78 '
  let out = ''
  let i = 0
  while (out.length < bytes) out += line + (i++ % 50 === 0 ? list[(i * 13) % list.length] : 'no customer') + '\n'
  return out
}

for (const [count, kb] of [[1_000, 100], [10_000, 100], [10_000, 1_000], [50_000, 1_000]] as const) {
  test(`${count} names over ${kb} KB`, { timeoutMs: 60_000 }, () => {
    const list = names(count)
    const t0 = Date.now()
    const rules = buildRules({ customers: list, patterns: [{ label: 'SHIPMENT', regex: '\\bSHP\\d{8}\\b' }] })
    const t1 = Date.now()
    const input = text(kb * 1024, list)
    const t2 = Date.now()
    mask(input, rules, new Vault('bnch'))
    const t3 = Date.now()
    console.log(`BENCH names=${count} size=${kb}KB build=${t1 - t0}ms mask=${t3 - t2}ms`)
    // A hook gets 10 s; stay well inside it even on a slow CI machine.
    expect(t1 - t0 + (t3 - t2)).toBeLessThan(5_000)
  })
}
