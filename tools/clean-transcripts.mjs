#!/usr/bin/env node
// Masks the local copies Claude Code keeps on disk outside the rows
// customer-mask already masked: in each session's transcript and its subagents'
// transcripts, the queue record of each typed prompt and the structured record
// of each tool result; in tool-results/, the full output of results too long
// to show the model whole. Only sessions that ran with customer-mask (0.3+)
// are touched: it needs the placeholder table saved beside the transcript.
// The mod does this itself when a session ends; use this for files over 4 MiB,
// which a mod cannot read, for older sessions, or after a session that ended
// without a clean exit.
//
// Without --config only values recorded in the session's table are replaced.
// With --config, anything that config's rules detect is replaced too (values
// the model never saw), and the new placeholders are added to the table.
//
//   node tools/clean-transcripts.mjs                         # every session with a table
//   node tools/clean-transcripts.mjs --session <id>          # one session
//   node tools/clean-transcripts.mjs --config customers.json # also apply these rules
//   node tools/clean-transcripts.mjs --dry-run               # report only, change nothing
//
// Needs Node 22.18+ (it imports the mod's TypeScript directly). Runs on your
// machine only; nothing is sent anywhere.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { buildRules, cleanText, cleanTranscript, parseVaultFile, Vault } from '../hooks/masker.ts'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const opt = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const only = opt('--session')
const configFile = opt('--config')
if ((args.includes('--session') && !only) || (args.includes('--config') && !configFile)) {
  process.stderr.write('usage: node tools/clean-transcripts.mjs [--session <id>] [--config <file>] [--dry-run]\n')
  process.exit(2)
}
const rules = configFile ? buildRules(JSON.parse(readFileSync(configFile, 'utf8'))) : []

/** Files in a folder ending with `suffix`, or none when it does not exist. */
const filesIn = (dir, suffix) =>
  existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith(suffix)).map(n => join(dir, n)) : []

const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const projects = join(configDir, 'projects')
if (!existsSync(projects)) {
  process.stdout.write(`No sessions under ${projects}.\n`)
  process.exit(0)
}

let sessions = 0
let cleaned = 0
for (const dir of readdirSync(projects)) {
  const folder = join(projects, dir)
  let names
  try {
    names = readdirSync(folder)
  } catch {
    continue
  }
  for (const name of names) {
    if (!name.endsWith('.customer-mask.json')) continue
    const id = name.slice(0, -'.customer-mask.json'.length)
    if (only && id !== only) continue
    const transcript = join(folder, `${id}.jsonl`)
    if (!existsSync(transcript)) continue
    sessions += 1

    let saved
    try {
      saved = parseVaultFile(readFileSync(join(folder, name), 'utf8'))
    } catch (err) {
      process.stderr.write(`skipped ${id}: ${err.message}\n`)
      continue
    }
    const vault = new Vault(saved.marker)
    vault.load(saved.entries, rules)
    const before = vault.size

    const sessionDir = join(folder, id)
    const targets = [
      ...[transcript, ...filesIn(join(sessionDir, 'subagents'), '.jsonl')].map(path => ({
        path,
        clean: t => cleanTranscript(t, vault, rules).text,
      })),
      ...filesIn(join(sessionDir, 'tool-results'), '.txt').map(path => ({ path, clean: t => cleanText(t, vault, rules) })),
    ]
    let changedFiles = 0
    for (const { path, clean } of targets) {
      const original = readFileSync(path, 'utf8')
      const text = clean(original)
      if (text === original) continue
      changedFiles += 1
      if (dryRun) continue
      if (readFileSync(path, 'utf8') !== original) {
        process.stderr.write(`skipped ${path}: it changed while being cleaned (is the session running?)\n`)
        continue
      }
      writeFileSync(path, text)
    }
    if (changedFiles === 0) continue
    cleaned += 1
    process.stdout.write(`${dryRun ? 'would clean' : 'cleaned'} ${id}: ${changedFiles} file(s)\n`)
    if (!dryRun && vault.size !== before) {
      writeFileSync(join(folder, name), JSON.stringify({ version: 1, marker: vault.marker, entries: vault.entries() }, null, 1))
    }
  }
}
process.stdout.write(`${sessions} session(s) with a placeholder table, ${cleaned} ${dryRun ? 'to clean' : 'cleaned'}.\n`)
