# Open questions

Known gaps found while building and testing, and decisions that still need an owner. Each item has a **status**, so it's clear what has been verified versus what is still a question.

| # | Topic | Kind | Status |
| --- | --- | --- | --- |
| 1 | [Headless session title is generated from the raw prompt](#1-headless-session-title-is-generated-from-the-raw-prompt) | Leak | ⚠️ Verified gap, partly mitigated |
| 2 | [Headless final result text stays masked](#2-headless-final-result-text-stays-masked) | UX | ✅ Fixed in 0.3 (`tools/unmask.mjs`) |
| 3 | [Raw prompt in the local transcript's queue record](#3-raw-prompt-in-the-local-transcripts-queue-record) | Local storage | ⚠️ Verified gap |
| 4 | [Vault persistence across restarts](#4-vault-persistence-across-restarts) | Design | ✅ Fixed in 0.3 (beside the session) |
| 5 | [Recall: customers not in the list](#5-recall-customers-not-in-the-list) | Detection | 🟡 Variants fixed in 0.2; NER open |
| 6 | [Images, PDFs and other binary content](#6-images-pdfs-and-other-binary-content) | Coverage | ✅ Fixed in 0.2 (dropped) |
| 7 | [Placeholder look-alikes in real text](#7-placeholder-look-alikes-in-real-text) | Correctness | ✅ Fixed in 0.2 |
| 8 | [Which tools should keep placeholders](#8-which-tools-should-keep-placeholders) | Policy | ✅ Fixed in 0.2 |
| 9 | [Is pseudonymisation enough for compliance?](#9-is-pseudonymisation-enough-for-compliance) | Compliance | ❓ Needs legal / DPO |
| 10 | [Enforcing it for a team](#10-enforcing-it-for-a-team) | Rollout | ❓ Decision needed |
| 11 | [Effect on answer quality](#11-effect-on-answer-quality) | Quality | ❓ Not measured |
| 12 | [Thinking blocks](#12-thinking-blocks) | Coverage | ℹ️ By design |
| 13 | [Performance on large tool results](#13-performance-on-large-tool-results) | Engineering | ✅ Fixed in 0.2 |
| 14 | [Mods API stability](#14-mods-api-stability) | Engineering | ✅ Minimum version enforced in 0.2 |
| 15 | [Licence](#15-licence) | Repo | ✅ MIT |

---

### 1. Headless session title is generated from the raw prompt

**What happens:** Claude Code asks a small model (Haiku) to title the session from the first prompt (`source=generate_session_title` in the debug log). In a headless run (`claude -p`, the SDK) that request is sent **before any mod hook runs**, with the raw prompt text. A test prompt mentioning "Acme Freight A/S" produced the title *"Acme Freight delayed shipment apology"*.

**Mitigation in place:** the mod sets `sessionTitle` from the masked prompt in `classic.UserPromptSubmit`. The **stored** title is masked, but the outgoing title request is not prevented.

**Not yet known:** whether the interactive terminal and desktop app generate the title before or after the prompt hooks. This needs a test with `--debug-file` in an interactive session.

**Options:**
- Ask Anthropic for a setting or mod event that disables or covers title generation.
- Until then, in headless use don't put customer data in the **first** prompt. Reference files instead ("summarise ticket.txt").

### 2. Headless final result text stays masked

`claude -p` and the SDK return the stored final message, which `session.append` has masked. The interactive terminal and desktop app show real values (unmasked live by `turn.step`). Tools always get real values in both modes.

A `turn.complete` hook was tried. It can only add text *beneath* the answer, never replace the recorded result, so it would show the answer twice in interactive mode.

**Fixed (0.3):** with the placeholder table saved beside the session (#4), headless output can be restored afterwards on your machine:

```bash
claude -p "..." --output-format json | node tools/unmask.mjs          # the result text
claude -p "..." --output-format json | node tools/unmask.mjs --json   # the whole JSON
```

Verified live. A mod still can't change what `claude -p` prints by itself, so the pipe is needed.

### 3. Raw prompt in the local transcript's queue record

The transcript file holds one `queue-operation` record with the raw first prompt. It is written by Claude Code's input queue and doesn't pass through `session.append`. This copy is **local only** (`~/.claude/projects/…`) and is not sent to the model, but it means the on-disk transcript is not fully clean.

**Options:** accept it (the data was already on this machine), or clean it up with a `SessionEnd` hook that rewrites the transcript file.

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

**Still open:** customers not in the list at all, abbreviations, and misspellings.
- Generate the list from the CRM on a schedule (see [configuration](configuration.md#keeping-the-customer-list-current)). This is the recommended next step.
- Add NER-based detection, such as a local [Microsoft Presidio](https://microsoft.github.io/presidio/) service called through `$.http`. This catches person and organisation names, but it adds a local service, latency, and false positives in code.
- Edit-distance matching for misspellings: risky in code, where near-misses are common.

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

Placeholders are **pseudonymisation**, not anonymisation. Context can still re-identify a customer ("the Danish freight forwarder in Aarhus with 40 trucks"), and under GDPR pseudonymised data can still be personal data. Questions for legal / the DPO:

- Does this meet the company's policy for sending customer data to an AI provider, or is it defence-in-depth on top of an approved enterprise agreement?
- Which data classes must be masked: names, contacts, contract values, shipment contents?
- Does the residual risk from #1, #5 and #6 need sign-off?

### 10. Enforcing it for a team

A mod the user installs can be disabled by the user. For a team rollout, Claude Code's managed settings can:

- load it first and for everyone (`prependPlugins`)
- stop other user mods from loading (`allowManagedModsOnly`)
- block `--plugin-dir` side-loading (`disableSideloadFlags`)

**Decision:** who owns the managed config, and how is the customer list distributed (see #5)?

### 11. Effect on answer quality

Claude sees `<<CUSTOMER_1>>` instead of a name, so it loses world knowledge about that customer (industry, country). For most coding and data tasks this doesn't matter, but for "draft an email to …" tone may suffer. This hasn't been measured.

**Option:** an optional per-customer hint that is sent instead of the name, e.g. `<<CUSTOMER_1>> (Danish freight forwarder)`.

### 12. Thinking blocks

Thinking is unmasked for **display** only. The thinking the transcript keeps is the model's signed block, which a mod can't rewrite, and it holds placeholders, as the model wrote them. No leak, but noted for completeness.

### 13. Performance on large tool results

**Was:** the customer list compiled into one big regex. Benchmarked, it took **14 s** to mask a 1 MB log with 10,000 names, beyond the 10 s a hook gets. A list of 50,000 names failed outright (*regular expression too large*). Worse, a hook that ran out of time was skipped, and the row was then stored and sent **unmasked**.

**Fixed (0.2):**
- Names are matched with a trie in one pass over the text, so the cost barely depends on the list size.

  | Names | Input | Before | After |
  | --- | --- | --- | --- |
  | 10,000 | 100 KB | 2.3 s | 0.2 s |
  | 10,000 | 1 MB | 14.4 s | 0.6 s |
  | 50,000 | 1 MB | crashed | 0.8 s |

- If masking a row ever throws or runs out of time anyway, the row is stored with its text removed (`session.append` now has a fail-closed `.catch`), never as it was.
- `tests/scale.test.ts` fails if 50,000 names over 1 MB takes 5 s or more.

### 14. Mods API stability

The mods API is marked *early access* and may change between releases. The tests (`claude plugin test`) run against the latest Claude Code in CI, so breaking changes show up there.

**Fixed (0.2):** Claude Code has no manifest field for a minimum version, so the mod checks `$.session.version()` itself. On anything older than 2.1.296 (the version it is tested on) it blocks every request. On an older build a hook it relies on might not exist; that hook would never run, nothing would be masked, and nothing would stop the request.

### 15. Licence

**Fixed:** [MIT](../LICENSE). Anyone may use, copy, modify and distribute the code, including commercially, as long as the copyright notice is kept. The software comes without warranty.
