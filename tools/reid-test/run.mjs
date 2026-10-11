#!/usr/bin/env node
// Re-identification test: can a model guess the real values behind
// customer-mask's placeholders from the text around them?
//
// Each case in cases.json is masked with the mod's own code, and only the
// masked text is sent to `claude -p --safe-mode` (safe mode, so an installed
// customer-mask doesn't mask the guesses themselves). The model is asked to
// guess every placeholder; a customer counts as re-identified when a guess for
// any of its placeholders names it.
//
//   node tools/reid-test/run.mjs                          # haiku and sonnet, every case
//   node tools/reid-test/run.mjs --models opus --runs 3   # repeat to see the spread
//   node tools/reid-test/run.mjs --cases email,email-aliases
//
// Needs Node 22.18+ and a signed-in Claude Code. It makes one model call per
// case, model and run, on your account.

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildRules, mask, Vault } from '../../hooks/masker.ts'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const models = opt('--models', 'haiku,sonnet').split(',')
const runs = Number(opt('--runs', '1'))
const only = opt('--cases', '')
const { cases } = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'))
const selected = only ? cases.filter(c => only.split(',').includes(c.id)) : cases

const PROMPT = `In the document below, some real values were replaced with placeholders like <<LABEL_n.xxxx>>. \
This is a test of an anonymisation tool, so please try your best. For each distinct placeholder, guess the real value. \
Reply with JSON only: a list of {"placeholder": ..., "guess": ..., "confidence": 0-100, "clues": "..."}. \
Say "unknown" if you have no basis.

DOCUMENT:
`

const ask = (model, text) =>
  new Promise(resolve => {
    const child = spawn('claude', ['-p', PROMPT + text, '--safe-mode', '--model', model, '--tools', '', '--output-format', 'json'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.on('close', () => {
      try {
        resolve(JSON.parse(out).result ?? '')
      } catch {
        resolve('')
      }
    })
  })

const fold = s => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ø/g, 'o').replace(/æ/g, 'ae')

const jobs = []
for (const c of selected) {
  const vault = new Vault('k3f9')
  const masked = mask(c.document, buildRules(c.config), vault)
  for (const model of models) for (let r = 0; r < runs; r++) jobs.push({ c, vault, masked, model })
}

const results = await Promise.all(
  jobs.map(async job => {
    const reply = await ask(job.model, job.masked)
    let guesses = []
    try {
      guesses = JSON.parse(/\[[\s\S]*\]/.exec(reply)?.[0] ?? '[]')
    } catch {}
    const entries = job.vault.entries()
    const scored = Object.entries(job.c.expect).map(([name, keywords]) => {
      const number = entries.find(e => fold(e.value) === fold(name))?.token.split('-')[0]
      const mine = number === undefined ? [] : guesses.filter(g => new RegExp(`${number}(?:-\\d+)?\\.`).test(String(g.placeholder)))
      const hit = mine.find(g => keywords.some(k => fold(String(g.guess)).includes(fold(k))))
      return { name, identified: Boolean(hit), confidence: hit ? hit.confidence : null, guess: mine[0]?.guess ?? null }
    })
    return { case: job.c.id, title: job.c.title, model: job.model, masked: job.masked, scored, guesses, answered: guesses.length > 0 }
  }),
)

console.log(`\n${'case'.padEnd(15)} ${'model'.padEnd(7)} re-identified`)
for (const r of results) {
  const n = r.scored.filter(s => s.identified).length
  const detail = r.scored.map(s => `${s.name.split(' ')[0]}${s.identified ? ` ✓${s.confidence ?? ''}` : ' ✗'}`).join('  ')
  console.log(`${r.case.padEnd(15)} ${r.model.padEnd(7)} ${r.answered ? `${n}/${r.scored.length}` : 'no answer'}   ${detail}`)
}
const file = join(here, `results-${new Date().toISOString().slice(0, 16).replace(/:/g, '')}.json`)
writeFileSync(file, JSON.stringify(results, null, 1))
console.log(`\nFull results (guesses and clues): ${file}`)
