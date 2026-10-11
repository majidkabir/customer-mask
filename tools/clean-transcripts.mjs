#!/usr/bin/env node
// Masks the local copies Claude Code keeps in session transcripts outside the
// rows customer-mask already masked: the queue record of each typed prompt and
// the structured record of each tool result. It uses the placeholder table
// saved beside each transcript, so only sessions that ran with customer-mask
// (0.3+) are touched. The mod does this itself when a session ends; use this
// for transcripts over 4 MiB, which a mod cannot read, or for older sessions.
//
//   node tools/clean-transcripts.mjs                 # every session with a table
//   node tools/clean-transcripts.mjs --session <id>  # one session
//   node tools/clean-transcripts.mjs --dry-run       # report only, change nothing
//
// Needs Node 22.18+ (it imports the mod's TypeScript directly). Runs on your
// machine only; nothing is sent anywhere.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { cleanTranscript, parseVaultFile, Vault } from '../hooks/masker.ts'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const only = args.includes('--session') ? args[args.indexOf('--session') + 1] : undefined
if (args.includes('--session') && !only) {
  process.stderr.write('usage: node tools/clean-transcripts.mjs [--session <id>] [--dry-run]\n')
  process.exit(2)
}

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
    vault.load(saved.entries, [])

    const original = readFileSync(transcript, 'utf8')
    const { text, changedLines } = cleanTranscript(original, vault)
    if (changedLines === 0) continue
    cleaned += 1
    process.stdout.write(`${dryRun ? 'would clean' : 'cleaned'} ${id}: ${changedLines} line(s)\n`)
    if (!dryRun) {
      if (readFileSync(transcript, 'utf8') !== original) {
        process.stderr.write(`skipped ${id}: it changed while being cleaned (is the session running?)\n`)
        continue
      }
      writeFileSync(transcript, text)
    }
  }
}
process.stdout.write(`${sessions} session(s) with a placeholder table, ${cleaned} ${dryRun ? 'to clean' : 'cleaned'}.\n`)
