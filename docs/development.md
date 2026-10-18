# Development

## Repository layout

```
customer-mask/
├── .claude-plugin/
│   ├── plugin.json          # mod manifest (name, version, state contract)
│   └── marketplace.json     # makes this repo installable with /plugin install
├── hooks/
│   ├── hooks.json           # { "modules": ["./register.ts"] }: makes the plugin a mod
│   ├── register.ts          # every Claude Code hook, config loading, the saved placeholder table
│   └── masker.ts            # pure masking logic: rules, vault, stream unmasker
├── types/
│   └── index.d.ts           # the $.state contract (the vault and the marker)
├── tests/
│   ├── masker.test.ts       # unit tests of the masking logic
│   ├── register.test.ts     # hooks driven through the real Claude Code engine
│   └── scale.test.ts        # timing with large customer lists and 1 MB inputs
├── docs/
│   └── presentation/        # the interactive walkthrough (index.html) and the README's cover.gif
├── tools/
│   ├── unmask.mjs           # restores real values in claude -p output, from the saved table
│   ├── clean-transcripts.mjs # masks Claude Code's local copies in transcripts (large or older ones)
│   ├── build-customer-list.mjs # builds the customer list from a CRM export (CSV)
│   ├── reid-test/           # can a model guess what's behind the placeholders? (cases + runner)
│   └── ner-server/server.py # local NER server (spaCy or GLiNER) for detection "ner" / "both"
├── rollout/
│   ├── managed-settings.json        # team rollout: enable for everyone, load first
│   └── managed-settings.strict.json # same, plus only your organization's mods
├── customer-mask.example.json
├── README.md
├── LICENSE
└── .github/workflows/test.yml
```

`masker.ts` has no Claude Code dependency on purpose: it can be tested on its own and reused (in a proxy, a CLI filter, a Java port).

## Requirements

