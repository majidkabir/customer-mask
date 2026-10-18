# Configuration

## Where the config lives

customer-mask reads up to three JSON files and **merges** them:

| Order | File | Use it for |
| --- | --- | --- |
| 1 | the path in `$CUSTOMER_MASK_CONFIG` | a central list, e.g. synced from a CRM |
| 2 | `~/.claude/customer-mask.json` (`~` is `HOME`, or `USERPROFILE` on Windows) | your own defaults across all projects |
| 3 | `.claude/customer-mask.json` in the folder Claude Code was started in | customers specific to one repository |

`customers`, `patterns` and `unmaskedTools` from all files are combined. `detectors` are merged key by key, with later files winning. `maskedTools`, `media`, `nameVariants` and `detection` are taken from the last file that sets them, and `ner` is merged key by key. A file that doesn't exist or can't be read is skipped.

Config is read when the session starts. After editing it, run `/customer-mask reload` to apply it to the running session. A config that doesn't load (bad JSON, a pattern that doesn't compile, a `media`, `detection` or `ner` value that isn't allowed) is **not** applied on reload: the working one stays in force and the command says why. At session start, a broken config blocks the session until it's fixed and reloaded.

With no file at all, the built-in detectors still run (email, phone, IBAN, CPR).

## Options

```json
{
  "customers": [
    { "name": "Acme Freight A/S", "hint": "Danish freight forwarder", "aliases": ["AcmeTrack", "Havnegade 12"] },
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

### `customers`: (string | { name, hint, aliases })[]

Names to mask. Matching is whole-word and ignores case. By default each name also matches its common variants (see [`nameVariants`](#namevariants-boolean)), so listing `Acme Freight A/S` also catches:

| Written as | Why it matches |
| --- | --- |
| `Acme Freight` | legal suffix left out |
| `Acme Freight ApS`, `Acme Freight GmbH`, `Acme Freight, Inc.` | another legal suffix |
| `acme-freight`, `ACME.FREIGHT`, `AcmeFreight`, `acme_freight_id` | other separators or none |
| `acmefreightgroup.com`, `shop-acmefreight.dk` | the name glued to another word inside a host name (names of 4 or more letters and digits) |

All of these are the same customer (`CUSTOMER_1`, `CUSTOMER_1-2`, …), and each is restored exactly as written. Longer names win over shorter ones.

Tips:

- Abbreviations and nicknames (`AF`, `Acme`) still need an entry, as an [alias](#aliases) of the customer.
- A host name that merely starts or ends with a customer's name is masked too (`acmevideo.com` for `Acme`). That errs on the side of hiding; it is restored exactly when Claude uses it. A name glued to another word outside a host name (`AcmeFreightGroup` in prose or code) is not caught; add it as an alias.
- Very short or common words (`Shell`, `Apple`, `Target`) will also mask ordinary uses of the word in code and prose. That is safe, but it can confuse Claude. Prefer the full legal name where you can.

#### Hints

A placeholder hides what Claude would otherwise know about a customer (industry, country, size), which can make drafted emails or summaries generic. An entry can carry a `hint`: a short description that **does not identify** the customer.

```json
{ "customers": [{ "name": "Acme Freight A/S", "hint": "Danish freight forwarder, ships to the Baltics" }] }
```

The first time that customer appears in text Claude reads, Claude sees `<<CUSTOMER_1.k3f9>> [hint: Danish freight forwarder, ships to the Baltics]`. Later mentions show the placeholder alone. The system prompt never carries a hint: Claude Code rebuilds it for every request, and a hint in only the first build would change it once and cost a full prompt-cache miss. Claude is told never to write the hint into files, commands or messages. If it repeats the `[hint: …]` right after the placeholder anyway, that part is dropped when the placeholder is restored. A hint paraphrased elsewhere is not detected. Hints are cut to one line of 120 characters.

Write hints like this: *"Danish freight forwarder"* is fine. *"The freight forwarder that bought Baltic Haulage in 2024"* identifies the customer and defeats the point. For a well-known company even a short description can: in the [re-identification test](open-questions.md#19-re-identification-from-context), *"Danish toy manufacturer famous for interlocking plastic bricks"* let both Claude models name LEGO with 85–97% confidence, while *"Danish manufacturer, consumer goods"* only let the larger model guess it, at 25–30%.

#### Aliases

Other text that identifies a customer: brands and products, a street address, a website, a company registration number, an abbreviation.

```json
{ "customers": [{ "name": "LEGO A/S", "aliases": ["DUPLO", "Technic", "Aastvej 1", "CVR 12345678"] }] }
```

Each alias is masked as **the same customer** (`CUSTOMER_1-2`, `CUSTOMER_1-3`, …), so Claude knows it belongs to that customer, and each is restored exactly as written. Aliases match as listed: any case, any run of whitespace between words, whole words only. A longer alias wins over the name inside it (`LEGO House` is one placeholder, not two).

Aliases remove the identifiers you know about, not every hint the text gives. In the [re-identification test](open-questions.md#19-re-identification-from-context), masking the brands, address and town in an email still left "a distribution centre in Jiaxing", and the models guessed the customer from that. Don't list ordinary words (`Billund` masks the town everywhere, for every customer), and treat this as risk reduction, not anonymisation.

### `nameVariants`: boolean

`true` (default): customer names match without or with another legal suffix and with any separator between words, as shown above. A name whose core would be shorter than three characters without its suffix (e.g. `AB A/S`) is matched only as listed.

`false`: names match only as listed (any case, any run of whitespace between words).

### `patterns`: { label, regex, flags? }[]

Your own identifiers. `regex` is a JavaScript regular expression written as a JSON string, so backslashes are doubled. `g` is added automatically, and you can add others such as `i`. The label becomes the placeholder name (`SHIPMENT` → `<<SHIPMENT_1.k3f9>>`). It is upper-cased, characters other than `A–Z 0–9 _` become `_`, and anything before its first letter is dropped (an empty label becomes `DATA`).

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

- `drop` (default): they are removed before anything is stored or sent. Inside a tool result a note takes their place; in a prompt the note is added to the prompt's text.
- `allow`: they are sent as they are. Only use this if you're sure no image in the project shows customer data.

Any other value blocks the session.

### `detection`: "list" | "ner" | "both"

How customer names are found. `patterns` and `detectors` apply in every mode.

| Value | Names come from | Use it when |
| --- | --- | --- |
| `list` (default) | `customers` | you know your customers; fastest and exact |
| `ner` | a local NER model; `customers` is not used | you have no list |
| `both` | the list, then the model for anything the list missed | you want the list's precision plus a safety net |

A NER (named entity recognition) model is a small model trained to find names in text: companies, people, places. It runs on your machine, in the [NER server](#the-ner-server) the mod calls before masking. It finds names you never listed, but not all of them, and it sometimes flags ordinary words. So the list stays the reliable layer, and `both` is the usual choice.

How it behaves:

- **A value the model finds once stays masked** for the rest of the session, in any case and spacing, also where the model misses it or isn't asked. These values are saved in the placeholder table, marked `"source": "ner"`, so a resumed session keeps them.
- **It fails closed.** If the server doesn't answer when the session starts, every request is blocked until it does (start it, then `/customer-mask reload`). A call that fails or takes longer than `ner.timeoutMs` removes that content, as any masking failure does.
- **Not every find is masked.** Words that can't be a name are skipped: code (`onMatch`, `RAW_FIELDS`, anything with `_ = ( ) < >` and so on), words that start in lower case, a bare legal suffix (`AG`, `LLC`), the placeholder labels, and Claude Code's own words (`Claude`, `Bash`, `WebFetch`, `JSON`, …). A side effect: a name written in camelCase, such as `PostNord`, is skipped too. List those in `customers`.

### `ner`: object

Settings for `detection: "ner"` or `"both"`. All optional:

```json
{
  "detection": "both",
  "ner": {
    "url": "http://127.0.0.1:8765",
    "labels": { "company": "CUSTOMER", "person": "PERSON" },
    "threshold": 0.5,
    "timeoutMs": 4000,
    "scope": "all",
    "ignore": ["Kubernetes", "Terraform"]
  }
}
```

| Key | Default | What it does |
| --- | --- | --- |
| `url` | `http://127.0.0.1:8765` | where the NER server listens. Text is sent here, so keep it on your machine or a server in your network |
| `labels` | `{ "company": "CUSTOMER", "person": "PERSON" }` | what to look for, and the placeholder label each find gets. GLiNER takes any words (`"street address": "ADDRESS"`); spaCy knows `company`, `person`, `location`, `city`, `country` and `address` (and a few synonyms such as `organization`) |
| `threshold` | `0.5` | lowest confidence, from 0 to 1, that counts as a find (GLiNER gives one; spaCy doesn't, so every spaCy find counts) |
| `timeoutMs` | `4000` | longest a call may take, 100 to 8000. Claude Code gives a hook 10 s in all |
| `scope` | `all` | `all`: everything Claude gets is checked (prompts, file contents, command output, `CLAUDE.md`, the per-session parts of the system prompt). `prompts`: only what you type. Faster, and file contents are then covered by the list, patterns and values found earlier |
| `ignore` | `[]` | words the model flags that you never want masked, any case |

### The NER server

[`tools/ner-server/server.py`](../tools/ner-server/server.py) runs the model and answers the mod on `http://127.0.0.1:8765`. It listens on this machine only, and it logs nothing it is sent. Two backends:

| Backend | Install | Good at |
| --- | --- | --- |
| `spacy` | `pip install spacy` and a model: `python -m spacy download en_core_web_lg` (Danish: `da_core_news_lg`) | fast on a CPU; organizations, people and places only |
| `gliner` (default) | `pip install gliner` (brings PyTorch); the model `urchade/gliner_multi_pii-v1` downloads from Hugging Face on first start | any label you name, many languages, built for personal data. Slower without a GPU |

```bash
python3 tools/ner-server/server.py --backend spacy     # or: --backend gliner
python3 tools/ner-server/server.py --model da_core_news_lg --backend spacy --port 9000
```

The server reads text line by line, without the line numbers Claude Code's Read tool adds, because models find names in a table row or a log line better that way. It can also run on one machine for a whole team: start it with `--host 0.0.0.0` and point `ner.url` there. Then the text travels over your network to it, so put it behind your own TLS and access control.

Any server that speaks the same JSON works, for example one wrapping Presidio:

```
GET  /health  → 200
POST /detect  { "texts": ["…"], "labels": ["company", "person"], "threshold": 0.5 }
           → { "results": [[{ "text": "Nordlys Trading", "label": "company", "score": 0.93 }], …] }
```

One list per text, in order. `label` is one of the labels asked for; `score` is optional.

**Speed.** Measured with the spaCy backend (`en_core_web_lg`) on the cloud machine this was tested on (2 cores of a 2.1 GHz Xeon, no GPU). The first row is from real sessions, read from Claude Code's debug log; the others are calls to the server:

| Text | NER call | The whole masking hook |
| --- | --- | --- |
| a prompt, a short tool result (≤ 0.5 KB) | 8–20 ms | 13–35 ms, against 2–4 ms with `list` in the same session |
| 10 KB | 0.16–0.25 s | |
| 100 KB (a big file or log) | 1.7–2.1 s | |

Text the server already answered for (the system prompt, sent with every request) is not sent again. GLiNER was not measured here (Hugging Face was not reachable from the test machine). Expect it to be several times slower on a CPU: check that your largest tool results finish inside `timeoutMs`, or use `scope: "prompts"`.

**Recall.** On 16 names in 9 short business texts (unlisted Danish companies and people), `en_core_web_lg` found 16. `en_core_web_sm` found 14, and in a real session it missed `Nordlys Trading` in a longer prompt, which then reached Claude unmasked. A miss is a leak, so use the large model, and keep the customers you know in the list. On source code, spaCy also flags many identifiers. The filter above drops most of them (in one 38 KB file, 102 distinct finds became about 20, such as `Vault` or `Map`), and the rest are masked like names: safe, but noisy. For coding work, `scope: "prompts"` avoids that.

## Keeping the customer list current

The name list is where recall comes from: a customer that is missing from it is not masked. Options, roughly in order of effort:

1. **By hand** in `~/.claude/customer-mask.json`. Fine for a handful of key accounts.
2. **A scheduled export** from the CRM or master-data system into a file, with `CUSTOMER_MASK_CONFIG` pointing at it. One JSON file with `customers` is enough.
3. **A shared file managed centrally** (e.g. via MDM or a config repo) for a whole team. [Team rollout](team-rollout.md#2-maintain-one-customer-list) has a script that builds it from a CRM export.

For customers that aren't on the list, see [`detection`](#detection-list--ner--both) and [open questions #5](open-questions.md#5-recall-customers-not-in-the-list).

## Checking what was loaded

```
/customer-mask
```

```
customer-mask: active
Config: names found by: the list, 2 customer name(s) (1 with a hint), 3 custom pattern(s), tools kept masked: WebSearch, WebFetch, mcp__* except mcp__local_db__*, images/PDFs: dropped from /home/me/.claude/customer-mask.json
Images/PDFs removed this session: 0
Rows removed because masking failed: 0
Placeholder table saved to: /home/me/.claude/projects/-home-me-proj/5b1c0a2e.customer-mask.json
Replaced this session (2):
  <<SHIPMENT_1.k3f9>>  →  SHP12345678
  <<CUSTOMER_1.k3f9>>  →  Acme Freight A/S
```

(Output for the example config above in a session that has seen `Acme Freight A/S, SHP12345678`; the session id is shortened.)

This is answered locally by the mod, with no model turn. Claude Code stores a command's output as a conversation row, and that row is masked like any other, so the stored copy holds placeholders. `/customer-mask reload` re-reads the config files.
