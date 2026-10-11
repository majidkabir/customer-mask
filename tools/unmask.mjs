#!/usr/bin/env node
// Restores real values in headless Claude Code output, using the placeholder
// table customer-mask saved beside the session's transcript.
//
//   claude -p "..." --output-format json | node tools/unmask.mjs           # prints the result text
//   claude -p "..." --output-format json | node tools/unmask.mjs --json    # prints the whole JSON
//   claude -p "..." --output-format stream-json --verbose | node tools/unmask.mjs --json
//   node tools/unmask.mjs --session <session-id> < reply.txt               # any text
//
// Only placeholders carrying that session's marker are restored. Runs on your
// machine only; nothing is sent anywhere.

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PLACEHOLDER = /<<([A-Z][A-Z0-9_]*_\d+(?:-\d+)?)(?:\.([a-z0-9]{4}))?>>/g

function usage(message) {
  if (message) process.stderr.write(`unmask: ${message}\n`)
  process.stderr.write('usage: claude -p ... --output-format json | node tools/unmask.mjs [--json]\n')
  process.stderr.write('       node tools/unmask.mjs --session <session-id> [--json] < text\n')
  process.exit(2)
}

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const sessionArg = args.includes('--session') ? args[args.indexOf('--session') + 1] : undefined
if (args.includes('--session') && !sessionArg) usage('--session needs a session id')

const input = readFileSync(0, 'utf8')

/** Parses the input as one JSON value, or as JSON lines (stream-json); undefined for plain text. */
function parse(text) {
  try {
    return { kind: 'json', value: JSON.parse(text) }
  } catch {}
  const lines = text.split('\n').filter(l => l.trim())
  try {
    return { kind: 'lines', value: lines.map(l => JSON.parse(l)) }
  } catch {}
  return undefined
}

const parsed = parse(input)
const values = parsed ? (parsed.kind === 'json' ? [parsed.value] : parsed.value) : []
const sessionId = sessionArg ?? values.find(v => v && typeof v.session_id === 'string')?.session_id
if (!sessionId) usage('no session id: pass --session <id>, or pipe JSON output from claude -p')

const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const projects = join(configDir, 'projects')
const vaultFile = existsSync(projects)
  ? readdirSync(projects)
      .map(dir => join(projects, dir, `${sessionId}.customer-mask.json`))
      .find(path => existsSync(path))
  : undefined
if (!vaultFile) usage(`no placeholder table for session ${sessionId} under ${projects}`)

const vault = JSON.parse(readFileSync(vaultFile, 'utf8'))
const values_ = new Map(vault.entries.map(e => [e.token, e.value]))
const unmask = text =>
  text.replace(PLACEHOLDER, (whole, token, marker) =>
    (marker ?? '') === vault.marker && values_.has(token) ? values_.get(token) : whole,
  )
const unmaskDeep = v =>
  typeof v === 'string'
    ? unmask(v)
    : Array.isArray(v)
      ? v.map(unmaskDeep)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unmaskDeep(x)]))
        : v

if (!parsed) {
  process.stdout.write(unmask(input))
} else if (asJson) {
  const out = values.map(v => JSON.stringify(unmaskDeep(v)))
  process.stdout.write((parsed.kind === 'json' ? out[0] : out.join('\n')) + '\n')
} else {
  const result = [...values].reverse().find(v => v && typeof v.result === 'string')?.result
  if (result === undefined) usage('no "result" in the JSON; use --json to restore the whole output')
  process.stdout.write(unmask(result) + '\n')
}
