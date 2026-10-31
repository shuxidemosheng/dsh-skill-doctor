<div align="center">

# dsh-skill-doctor

**A health check for DeepSeek Harness skills: does it load, why is it ignored, and are its description, budget and resource references sane?**

[![npm version](https://img.shields.io/npm/v/dsh-skill-doctor)](https://www.npmjs.com/package/dsh-skill-doctor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

Skill failures are usually silent: a skill does not load, is shadowed by a duplicate, has its description truncated, or references a file that is not there. The user only sees “the model does not use it”. This plugin turns those hidden failures into a readable report.

It is not a marketplace and not a security scanner. It answers one question: **can this skill actually work in dsh?**

## Install

```bash
dsh plugin --profile <profile> add dsh-skill-doctor@0.4.0
```

Then ask in chat:

> Lint the skills in this project.

The model calls `skill_doctor` and returns a grouped report. To diagnose one skill:

> Why is the `nature-citation` skill not showing up?

The model calls `skill_doctor({ name })`. The first screen is plain language, no dsh internals:

```text
# Skill check: `nature-citation`

**Verdict: usable, but the model only sees the first 500 characters of the description —
and the cut part is exactly how you usually ask for this skill.**

## What the model sees
- Description (the only thing it uses to decide whether to pick this skill):
  > Add strict Nature/CNS citations to manuscript text by splitting long passages into …
  956 characters total; the model sees the first 500, the remaining 456 are invisible.
- Can the model pick it on its own: yes
- Can you call it with `/nature-citation`: yes

## What got cut off (invisible to the model)
- "分段引用", "自动给出引用", "Nature系列引用"

**Impact: high.** If these are the words you actually type, the model will not pick this skill.

### How to fix
Move these phrases into the first 500 characters, e.g. start the description with:
> Use this skill when the user says "分段引用" or "自动给出引用".
```

Provider, `model-invocable` and rule IDs (SD004 …) stay in a final **"Technical details (skippable)"** section. Use `format: 'json'` or `skill_lint` when you want the raw per-rule report.

## Rules

| ID | Level | Check |
|---|---|---|
| SD001 | error | missing or unparseable frontmatter |
| SD002 | error | name is not kebab-case, or mismatches the directory |
| SD003 | error | missing/empty description |
| SD004 | warn | description exceeds the catalog limit (default 500) |
| SD005 | warn | description is too short/vague |
| SD006 | error | body is empty or headings only |
| SD007 | warn | body exceeds the token budget (default 8000) |
| SD008 | warn | `references/`, `scripts/` or `assets/` target is missing |
| SD009 | warn | same name in multiple roots/providers (may be shadowed) |
| SD010 | warn | invocation field is not boolean (including legacy camelCase) |
| SD011 | info | name longer than 64 characters |
| SD012 | warn | heuristic suspicious instructions (ignore-previous, credential URLs, hidden Unicode, long base64) |
| SD013 | info | UTF-8 BOM |
| SD014 | info | CRLF line endings |
| SD015 | warn | resource reference contains path traversal |

Rules can be disabled or re-leveled through config. SD012 is heuristic: a hit is not proof of malice.

## Tools

### `skill_lint`

Lints every skill visible to the session, or one by name. This is the per-rule / CI mode: rule IDs are printed inline. For the plain-language version use `skill_doctor`.

```json
{ "name": "code-review", "format": "json" }
```

Parameters: `name?`, `provider?`, `rules?`, `severity?`, `extraRoots?`, `format?` (`markdown` | `json`).

### `skill_explain`

Explains the winning provider/source/path, invocation policy, description length, body token estimate, whether `ctx.skills.get` can load it, and likely reasons it is missing or ignored.

```json
{ "name": "code-review" }
```

## CLI

The package ships `dsh-skill-lint`, which does not need the dsh runtime:

```bash
npx --package dsh-skill-doctor dsh-skill-lint .
npx --package dsh-skill-doctor dsh-skill-lint ./skills/code-review
npx --package dsh-skill-doctor dsh-skill-lint . --json --warn-as-error
npx --package dsh-skill-doctor dsh-skill-lint --plugins --profile desktop
```

### Safe auto-fixes (new in 0.4.0)

Only fixes where there is exactly one possible result. Dry run by default:

```bash
dsh-skill-lint ~/.claude/skills --fix              # plan only, writes nothing
dsh-skill-lint ~/.claude/skills --fix --apply      # write, with backups
dsh-skill-lint . --fix --only SD013                # restrict to one rule
```

Two rules are fixable: **SD013 BOM** (drop the leading three bytes) and **SD014 CRLF** (`\r\n` to `\n`). Each write is preceded by a `<file>.bak` backup and followed by a re-lint with the same config; if the re-lint finds a new error, the file is restored from the backup and the failure is reported.

**Deliberately not fixed**: rewriting a description, choosing between shadowed skills, deciding whether a suspicious instruction is malicious. There is no single right answer, and guessing is worse than leaving it alone. The report lists every rule that fired but was skipped.

`SD010` is excluded on purpose: it only fires for values whose intent cannot be guessed (`"maybe"`, `2`), and turning the legacy `modelInvocable` into `disable-model-invocation` requires **inverting** it — that is a semantic rewrite, not a rename.

Exit codes: `0` clean, `1` errors (or warnings with `--warn-as-error`), `2` usage/read error.

### `plugin_doctor` (new in 0.3.0, runtime checks in 0.5.0)

Answers two questions: **is it wired up correctly** (disk) and **did it actually start** (runtime).

```json
{ "profile": "desktop" }
```

On disk it reads `profiles/<name>/package.json` plus each plugin's `cordis.patch.yml`: a bundle listed twice (PL001), two plugins inserting the same loader entry (PL002), two plugins patching the same row such as `agent-default-model` (PL003), a bundle whose package is missing or a dependency installed but not enabled (PL004).

At runtime it soft-probes `pluginInventory` for each bundle's fiber phase and calls `ctx.tools.schemas(exec.agent)` for the tools actually visible in this session:

| Evidence | Strength | What the report says |
|---|---|---|
| enabled but `fiberPhase` is `failed` | certain | names the plugin; its tools will never appear |
| service missing or timed out | — | says the check did not run, and that this is **not** the same as "no problems" |
| one of our own tools missing from the list | medium | lists both possibilities: taken by a same-named tool, or hidden by the agent scope |

`pluginInventory` is only mounted in the desktop profile (the headless template omits it), so headless reports always degrade to "not checked".

**Not covered:**

- **Which plugin registered a tool name** — the registry has no owner field. `schemas()` gives every name but no provenance, so a collision can only ever be reported as suspected, never pinned on a plugin.
- **Why a plugin failed** — the inventory projects the fiber phase but not the error, and dsh writes no startup log to disk.
- `@deepseek-ai/*` bundles ship inside `app.asar`, so entry conflicts are compared between profile plugins only.

## Config

| Field | Default | Meaning |
|---|---|---|
| `maxDescriptionLength` | `500` | description limit used by the model catalog |
| `maxBodyTokens` | `8000` | body token budget |
| `maxFileBytes` | `1048576` | per-file read cap |
| `extraRoots` | `[]` | extra skill roots to scan (external directories are not read by default) |
| `rules` | `{}` | per-rule `off` / `info` / `warn` / `error` |
| `severityThreshold` | `info` | output filter |
| `includeProviders` / `excludeProviders` | `[]` | provider filters |

An invalid config logs one warning and disables the plugin; it never blocks session creation.

## How it works

1. `ctx.skills.snapshot({ cwd, scope })` gives the winning skills for this view.
2. `ctx.skills.get(name)` loads the full body and confirms it can actually be loaded.
3. When `path` points to a local file, the raw `SKILL.md` is read once (read-only) for frontmatter, references and encoding checks.
4. Remote/virtual skills skip file-level rules and use only the parsed definition.
5. `extraRoots` only adds candidate roots for duplicate reporting; the registry remains authoritative.

It never executes a skill's scripts, never modifies a file, and never sends skill content over the network.

## Limitations

- SD012 is heuristic, not a malware verdict.
- Token estimates are approximate (ASCII ≈ 4 chars/token, CJK ≈ 0.75 token/char).
- Duplicate detection scans configured roots only; it cannot see every internal registry candidate.
- It does not judge whether a skill is well written. Auto-fix covers two byte-level rules only (BOM, CRLF); anything semantic is left alone.
- Runtime checks need the **desktop profile** (`pluginInventory` is mounted there). In headless the report says the check did not run — do not read that as "all good".
- The reason a plugin failed is not available: the runtime snapshot carries the fiber phase only, no error, and dsh keeps no startup log on disk.
- Remote/virtual skills have no file-level checks.

## Development

```bash
npm install
npm run build
npm test
npm run smoke
```

## License

MIT
