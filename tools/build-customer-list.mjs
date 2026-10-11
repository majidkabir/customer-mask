#!/usr/bin/env node
// Builds a customer-mask customer list from a CSV export (a CRM, an ERP, a
// spreadsheet saved as CSV). Run it on a schedule and point CUSTOMER_MASK_CONFIG
// at the output, so new customers are masked without anyone editing JSON.
//
//   node tools/build-customer-list.mjs --csv accounts.csv --column "Account Name" --out customers.json
//   node tools/build-customer-list.mjs --csv accounts.csv --column "Account Name" \
//        --hint-column "Industry" --alias-columns "Website,Brands,Street" --out customers.json
//
// Options:
//   --csv <file>           the export; comma, semicolon or tab separated, quoted fields allowed
//   --column <name>        the column holding the customer name
//   --hint-column <name>   optional: a column whose value becomes the customer's hint
//                          (pick one that does NOT identify the customer, e.g. industry)
//   --alias-columns <a,b>  optional: columns whose values also identify the customer (website,
//                          brands, street address, registration number); they become its aliases.
//                          A cell may hold several values separated by ; or |
//   --out <file>           where to write the JSON (default: print it)
//   --patterns <file>      optional: a JSON file whose "patterns" are copied into the output
//
// Duplicates (same name ignoring case and spacing) are kept once; their aliases are combined.
// Runs locally.

import { readFileSync, writeFileSync } from 'node:fs'

function usage(message) {
  if (message) process.stderr.write(`build-customer-list: ${message}\n`)
  process.stderr.write('usage: node tools/build-customer-list.mjs --csv <file> --column <name> [--hint-column <name>] [--alias-columns <a,b>] [--out <file>] [--patterns <file>]\n')
  process.exit(2)
}

const args = process.argv.slice(2)
const opt = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const csvFile = opt('--csv')
const column = opt('--column')
const hintColumn = opt('--hint-column')
const outFile = opt('--out')
const patternsFile = opt('--patterns')
const aliasColumns = (opt('--alias-columns') ?? '').split(',').map(c => c.trim()).filter(Boolean)
if (!csvFile || !column) usage('--csv and --column are required')

/** Parses CSV text (RFC 4180 quoting) with the given delimiter into rows of fields. */
function parseCsv(text, delimiter) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"' && field === '') quoted = true
    else if (c === delimiter) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter(r => r.some(f => f.trim() !== ''))
}

const text = readFileSync(csvFile, 'utf8').replace(/^﻿/, '')
const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
const delimiter = [',', ';', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0]
const [header, ...rows] = parseCsv(text, delimiter)
if (!header) usage(`${csvFile} is empty`)

const find = name => {
  const i = header.findIndex(h => h.trim().toLowerCase() === name.trim().toLowerCase())
  if (i < 0) usage(`no column "${name}" in ${csvFile}; columns are: ${header.map(h => h.trim()).join(', ')}`)
  return i
}
const nameAt = find(column)
const hintAt = hintColumn ? find(hintColumn) : -1
const aliasAt = aliasColumns.map(find)

const seen = new Map()
let skipped = 0
for (const row of rows) {
  const name = (row[nameAt] ?? '').trim().replace(/\s+/g, ' ')
  if (name.length < 2) { skipped++; continue }
  const key = name.toLowerCase()
  const aliases = aliasAt
    .flatMap(i => (row[i] ?? '').split(/[;|]/))
    .map(a => a.trim().replace(/\s+/g, ' '))
    .filter(a => a.length > 1 && a.toLowerCase() !== key)
  const known = seen.get(key)
  if (known) {
    if (aliases.length && typeof known !== 'string') known.aliases = [...new Set([...(known.aliases ?? []), ...aliases])]
    else if (aliases.length) seen.set(key, { name: known, aliases: [...new Set(aliases)] })
    continue
  }
  const hint = hintAt >= 0 ? (row[hintAt] ?? '').trim() : ''
  const entry = { name, ...(hint && { hint }), ...(aliases.length && { aliases: [...new Set(aliases)] }) }
  seen.set(key, Object.keys(entry).length === 1 ? name : entry)
}

const out = { customers: [...seen.values()] }
if (patternsFile) out.patterns = JSON.parse(readFileSync(patternsFile, 'utf8')).patterns ?? []
const json = JSON.stringify(out, null, 2) + '\n'
if (outFile) writeFileSync(outFile, json)
else process.stdout.write(json)
process.stderr.write(
  `${seen.size} customer(s)` +
    `${hintAt >= 0 ? `, ${out.customers.filter(c => typeof c !== 'string' && c.hint).length} with a hint` : ''}` +
    `${aliasAt.length ? `, ${out.customers.filter(c => typeof c !== 'string' && c.aliases).length} with aliases` : ''}` +
    `${skipped ? `, ${skipped} row(s) without a usable name skipped` : ''}${outFile ? `, written to ${outFile}` : ''}\n`,
)
