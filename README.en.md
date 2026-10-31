<div align="center">

# dsh-skill-doctor

English | [中文](README.md)

**Health checks for DeepSeek Harness skills and plugins: what the model actually sees, whether a plugin really started, and what to fix next.**

[![npm version](https://img.shields.io/npm/v/dsh-skill-doctor)](https://www.npmjs.com/package/dsh-skill-doctor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](package.json)
[![dsh](https://img.shields.io/badge/dsh-%E2%89%A50.2.0--rc.2-4176E6.svg)](https://github.com/deepseek-ai/deepseek-harness)

[Highlights](#highlights) | [Install](#install) | [Usage](#usage) | [Panel](#panel) | [Tools](#tools) | [Rules](#rules) | [CLI](#cli) | [Limits](#limits) | [Troubleshooting](#troubleshooting)

</div>

Broken skills fail **silently**: not loaded, shadowed by a same-named copy, description truncated, referenced files missing — all you notice is "the model never uses it".

`dsh-skill-doctor` turns those invisible problems into a readable report. It is not a marketplace and not a security scanner; it answers one question: **does this thing actually work inside dsh?**

## Highlights

- **Shows what the model actually sees.** Not "description too long", but the truncated text **verbatim** — you can tell at a glance whether your trigger words made the cut.
- **Every problem comes with a prescription.** 🔧 auto-fixable / 🖥 one command / ✍️ human only, clearly separated.
- **Tells whether a plugin really started, not just installed.** Reads the runtime fiber phase and names bundles that failed; when it cannot check, it says so instead of implying "no problems".
- **Live activity in the session.** A bar above the composer shows which skill the model just loaded and which tools it is calling.
- **Runs in CI.** `dsh-skill-lint` needs no dsh runtime, with proper exit codes and `--json`.

## Install

```bash
dsh plugin --profile <your-profile> add dsh-skill-doctor
```

That installs the latest version; pin it by appending `@0.6.0` if you prefer.

Then **fully quit and reopen** dsh (the panel is client-side code loaded at startup).

After that just talk to it — no need to memorize tool names:

> run a health check on my skills

## Usage

Three real situations, one sentence each.

**"I suspect a skill never takes effect"**

> why might nature-citation not be picked up by the model?

You get the exact 500 characters the model reads, the trigger phrases that got cut, how much it matters, and how to fix it.

**"I suspect a plugin is not running"**

> check the desktop profile plugins for conflicts

Disk level: entry collisions, duplicate bundles, installed-but-disabled. Runtime level: fiber phase, with `failed` bundles named.

**"What is the model doing right now?"**

Look at the bar above the composer, or open it for the full call stream.

## Panel

A compact bar sits above the conversation input:

```
🩺 skill-doctor · reading skill nature-citation      3 skills · 1 plugin · 12 tools
```

```
🩺 skill-doctor · activity              3 skills · 1 plugin · 12 tools   ✕
─────────────────────────────────────────────────────────────────
→ reading skill nature-citation
✓ skill_doctor · 29 skills                              this plugin
✓ read · HANDOFF.md
● grep · TODO                                           running
─────────────────────────────────────────────────────────────────
Last 20 entries only. dsh does not expose which plugin owns a tool,
so only tool names are shown.
```

- **→** skill load; the `skill` tool carries the name, so this is exact
- **green + "this plugin"** calls to the doctor's own tools
- **●** no result yet, **✓** done
- Right side: session totals for skills / plugin calls / other tools

The panel reads the current session window, so **calls that scrolled out are gone**; entries it has seen are kept, so totals never go backwards. The footer says so.

## Tools

| Tool | What it does | When |
|---|---|---|
| `skill_doctor` | Skill health check, verdict first | Start here |
| `skill_lint` | Per-rule, technical | CI, rule-level triage |
| `skill_explain` | Why one skill does not work | You already know which one |
| `plugin_doctor` | Installed correctly + actually running | A tool disappeared |

### `skill_doctor`

```json
{ "name": "nature-citation" }
```

Omit `name` for a full check; `extraRoots` points at directories dsh does not index (for example `~/.claude/skills`).

Output order is fixed: **verdict → evidence → prescription**.

- **Verdict** — one sentence on whether it works
- **Summary table** — skill, description length, truncation impact, suggested action
- **What the model sees** — the description **verbatim**, cut at the limit, no second-hand summary
- **What got cut** — the cut position, the trigger phrases lost, and whether it matters
- **Problems** — each with "what is happening" + a prescription, no rule IDs
- **Technical details (skippable)** — provider, model-invocable, rule IDs

### `skill_lint`

Per-rule verbose mode with rule IDs inline, grouped into "must fix / truncated / other / fine".

| Parameter | Meaning |
|---|---|
| `name?` | One skill; omit for all |
| `provider?` | Filter by provider |
| `rules?` | Run only these rules, e.g. `["SD003","SD004"]` |
| `severity?` | `info` / `warn` / `error`, defaults to config |
| `extraRoots?` | Extra roots, used for shadowing detection |
| `format?` | `markdown` (default) or `json` |

### `skill_explain`

Explains why a skill is missing, never selected, or failing to load: winning provider/path, model-invocable, description length, whether `ctx.skills.get` really resolves, same-name candidates.

### `plugin_doctor`

```json
{ "profile": "desktop" }
```

**On disk** it reads the profile `package.json` and each plugin's `cordis.patch.yml`:

| ID | Level | Check |
|---|---|---|
| PL001 | warn | The same bundle listed twice |
| PL002 | warn | Two plugins inserting the same loader entry (only one wins) |
| PL003 | warn | Two plugins patching the same row (later one silently wins) |
| PL004 | error/info | Enabled but package missing / installed but not enabled |

**At runtime** it soft-probes `pluginInventory` for each bundle's fiber phase and calls `ctx.tools.schemas(exec.agent)` for the tools actually visible in this session:

| Evidence | Strength | What the report says |
|---|---|---|
| enabled but `fiberPhase` is `failed` | certain | names it; its tools will never appear |
| service missing / timed out | — | says the check did not run and that this is **not** "no problems" |
| one of this plugin's own tools is missing | medium | lists both possibilities: same-name conflict, or hidden by the agent scope |

`pluginInventory` is mounted in the **desktop profile only**, so headless always degrades to "not checked".

## Rules

15 skill rules, each individually switchable:

| ID | Level | Check |
|---|---|---|
| SD001 | error | frontmatter missing or unparsable |
| SD002 | error | skill name not kebab-case, or differs from the directory name |
| SD003 | error | description missing |
| SD004 | warn | description over the catalogue limit (default 500) |
| SD005 | warn | description too short or too generic |
| SD006 | error | body empty, or only headings |
| SD007 | warn | body token estimate over budget (default 8000) |
| SD008 | warn | `references/`, `scripts/`, `assets/` paths that do not exist |
| SD009 | warn | same name from multiple roots/providers, may be shadowed |
| SD010 | warn | invocation field is not a boolean (incl. legacy camelCase) |
| SD011 | info | skill name too long (>64) |
| SD012 | warn | suspicious-instruction heuristics: ignore prior instructions, leak credentials, hidden Unicode, long base64 |
| SD013 | info | file starts with a UTF-8 BOM |
| SD014 | info | file uses CRLF |
| SD015 | warn | resource reference contains path traversal |

> SD012 is heuristic: a hit is not a malware verdict. It does not replace a security review.

## CLI

`dsh-skill-lint` ships with the plugin and needs **no dsh runtime**:

```bash
# current project / one skill / an external directory
npx --package dsh-skill-doctor dsh-skill-lint .
npx --package dsh-skill-doctor dsh-skill-lint ./skills/code-review
npx --package dsh-skill-doctor dsh-skill-lint ~/.claude/skills

# CI: JSON, and warnings fail the build
npx --package dsh-skill-doctor dsh-skill-lint . --json --warn-as-error

# plugin check (reads the profile directory directly)
npx --package dsh-skill-doctor dsh-skill-lint --plugins --profile desktop
```

### Auto-fix

Only problems with exactly one possible result; dry run by default:

```bash
npx --package dsh-skill-doctor dsh-skill-lint ~/.claude/skills --fix          # plan only
npx --package dsh-skill-doctor dsh-skill-lint ~/.claude/skills --fix --apply  # write
npx --package dsh-skill-doctor dsh-skill-lint . --fix --only SD013            # one rule
```

Two rules are fixable: **SD013 BOM** and **SD014 CRLF**.

Each write is preceded by a `<file>.bak` backup and followed by a re-lint with the same config; if the re-lint finds a new error, the file is restored and the failure reported. `--apply` on its own is rejected.

**Deliberately not fixed**: rewriting a description, choosing between shadowed skills, deciding whether a suspicious instruction is malicious. There is no single right answer. The report lists every rule that fired but was skipped.

Exit codes: `0` clean, `1` errors (or warnings with `--warn-as-error`), `2` usage/read error.

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 24
- run: npx --package dsh-skill-doctor dsh-skill-lint ./skills --warn-as-error
```

## Config

```yaml
- insert:
    - id: skill-doctor
      name: dsh-skill-doctor
      config:
        maxDescriptionLength: 500
        maxBodyTokens: 8000
        extraRoots:
          - ~/.claude/skills
        rules:
          SD012: info        # informational only
          SD014: 'off'       # drop the CRLF hint
```

| Field | Default | Meaning |
|---|---|---|
| `maxDescriptionLength` | `500` | Matches the catalogue limit |
| `maxBodyTokens` | `8000` | Body token budget |
| `maxFileBytes` | `1048576` | Per-file read limit |
| `extraRoots` | `[]` | Extra skill roots; external dirs are never read by default |
| `rules` | `{}` | Per-rule severity: `off` / `info` / `warn` / `error` |
| `severityThreshold` | `info` | Output filter |
| `includeProviders` | `[]` | Only these providers |
| `excludeProviders` | `[]` | Skip these providers |

Invalid config makes the plugin log one warning and disable itself — it **never blocks session creation**.

## Limits

Capability boundaries, not omissions:

- **Which plugin owns a tool** — the registry has no owner field. `schemas()` gives every name but no provenance, so a collision can only be reported as suspected.
- **Why a plugin failed** — the runtime snapshot projects the fiber phase, not the error, and dsh writes no startup log to disk.
- **Skills dsh never indexed** — a name that breaks the grammar, or frontmatter that fails to parse, is not in the view at all; point `extraRoots` at the directory to scan files directly.
- **Whether a skill is well written** — not judged. Auto-fix covers two byte-level rules only.
- **Token counts are estimates** — ASCII ≈ 4 chars/token, CJK ≈ 0.75 token/char.
- **Shadow detection only scans configured roots** — registry-internal candidates are invisible; results are labelled as candidates.
- **Remote/virtual skills get no file-level checks** — no local path, so encoding and reference rules are skipped.

## Troubleshooting

**No tools show up at all**

Confirm the plugin is actually in the profile:

```bash
dsh plugin --profile <your-profile> list
```

If it is listed, suspect a tool-name conflict — when one of the four names is already registered, this plugin steps aside (the log has `already registered — skipping it`).

**Tools work but the panel is missing**

1. Make sure dsh was **fully quit and reopened**, not just the window closed
2. Open devtools; a `dsh-skill-doctor` error there explains why
3. Bar present but always "no tool calls" → the session props are not injected, which is different from the bundle not loading

**The report shows 0 or too few skills**

`skill_doctor` only sees the current dsh view. To scan directories dsh does not index (`~/.claude/skills`), pass `extraRoots` explicitly.

**"runtime state not checked" in the plugin report**

That is a degradation, not a failure: `pluginInventory` is mounted on the desktop profile only.

**All tools vanished after editing config**

Invalid config disables the plugin on purpose, so a bad config cannot block the session. Check the field names and types in `cordis.patch.yml`.

## How it works

1. `ctx.skills.snapshot({ cwd, scope })` for the winning skills in the current view
2. `ctx.skills.get(name)` for the full body, proving it really resolves
3. When `path` is local, the raw `SKILL.md` is read once (read-only) for frontmatter/reference/encoding checks
4. Remote and virtual skills have no local path, so file-level rules are skipped
5. `extraRoots` only feeds "same-name candidate" hints; the registry result stays authoritative

It **never executes** a skill's scripts, **never modifies** a file (except the CLI `--fix`), and **never sends** skill content over the network.

## Development

```bash
npm install
npm run build     # tsc + esbuild (host / cli / client)
npm test          # 95 tests
npm run smoke
npm run e2e       # real dsh headless, group A
```

After changing the panel, run `npm run build` and restart dsh. `tests/client-bundle.spec.ts` checks the bundle shell, exports and slot registration; the visuals still need human eyes.

## License

MIT
