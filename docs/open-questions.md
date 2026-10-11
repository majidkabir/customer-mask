# Open questions

Known gaps found while building and testing, and decisions that still need an owner. Each item has a **status**, so it's clear what has been verified versus what is still a question.

| # | Topic | Kind | Status |
| --- | --- | --- | --- |
| 1 | [Headless session title is generated from the raw prompt](#1-headless-session-title-is-generated-from-the-raw-prompt) | Leak | ⚠️ Verified gap, partly mitigated |
| 2 | [Headless final result text stays masked](#2-headless-final-result-text-stays-masked) | UX | ⚠️ Verified gap |
| 3 | [Raw prompt in the local transcript's queue record](#3-raw-prompt-in-the-local-transcripts-queue-record) | Local storage | ⚠️ Verified gap |
| 4 | [Vault persistence across restarts](#4-vault-persistence-across-restarts) | Design | ❓ Decision needed |
| 5 | [Recall: customers not in the list](#5-recall-customers-not-in-the-list) | Detection | ❓ Decision needed |
| 6 | [Images, PDFs and other binary content](#6-images-pdfs-and-other-binary-content) | Coverage | ✅ Fixed in 0.2 (dropped) |
| 7 | [Placeholder look-alikes in real text](#7-placeholder-look-alikes-in-real-text) | Correctness | ⚠️ Verified edge case |
| 8 | [Which tools should keep placeholders](#8-which-tools-should-keep-placeholders) | Policy | ✅ Fixed in 0.2 |
| 9 | [Is pseudonymisation enough for compliance?](#9-is-pseudonymisation-enough-for-compliance) | Compliance | ❓ Needs legal / DPO |
| 10 | [Enforcing it for a team](#10-enforcing-it-for-a-team) | Rollout | ❓ Decision needed |
| 11 | [Effect on answer quality](#11-effect-on-answer-quality) | Quality | ❓ Not measured |
| 12 | [Thinking blocks](#12-thinking-blocks) | Coverage | ℹ️ By design |
| 13 | [Performance on large tool results](#13-performance-on-large-tool-results) | Engineering | ❓ Not measured |
| 14 | [Mods API stability](#14-mods-api-stability) | Engineering | ℹ️ Watch |
| 15 | [Licence](#15-licence) | Repo | ❓ Decision needed |

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

**Options:** post-process headless output with the vault (it would need exporting, see #4), or accept that headless callers see placeholders.

### 3. Raw prompt in the local transcript's queue record

The transcript file holds one `queue-operation` record with the raw first prompt. It is written by Claude Code's input queue and doesn't pass through `session.append`. This copy is **local only** (`~/.claude/projects/…`) and is not sent to the model, but it means the on-disk transcript is not fully clean.

**Options:** accept it (the data was already on this machine), or clean it up with a `SessionEnd` hook that rewrites the transcript file.

### 4. Vault persistence across restarts

The vault lives in memory (mirrored to the session's `$.state`). After `claude --resume` in a **new process**, the old placeholder → value table is gone:

- ✅ Handled: placeholder numbers already in the transcript are reserved, so new values never collide with old ones.
- ❌ Not handled: old placeholders in the resumed conversation can't be restored, so Claude and you see `<<CUSTOMER_1>>` where it used to be a real name.

**Decision:** should the vault be persisted locally (e.g. `$.store`, encrypted with an OS-keychain key) so resume keeps working? That stores customer data on disk, though no more than the project files already do.

### 5. Recall: customers not in the list

Names are only masked if they are in `customers` or match a pattern. A new customer, a misspelling or an abbreviation passes through.

**Options:**
- Generate the list from the CRM on a schedule (see [configuration](configuration.md#keeping-the-customer-list-current)).
- Add NER-based detection, such as a local [Microsoft Presidio](https://microsoft.github.io/presidio/) service called through `$.http`. This catches person and organisation names, but it adds a local service, latency, and false positives in code.
- Use fuzzy matching on the list (edit distance, legal-suffix stripping such as `A/S`, `ApS`, `GmbH`).

### 6. Images, PDFs and other binary content

**Was:** only text was masked. An image or PDF Claude read (a screenshot of a customer screen, a scanned invoice) was sent as-is. In a live test, Claude read the customer name straight off a PNG.

**Fixed (0.2):** image and PDF blocks are removed before they are stored or sent, and Claude gets a note saying why. Inside a tool result the media is replaced by the note. In a prompt the media is dropped and the note is appended to the prompt's text, because a row's own media blocks may only be dropped, not replaced. Verified live: Claude reports the image was removed and offers alternatives. Set [`"media": "allow"`](configuration.md#media-drop--allow) to send media unmasked.

**Still open:** OCR-and-redact, so images can be used safely. That would need a local OCR step and is not planned yet.

### 7. Placeholder look-alikes in real text

Any text matching `<<LABEL_n>>` whose token is in the vault is replaced with the real value **wherever Claude writes it**. This was hit for real while developing this repo with the mod active: a test file containing a literal placeholder string was written to disk with the real address instead. The tests now build placeholder strings at run time for that reason.

**Impact:** low in normal code. It matters when working on code that itself handles these placeholders, or on templates that use `<<…>>` syntax.

**Options:** a less common delimiter, or a per-session random marker such as `⟦CUSTOMER_1·k3f⟧`, which makes look-alikes practically impossible.

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

Every rule runs over every tool result. The customer list compiles into one regex, but a 50k-name list over a multi-MB log has not been benchmarked. Hooks have a 10-second budget, and a hook that runs out is skipped, which would trigger the [fail-closed path](how-it-works.md#7-failing-closed).

**To do:** a benchmark test with a realistic list size. Consider an Aho–Corasick matcher for large lists.

### 14. Mods API stability

The mods API is marked *early access* and may change between releases. The tests (`claude plugin test`) run against the installed Claude Code, so CI catches breaking changes. Pinning a minimum Claude Code version per release of this mod would help.

### 15. Licence

No licence file has been added yet. Choose one (e.g. MIT or Apache-2.0) before others reuse the code, or keep the repo private if it becomes company-internal.