- Claude Code **2.1.296+**. Mods exist from 2.1.287, but this mod is tested on 2.1.296 and blocks every request on 2.1.287 to 2.1.295: a hook missing on an older build would silently mask nothing. (Before 2.1.287 there are no mods, so it can't run at all.) The minimum is `MIN_CLAUDE_CODE` in `hooks/masker.ts`; raise it when a release starts depending on newer behaviour.
- Node: 22.18+ for `tools/clean-transcripts.mjs` and `tools/reid-test/run.mjs` (they import the mod's TypeScript directly); any recent Node for the other tools and for `tsc`. The mod itself needs no Node: it runs inside Claude Code.
- Python 3 for the optional NER server (tested with Python 3.13 and spaCy 3.8). NER detection was tested on Claude Code 2.1.302; it calls `$.http.fetch`, and if a build can't reach the server the session is blocked rather than left unmasked.

## Run it locally

```bash
claude --plugin-dir .
```

In an interactive session the folder is watched, and saving a file reloads the mod. Run `claude --debug` (or `--debug-file log.txt`) to see every hook dispatch, how long it took, and any hook Claude Code skipped and why.

## Check and test

```bash
claude plugin validate .   # manifest, marketplace, hooks module: what it hooks and calls
claude plugin test .       # all *.test.ts, offline, no sign-in
```

`claude plugin validate` also lists the **gating hooks** and whether they have a `.catch`. Every hook that guards data should fail closed.

To type-check, Claude Code writes its API types into `.claude-plugin/types/` the first time it loads the mod from a watched folder. It also writes a `tsconfig.json`. Both are git-ignored. Then run:

```bash
npx -p typescript tsc -p .
```

### How the engine tests work

`register.test.ts` uses `claude-code/testing`. Each test gets the engine's real `$` and an `on` whose hooks sit **beneath** the mod and stand in for the world: the file system, the model's stream, the Bash tool, the system prompt. The mod under test runs exactly as in a session. A helper, `world()`, registers all of these before the first call on `$` (the kit requires that order).

The tests build placeholder strings at run time (`ph()`) rather than writing them literally. If you develop with an older copy of the mod (before 0.2) active in your own Claude Code session, a literal placeholder whose token is in that session's table is restored to the real value when Claude writes the file. Since 0.2 only placeholders carrying your session's own marker are restored (see [open questions #7](open-questions.md#7-placeholder-look-alikes-in-real-text)).

## What has been verified

Besides the 108 automated tests (including `tests/scale.test.ts`, which fails if building the rules and masking a 1 MB result with 50,000 customer names takes 5 s or more), the mod was run end to end against the real model, with Claude Code 2.1.296 on Linux. The marker shown as `k3f9` is random in each run.

| Version | Check | Result |
| --- | --- | --- |
| 0.1 | A CSV with customer, shipment ID and email, as the model received it | placeholders only ✅ |
| 0.1 | The reply as streamed (stream-json text deltas) | real values ✅ |
| 0.1 | Model asked for `echo "<<CUSTOMER_1>> / <<SHIPMENT_1>>" > out.txt`; content of `out.txt` | `Acme Freight A/S / SHP12345678` ✅ |
| 0.1 | Automatic session title (headless) | ⚠️ generated from the raw prompt ([#1](open-questions.md#1-headless-session-title-is-generated-from-the-raw-prompt)); `--name` doesn't stop it |
| 0.2 | An image (PNG with a customer name) read by Claude | removed; Claude says so ✅ |
| 0.2 | Marked placeholders copied by Claude into a file and a command, 3 sessions | real values in both ✅ |
| 0.2 | Edit on a file with three spellings of one customer | applied; every spelling unchanged ✅ |
| 0.3 | `claude -p` result piped through `tools/unmask.mjs` | real values ✅ |
| 0.3 | Session resumed in a new process uses a placeholder from the earlier turn in a command | real value ✅ |
| 0.4 | Customer hint | used by Claude; not in the written file ✅ |
| 0.4 | Team rollout with real managed settings | see [team rollout](team-rollout.md#4-check-it-on-a-machine) ✅ |
| 0.4 | `claude plugin install customer-mask --marketplace majidkabir/customer-mask` into an empty config, then a session | installs from GitHub, loads, masks ✅ |
| 0.4 | A subagent reads the CSV | its rows and transcript hold placeholders only ✅ |
| 0.4.1 | A 251 KB command output (the model sees only a preview) | after the session, no file holds a real value except the placeholder table ✅ |
| 0.5 | Can Haiku or Sonnet guess the customers behind the placeholders? | from context, often; see [#19](open-questions.md#19-re-identification-from-context) ⚠️ |
| 0.6 | `detection: "both"`, spaCy `en_core_web_lg`: a prompt with an unlisted company and person, plus a CSV of unlisted customers and contacts read by Claude (Claude Code 2.1.302) | the model got placeholders only; the file Claude wrote had every real value ✅ |
| 0.6 | The same with `en_core_web_sm` | the unlisted company in the prompt was missed and reached the model ⚠️ (hence `lg` is the default) |
| 0.6 | NER server not running, a bad `ner` setting, a call slower than `ner.timeoutMs` | session blocked / session blocked / content removed ✅ (tests) |

To reproduce the basic check, put a CSV and a `.claude/customer-mask.json` in an empty folder, then:

```bash
claude -p "Read shipments.csv, then run: echo \"<customer> / <shipment>\" > out.txt" \
  --plugin-dir /path/to/customer-mask --allowedTools Read Bash \
  --output-format stream-json --verbose --include-partial-messages > run.jsonl
cat out.txt                                              # real values
grep -rl "Acme" ~/.claude/projects/*/<session-id>*       # only the .customer-mask.json table
```

`stream_event` text deltas in `run.jsonl` show what was streamed. `assistant` and `user` messages show what was stored and sent.

## Releasing

1. Bump `version` in `.claude-plugin/plugin.json`.
2. Make sure CI is green.
3. Push to `main` (a `vX.Y.Z` tag is optional). `claude plugin update customer-mask` compares the version in `plugin.json`, so an unbumped change is not offered as an update. Users then restart Claude Code or run `/reload-plugins`.
