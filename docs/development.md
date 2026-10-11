# Development

## Repository layout

```
customer-mask/
├── .claude-plugin/
│   ├── plugin.json          # mod manifest (name, version, state contract)
│   └── marketplace.json     # makes this repo installable with /plugin install
├── hooks/
│   ├── hooks.json           # { "modules": ["./register.ts"] }: makes the plugin a mod
│   ├── register.ts          # every Claude Code hook; wiring only
│   └── masker.ts            # pure masking logic: rules, vault, stream unmasker
├── types/
│   └── index.d.ts           # the $.state contract (the vault)
├── tests/
│   ├── masker.test.ts       # unit tests of the masking logic
│   ├── register.test.ts     # hooks driven through the real Claude Code engine
│   └── scale.test.ts        # timing with large customer lists and 1 MB inputs
├── docs/
├── tools/
│   ├── unmask.mjs           # restores real values in claude -p output, from the saved table
│   ├── clean-transcripts.mjs # masks Claude Code's local copies in transcripts (large or older ones)
│   └── build-customer-list.mjs # builds the customer list from a CRM export (CSV)
├── rollout/
│   ├── managed-settings.json        # team rollout: enable for everyone, load first
│   └── managed-settings.strict.json # same, plus only your organization's mods
├── customer-mask.example.json
└── .github/workflows/test.yml
```

`masker.ts` has no Claude Code dependency on purpose: it can be tested on its own and reused (in a proxy, a CLI filter, a Java port).

## Requirements

- Claude Code **2.1.296+**. Mods exist from 2.1.287, but this mod is tested on 2.1.296 and blocks requests on anything older: a hook missing on an older build would silently mask nothing. The minimum is `MIN_CLAUDE_CODE` in `hooks/masker.ts`; raise it when a release starts depending on newer behaviour.
- Node 22+ only if you want to type-check with `tsc`

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

When writing tests, build placeholder strings at run time (`` `<<${label}_${n}>>` ``) rather than writing them literally. With the mod active in your own Claude Code session, a literal placeholder whose token is in your vault gets restored to the real value when Claude writes the file (see [open questions #7](open-questions.md#7-placeholder-look-alikes-in-real-text)).

## What has been verified

Besides the automated tests (61, including `tests/scale.test.ts`, which fails if masking a 1 MB result with 50,000 customer names takes 5 s or more), the mod was run end to end against the real model with Claude Code 2.1.296.

| Check | Result |
| --- | --- |
| Tool result of a CSV with customer, shipment ID and email, as the model received it | `<<CUSTOMER_1>>,<<SHIPMENT_1>>,<<EMAIL_n>>` ✅ |
| Same reply as streamed to the screen | real values ✅ |
| Model asked for `echo "<<CUSTOMER_1>> / <<SHIPMENT_1>>" > out.txt`; content of `out.txt` | `Acme Freight A/S / SHP12345678` ✅ |
| User and tool rows in the saved transcript containing a real value | 0 ✅ |
| Automatic session title (headless) | ⚠️ generated from the raw prompt ([#1](open-questions.md#1-headless-session-title-is-generated-from-the-raw-prompt)) |
| `claude -p` final result text | masked; `tools/unmask.mjs` restores it ✅ |
| Session resumed in a new process uses a placeholder from the earlier turn in a command | real value ✅ |

To reproduce it, put a CSV and a `.claude/customer-mask.json` in an empty folder, then:

```bash
claude -p "Read shipments.csv, then run: echo \"<customer> / <shipment>\" > out.txt" \
  --plugin-dir /path/to/customer-mask --allowedTools Read Bash \
  --output-format stream-json --verbose --include-partial-messages > run.jsonl
cat out.txt                                   # real values
grep -c "Acme" ~/.claude/projects/*/<session-id>.jsonl   # only the queue record (#3)
```

`stream_event` text deltas in `run.jsonl` show what was displayed. `assistant` and `user` messages show what was stored and sent.

## Releasing

1. Bump `version` in `.claude-plugin/plugin.json`.
2. Make sure CI is green.
3. Tag `vX.Y.Z` and push. Users get it with `claude plugin update customer-mask` followed by `/reload-plugins`.
