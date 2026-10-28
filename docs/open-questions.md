# Open questions

Known gaps found while building and testing, and decisions that still need an owner. Each item has a **status**, so it's clear what has been verified versus what is still a question.

| # | Topic | Kind | Status |
| --- | --- | --- | --- |
| 1 | [Headless session title is generated from the raw prompt](#1-headless-session-title-is-generated-from-the-raw-prompt) | Leak | ⚠️ Verified gap, partly mitigated |
| 2 | [Headless final result text stays masked](#2-headless-final-result-text-stays-masked) | UX | ✅ Fixed in 0.3 (`tools/unmask.mjs`) |
| 3 | [Local copies Claude Code writes itself](#3-local-copies-claude-code-writes-itself) | Local storage | ✅ Fixed in 0.4, completed in 0.4.1 |
| 4 | [Vault persistence across restarts](#4-vault-persistence-across-restarts) | Design | ✅ Fixed in 0.3 (beside the session) |
| 5 | [Recall: customers not in the list](#5-recall-customers-not-in-the-list) | Detection | 🟡 Variants in 0.2, aliases in 0.5, optional NER in 0.6; misses remain |
| 6 | [Images, PDFs and other binary content](#6-images-pdfs-and-other-binary-content) | Coverage | ✅ Fixed in 0.2 (dropped) |
| 7 | [Placeholder look-alikes in real text](#7-placeholder-look-alikes-in-real-text) | Correctness | ✅ Fixed in 0.2 |
| 8 | [Which tools should keep placeholders](#8-which-tools-should-keep-placeholders) | Policy | ✅ Fixed in 0.2 |
| 9 | [Is pseudonymisation enough for compliance?](#9-is-pseudonymisation-enough-for-compliance) | Compliance | ❓ Needs legal / DPO |
| 10 | [Enforcing it for a team](#10-enforcing-it-for-a-team) | Rollout | ✅ Kit in 0.4; `--safe-mode` gap remains |
| 11 | [Effect on answer quality](#11-effect-on-answer-quality) | Quality | ✅ Hints added in 0.4 |
| 12 | [Thinking blocks](#12-thinking-blocks) | Coverage | ℹ️ By design |
| 13 | [Performance](#13-performance) | Engineering | ✅ Masking speed fixed in 0.2; NER latency measured in 0.6; token overhead open |
| 14 | [Mods API stability](#14-mods-api-stability) | Engineering | ✅ Minimum version enforced in 0.2 |
| 15 | [Licence](#15-licence) | Repo | ✅ MIT |
| 16 | [Prompt hooks failing open](#16-prompt-hooks-failing-open) | Correctness | ✅ Fixed in 0.4.1 |
| 17 | [User config file on Windows](#17-user-config-file-on-windows) | Correctness | ✅ Fixed in 0.4.1 |
| 18 | [What the screen shows](#18-what-the-screen-shows) | UX | ✅ Real values on screen since 0.7 |
| 19 | [Re-identification from context](#19-re-identification-from-context) | Leak | ⚠️ Measured; reduced in 0.5, can't be removed |

---

### 1. Headless session title is generated from the raw prompt

**What happens:** Claude Code asks a small model (Haiku) to title the session from the first prompt (`source=generate_session_title` in the debug log). In a headless run (`claude -p`, the SDK) that request is sent **before the mod's prompt hooks run**, with the raw prompt text. Naming the session with `--name` doesn't stop it (tested). A test prompt mentioning "Acme Freight A/S" produced the title *"Acme Freight delayed shipment apology"*.

**Mitigation in place:** the mod sets `sessionTitle` from the masked prompt in `classic.UserPromptSubmit`. The **stored** title (in the transcript and `custom-title.json`) is masked, but the outgoing title request is not prevented.

**Not yet known:** whether the interactive terminal and desktop app generate the title before or after the prompt hooks. This needs a test with `--debug-file` in an interactive session.

**Options:**
- Ask Anthropic for a setting or mod event that disables or covers title generation.
- Until then, in headless use don't put customer data in the **first** prompt. Reference files instead ("summarise ticket.txt").

### 2. Headless final result text stays masked

`claude -p` and the SDK return the stored final message, which `session.append` has masked. The streamed reply is unmasked live by `turn.step` (see [#18](#18-what-the-screen-shows)). Tools get real values in both modes, except the tools in `maskedTools`.

A `turn.complete` hook was tried. It can only add text *beneath* the answer, never replace the recorded result, so it would show the answer twice in interactive mode.

**Fixed (0.3):** with the placeholder table saved beside the session (#4), headless output can be restored afterwards on your machine:

```bash
claude -p "..." --output-format json | node tools/unmask.mjs          # the result text
claude -p "..." --output-format json | node tools/unmask.mjs --json   # the whole JSON
```

Verified live. A mod still can't change what `claude -p` prints by itself, so the pipe is needed.

### 3. Local copies Claude Code writes itself

**Was:** Claude Code writes local copies that don't pass through `session.append`: in the transcript, the `queue-operation` record of each typed prompt and the structured record of each tool result (`toolUseResult`, e.g. a file's full content as Claude read it); and in the session's folder, the full output of results too long to show the model whole (`tool-results/*.txt`) and the subagents' transcripts (`subagents/*.jsonl`). None of it is sent to the model, but the files on disk weren't clean.

**Fixed (0.4, completed in 0.4.1):** when a session ends (or `/clear` ends a conversation), the mod masks those fields in the transcript and the subagents' transcripts, plus generated titles and summaries, and the `tool-results/*.txt` files. It replaces every value in the placeholder table, then runs the detection rules for values the model never saw. 0.4 did only the first step, so values beyond the preview of a long output stayed raw; a 251 KB command output showed this. File paths are left alone, so resume and edit tracking keep working. Each file is read again just before writing, and the write is skipped if anything changed in between. Verified live: after a session that read a CSV, and after one that produced the 251 KB output, no file in the session held a real value except the placeholder table, and resuming still worked.

**Limits:** the copies are unmasked *during* the session. The cleanup is best effort and needs a clean end; after a crash or a killed process they stay. A mod can only read files up to 4 MiB, so larger files are skipped. For all of these, and for sessions from before 0.4, run `node tools/clean-transcripts.mjs` (`--dry-run` to preview, `--session <id>` for one, `--config <file>` to also apply that config's detection rules; without it only values in the saved table are replaced). It needs Node 22.18+.

### 4. Vault persistence across restarts

**Was:** the table lived in memory only. After `claude --resume` in a new process, old placeholders in the conversation couldn't be restored.

**Fixed (0.3):** the table is saved as `<session-id>.customer-mask.json` beside the session's transcript in `~/.claude/projects/<project>/`. On start or resume the mod adopts that file's marker and entries, so the transcript's placeholders resolve again and numbering continues. `/clear` starts a new table. Verified live: a session resumed in a new process ran a command using a customer name it only knew as a placeholder from the earlier turn, and the command got the real value.

**Trade-offs to know:**
- The file holds **real values in plain text**, with the same protection as the transcript and project files: your user account's file permissions. No encryption is used, because a mod has no key store, and a key kept beside the file would add nothing.
- Claude Code's automatic cleanup of old transcripts may not remove this file. Delete `~/.claude/projects/*/*.customer-mask.json` along with old sessions if that matters.
- `--fork-session` in a new process starts without the parent's table; placeholders from before the fork stay as placeholders.
- An unreadable or corrupt file blocks the session rather than guessing.

### 5. Recall: customers not in the list

Names are only masked if they are in `customers` or match a pattern.

**Fixed (0.2): spelling variants of listed names.** A listed name now also matches without or with another legal suffix, in any case, and with any separator (`Acme Freight`, `Acme Freight ApS`, `acme-freight`, `AcmeFreight`). Each spelling keeps its own token sharing the customer's number (`CUSTOMER_1`, `CUSTOMER_1-2`), so it is restored exactly. This also fixed a bug where spellings differing only in case shared one token and Claude's Edit tool could fail. Verified live: an Edit on a file with three spellings of one customer applied cleanly, every spelling unchanged.

**Added (0.5):** [aliases](configuration.md#aliases) per customer (brands, addresses, websites, abbreviations), and names glued into a host name (`legogroup.com`), both masked as the same customer.

**Added (0.6): optional NER detection.** With [`detection: "ner"` or `"both"`](configuration.md#detection-list--ner--both), a local NER model ([`tools/ner-server`](../tools/ner-server/server.py), spaCy or GLiNER) finds company and person names that aren't on the list. A name it finds once stays masked for the rest of the session. If the server doesn't answer, the session is blocked; a call that fails or is too slow removes that content. Verified live (spaCy `en_core_web_lg`): a prompt naming an unlisted company and person, and a CSV of unlisted customers and contacts read by Claude, reached the model as placeholders only, and the file Claude wrote had the real values.

**Still open:**
- **NER misses names, and a miss is a leak.** `en_core_web_sm` missed an unlisted company in a real prompt; `en_core_web_lg` found all 16 names in the test texts, but that is a small sample. Keep known customers in the list (`both`).
- **NER is noisy on code.** spaCy tags identifiers as organizations. A filter drops most of them, and names written in camelCase (`PostNord`) are dropped with them. The rest are masked: safe, but Claude sees placeholders for some ordinary words. `ner.scope: "prompts"` avoids it for coding work.
- **NER is slower on big text**: about 2 s per 100 KB on a CPU with spaCy (see [configuration](configuration.md#the-ner-server)). A tool result that takes longer than `ner.timeoutMs` is removed. GLiNER was not tested (its model host was unreachable from the test machine).
- **The end-of-session cleanup does not use NER.** Local copies of output the model only saw part of (a long result cut to a preview) are cleaned with the list, the patterns and the values found during the session, not with the model.
- Misspellings and names glued to another word outside host names. Edit-distance matching is risky in code, where near-misses are common. Generating the list from the CRM on a schedule (see [configuration](configuration.md#keeping-the-customer-list-current)) is still the most reliable way to cover known customers.

### 6. Images, PDFs and other binary content

**Was:** only text was masked. An image or PDF Claude read (a screenshot of a customer screen, a scanned invoice) was sent as-is. In a live test, Claude read the customer name straight off a PNG.

**Fixed (0.2):** image and PDF blocks are removed before they are stored or sent, and Claude gets a note saying why. Inside a tool result the media is replaced by the note. In a prompt the media is dropped and the note is appended to the prompt's text, because a row's own media blocks may only be dropped, not replaced. Verified live: Claude reports the image was removed and offers alternatives. Set [`"media": "allow"`](configuration.md#media-drop--allow) to send media unmasked.

**Still open:** OCR-and-redact, so images can be used safely. That would need a local OCR step and is not planned yet.

### 7. Placeholder look-alikes in real text

**Was:** any text of the form `<<LABEL_n>>` whose token was in the vault got replaced with the real value wherever Claude wrote it. This was hit for real while developing this repo with the mod active: a test file containing a literal placeholder string was written to disk with a real address instead.

**Fixed (0.2):** placeholders carry a random per-session marker, `<<CUSTOMER_1.k3f9>>`, and only placeholders with this session's marker are restored. Text that only looks like a placeholder, or a placeholder from another session, is left as written. Verified live over 3 sessions, each with its own marker: Claude copied the marked placeholders exactly into a file and a shell command, and both got the real values.

**Compatibility:** a session that began on 0.1, before markers, keeps the old unmarked form until it ends, so its existing placeholders still resolve.

### 8. Which tools should keep placeholders

**Was:** every tool got real values except `WebSearch` and `WebFetch`, so any MCP tool that talks to an external service (Slack, Jira, a ticketing API) received real customer data.

**Fixed (0.2):** default-deny. Every MCP tool (`mcp__*`) keeps its placeholders. Local MCP tools that need real values are listed in [`unmaskedTools`](configuration.md#unmaskedtools-string). Tool lists accept `*` patterns.

### 9. Is pseudonymisation enough for compliance?

Placeholders are **pseudonymisation**, not anonymisation. Context can still re-identify a customer, and we measured it ([#19](#19-re-identification-from-context)): from the city and goods in a shipment list, Claude named 3–4 of 5 well-known Danish companies. Under GDPR pseudonymised data can still be personal data. Questions for legal / the DPO:

- Does this meet the company's policy for sending customer data to an AI provider, or is it defence-in-depth on top of an approved enterprise agreement?
- Which data classes must be masked: names, contacts, contract values, shipment contents?
- Does the residual risk from #1, #5, #10, #18 and #19 need sign-off?

### 10. Enforcing it for a team

**Fixed (0.4):** [docs/team-rollout.md](team-rollout.md) is a tested kit: copy the mod to each machine with MDM, build one customer list from a CRM export with `tools/build-customer-list.mjs`, and deploy [`rollout/managed-settings.json`](../rollout/managed-settings.json) (or the [strict variant](../rollout/managed-settings.strict.json), which also stops users' own mods and `--plugin-dir`). Verified with real managed settings: the mod loads first for everyone (`tier prepend`) and uses the central list.

**Still open:** `claude --safe-mode` and `claude --bare` start without any plugins (Anthropic's documentation confirms `--safe-mode` turns installed mods off, an organization's included), and we found no managed setting in Claude Code 2.1.296 that blocks these flags. Cover this with policy, or a network-level control. Who owns the managed config and the CRM export job is an organizational decision.

### 11. Effect on answer quality

Claude sees a placeholder instead of a name, so it loses world knowledge about that customer (industry, country). For most coding and data tasks this doesn't matter, but drafted emails and summaries can turn generic.

**Fixed (0.4):** a customer entry can carry a non-identifying [`hint`](configuration.md#hints), shown to Claude once, after that customer's first placeholder. Claude is told never to write the hint out; a `[hint: …]` it repeats right after a placeholder is dropped when the placeholder is restored (a paraphrase elsewhere is not detected). Verified live: Claude described the customer from the hint and tailored an email subject to it, and the saved file held the real name with no hint text. Answer quality overall still hasn't been measured systematically. The flip side was measured ([#19](#19-re-identification-from-context)): a descriptive hint can identify a well-known customer by itself.

### 12. Thinking blocks

Thinking is unmasked for **display** only. The thinking the transcript keeps is the model's signed block, which a mod can't rewrite, and it holds placeholders, as the model wrote them. No leak, but noted for completeness.

### 13. Performance

**Was:** the customer list compiled into one big regex. Benchmarked, it took **14 s** to mask a 1 MB log with 10,000 names, beyond the 10 s a hook gets. A list of 50,000 names failed outright (*regular expression too large*). Worse, a hook that ran out of time was skipped, and the row was then stored and sent **unmasked**.

**Fixed (0.2):**
- Names are matched with a trie in one pass over the text, so the cost barely depends on the list size. Building the rules and masking, two runs each with `tests/scale.test.ts` on the old and new code (same machine, a cloud VM):

  | Names | Input | Before | After |
  | --- | --- | --- | --- |
  | 10,000 | 100 KB | 2.0–2.4 s | 0.2–0.25 s |
  | 10,000 | 1 MB | 14–16 s | 0.4–0.7 s |
  | 50,000 | 1 MB | crashed | 0.8–1.1 s |

- If masking a row ever throws or runs out of time anyway, the row is stored with its text removed (`session.append` now has a fail-closed `.catch`), never as it was.
- `tests/scale.test.ts` fails if any of its cases (up to 50,000 names over 1 MB) takes 5 s or more.

**NER (0.6):** with `detection: "ner"` or `"both"`, each masking hook first calls the local NER server. Since 0.7 the server keeps its answer per line (Claude Code sends the same system prompt and reminders every turn, so after the first turn only new text goes through the model), runs a batch at a time with the smallest waiting request first (so a prompt isn't stuck behind a long file), and Claude's own replies skip it (they only hold placeholders and names found before; the model added false finds such as "We"). If the system prompt can't be checked in time, its sections are removed but the note about placeholders is still sent, so Claude doesn't take placeholders for missing values. GLiNER on a 2-core CPU takes about 0.8 s per 1,000 characters, measured in pii-mask. With spaCy on a CPU that adds about 10–30 ms for a prompt and about 2 s for 100 KB of text; the numbers are in [configuration](configuration.md#the-ner-server).

**Still open: token overhead.** A placeholder such as `<<CUSTOMER_14.h5xz>>` usually takes more tokens than the value it replaces. In a real session where Claude read a 257 KB log with three customer values on every line, input tokens rose by about 20% and the session took about 30% longer (13 s → 17 s, two paired runs); about 1 s of that was the mod's own work, the rest the model reading more tokens. Sessions with few customer values are affected far less, but that hasn't been measured cleanly. A shorter placeholder format would cut the overhead; it needs a test that Claude still copies it reliably.

### 14. Mods API stability

The mods API is marked *early access* and may change between releases. The tests (`claude plugin test`) run against the latest Claude Code in CI, so breaking changes show up there.

**Fixed (0.2):** we found no manifest field for a minimum Claude Code version, so the mod checks `$.session.version()` itself and blocks every request on 2.1.287 to 2.1.295 (2.1.296 is the version it is tested on). On an older build a hook it relies on might not exist; that hook would never run, nothing would be masked, and nothing would stop the request. Before 2.1.287 Claude Code has no mods, so the mod can't run, or block anything, at all.

### 15. Licence

**Fixed:** [MIT](../LICENSE). Anyone may use, copy, modify and distribute the code, including commercially, as long as the copyright notice is kept. The software comes without warranty.

### 16. Prompt hooks failing open

**Was:** `session.append` and `tool.call` had fail-closed `.catch` handlers, but `prompt.context`, `prompt.attachment` and `prompt.compose` did not. If masking threw there, Claude Code skipped the hook and sent `CLAUDE.md`, injected text or per-session system prompt sections unmasked.

**Fixed (0.4.1):** each has a `.catch` now. A context block's or system prompt section's text is replaced by a note, injected text is left out, and a session title that can't be masked says it was withheld. Tests force each hook to fail part-way.

### 17. User config file on Windows

**Was:** the user file was looked up under `HOME`, which Windows usually doesn't set, so `~/.claude/customer-mask.json` was silently ignored there.

**Fixed (0.4.1):** `USERPROFILE` is used when `HOME` is unset or empty.

### 18. What the screen shows

The streamed reply is unmasked as it arrives (`turn.step`). Once a reply is done, Claude Code draws it again from the stored row, which holds placeholders; so do your prompt and a tool call's row. Seen in the sibling project [pii-mask](https://github.com/majidkabir/pii-mask) in an interactive session: the reply showed real values while it streamed, then switched to placeholders. Since 0.7, `ui.render` hooks on `AssistantMessage`, `UserMessage` and `ToolUse` put the real values back on screen. Only the drawing changes; the model and the stored transcript still get placeholders. Rows of tools that keep their placeholders (web, MCP) show the placeholders they sent.

### 19. Re-identification from context

**Question:** can Claude, or any model, guess the real value behind a placeholder?

**Test:** `tools/reid-test/run.mjs` masks seven short documents with the mod's own code, sends only the masked text to Claude (Haiku and Sonnet, in safe mode, without the mod), and asks it to guess every placeholder. The customers are five well-known Danish companies on purpose, since a model can only name a company it has heard of. Two runs per model, 2026-10-11, Claude Code 2.1.296:

| Case | What the masked text still says | Haiku | Sonnet |
| --- | --- | --- | --- |
| Invoice line | nothing but amounts | 0/1, 0/1 | 0/1, 0/1 |
| Code | nothing but IDs | 0/1, 0/1 | 0/1, 0/1 |
| Shipment list, 5 customers | origin city and goods | 0/5, 4/5 | 4/5, 4/5 |
| Email with signature | town, address, product lines | 1/1 (90%), 1/1 (90%) | 1/1 (90%), 1/1 (90%) |
| Same email, brands, address and town as [aliases](configuration.md#aliases) | "a distribution centre in Jiaxing", "holiday season", "sets" | 1/1 (85%), 1/1 (90%) | 1/1 (45%), 1/1 (60%) |
| Hint: "toy manufacturer famous for interlocking plastic bricks" | the hint | 1/1 (92%), 1/1 (85%) | 1/1 (97%), 1/1 (97%) |
| Hint: "Danish manufacturer, consumer goods" | the hint | 0/1, 0/1 | 1/1 (25%), 1/1 (30%) |

Percentages are the model's own confidence in its correct guess. Shipment numbers were never guessed. In one Haiku run the model answered "unknown" for everything, so results vary between runs.

**What it shows:**
- A placeholder carries nothing by itself. What gives a customer away is the rest of the text: a city, the goods, a product, an address, or a hint. Any capable model, or a person with a search engine, can do the same, so this is about the data, not about Claude.
- It applies to customers a model knows about. A small, private customer is much harder to name, though an address or a website still identifies it to anyone who looks it up.
- The first run of the test found a gap: `legogroup.com` stayed unmasked because the name was glued to another word. **Fixed in 0.5**, together with per-customer aliases. Aliases lowered the larger model's confidence (90% → 45–60%) but did not stop the guess, because the text still held other clues.

**What to do:** list the identifiers you know as aliases, keep hints vague, and treat masking as risk reduction, not anonymisation. Run `node tools/reid-test/run.mjs` against your own kinds of documents to see what your data gives away. It makes one model call per case, model and run on your account. (A re-identification test is only meaningful with real, well-known names, so don't run it on real customer data you're not allowed to send.)

