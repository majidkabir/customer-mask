# Configuration

## Where the config lives

customer-mask reads up to three JSON files and **merges** them:

| Order | File | Use it for |
| --- | --- | --- |
| 1 | the path in `$CUSTOMER_MASK_CONFIG` | a central list, e.g. synced from a CRM |
| 2 | `~/.claude/customer-mask.json` | your own defaults across all projects |
| 3 | `<project>/.claude/customer-mask.json` | customers specific to one repository |

`customers` and `patterns` from all files are combined. `detectors` are merged key by key, with later files winning. `maskedTools` is taken from the last file that sets it, and `unmaskedTools` from all files combined.

Config is read when the session starts. After editing it, run `/customer-mask reload` to apply it to the running session. A config that doesn't load (bad JSON, a pattern that doesn't compile, a wrong option) is **not** applied on reload: the working one stays in force and the command says why. At session start, a broken config blocks the session until it's fixed and reloaded.

With no file at all, the built-in detectors still run (email, phone, IBAN, CPR).

## Options

```json
{
  "customers": [
    { "name": "Acme Freight A/S", "hint": "Danish freight forwarder" },
    "Nordic Widgets ApS"
  ],
  "patterns": [
    { "label": "SHIPMENT", "regex": "\\bSHP\\d{8}\\b" },
    { "label": "CUSTOMER_NO", "regex": "\\bC\\d{7}\\b" },
    { "label": "BOOKING", "regex": "\\bbk-[0-9a-f]{6}\\b", "flags": "i" }
  ],
  "detectors": { "email": true, "phone": true, "iban": true, "cpr": true },
  "maskedTools": ["WebSearch", "WebFetch", "mcp__*"],
  "unmaskedTools": ["mcp__local_db__*"],
  "media": "drop",
  "nameVariants": true
}
```

### `customers`: (string | { name, hint })[]

Names to mask. Matching is whole-word and ignores case. By default each name also matches its common variants (see [`nameVariants`](#namevariants-boolean)), so listing `Acme Freight A/S` also catches:

| Written as | Why it matches |
| --- | --- |
| `Acme Freight` | legal suffix left out |
| `Acme Freight ApS`, `Acme Freight GmbH`, `Acme Freight, Inc.` | another legal suffix |
| `acme-freight`, `ACME.FREIGHT`, `AcmeFreight`, `acme_freight_id` | other separators or none |

All of these are the same customer (`CUSTOMER_1`, `CUSTOMER_1-2`, …), and each is restored exactly as written. Longer names win over shorter ones.

Tips:

- Abbreviations and nicknames (`AF`, `Acme`) still need their own entry.
- Very short or common words (`Shell`, `Apple`, `Target`) will also mask ordinary uses of the word in code and prose. That is safe, but it can confuse Claude. Prefer the full legal name where you can.

#### Hints

A placeholder hides what Claude would otherwise know about a customer (industry, country, size), which can make drafted emails or summaries generic. An entry can carry a `hint`: a short description that **does not identify** the customer.

```json
{ "customers": [{ "name": "Acme Freight A/S", "hint": "Danish freight forwarder, ships to the Baltics" }] }
```

The first time that customer appears in a session, Claude sees `<<CUSTOMER_1.k3f9>> [hint: Danish freight forwarder, ships to the Baltics]`. Later mentions show the placeholder alone. If Claude copies the hint into a file, command or tool call, it is dropped when the placeholder is restored, so it never ends up in your work. Hints are cut to one line of 120 characters.

Write hints like this: *"Danish freight forwarder"* is fine. *"The freight forwarder that bought Baltic Haulage in 2024"* identifies the customer and defeats the point.

### `nameVariants`: boolean

`true` (default): customer names match without or with another legal suffix and with any separator between words, as shown above. A name whose core would be shorter than three characters without its suffix (e.g. `AB A/S`) is matched only as listed.

`false`: names match only as listed (any case, any run of whitespace between words).

### `patterns`: { label, regex, flags? }[]

Your own identifiers. `regex` is a JavaScript regular expression written as a JSON string, so backslashes are doubled. `g` is added automatically, and you can add others such as `i`. The label becomes the placeholder name (`SHIPMENT` → `<<SHIPMENT_1>>`). It is upper-cased, and characters other than `A–Z 0–9 _` become `_`.

Anchor patterns with `\\b` so they don't match inside longer tokens. A pattern that doesn't compile **blocks the session** rather than being skipped.

### `detectors`: object

All built-ins are on by default. Set one to `false` to turn it off:

| Key | Detects |
| --- | --- |
| `email` | email addresses |
| `phone` | `+CC …` international numbers, and Danish `12 34 56 78` |
| `iban` | IBANs, with or without spaces |
| `cpr` | Danish CPR numbers in `DDMMYY-XXXX` form |

### `maskedTools`: string[]

Tools whose arguments **keep** their placeholders instead of being restored, because those tools send their arguments to a server. Entries are tool names or patterns, where `*` matches anything. The default is `["WebSearch", "WebFetch", "mcp__*"]`: the web tools and **every MCP tool**, since an MCP server can forward what it receives anywhere. Setting this replaces the default. `[]` restores values for every tool.

A tool in this list receives the literal placeholder text. A web search for it finds nothing useful, and a Slack message posted through MCP shows the placeholder. That is the intended trade-off.

### `unmaskedTools`: string[]

Exceptions to `maskedTools`: tools that get real values even though they match it. Use this for MCP tools that only work on your machine and need real IDs, such as a local database:

```json
{ "unmaskedTools": ["mcp__local_db__*", "mcp__filesystem__*"] }
```

Only list a tool here if you know where its server sends data.

### `media`: "drop" | "allow"

What happens to images and PDFs (screenshots, scanned invoices, pasted pictures). Text masking can't see inside them.

- `drop` (default): they are removed before anything is stored or sent, and Claude gets a note that they were removed.
- `allow`: they are sent as they are. Only use this if you're sure no image in the project shows customer data.

Any other value blocks the session.

## Keeping the customer list current

The name list is where recall comes from: a customer that is missing from it is not masked. Options, roughly in order of effort:

1. **By hand** in `~/.claude/customer-mask.json`. Fine for a handful of key accounts.
2. **A scheduled export** from the CRM or master-data system into a file, with `CUSTOMER_MASK_CONFIG` pointing at it. One JSON file with `customers` is enough.
3. **A shared file managed centrally** (e.g. via MDM or a config repo) for a whole team.

See [open questions](open-questions.md#5-recall-customers-not-in-the-list) for detection beyond lists.

## Checking what was loaded

```
/customer-mask
```

```
customer-mask: active
Config: 2 customer name(s), 3 custom pattern(s), tools kept masked: WebSearch, WebFetch, mcp__* except mcp__local_db__* from /home/me/.claude/customer-mask.json
Replaced this session (3):
  <<CUSTOMER_1.k3f9>>  →  Acme Freight A/S
  <<SHIPMENT_1.k3f9>>  →  SHP12345678
  ...
```

This is answered locally by the mod, with no model turn. Claude Code keeps a command's output as a conversation row, and that row goes through the same masking as everything else, so the real values appear on your screen only.
