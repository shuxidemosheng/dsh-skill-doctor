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
dsh plugin --profile <profile> add dsh-skill-doctor@0.2.0
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

Exit codes: `0` clean, `1` errors (or warnings with `--warn-as-error`), `2` usage/read error.

### `plugin_doctor` (new in 0.3.0)

Checks the plugins installed in a profile for structural conflicts: a bundle listed twice, two plugins inserting the same loader entry, two plugins patching the same row (for example `agent-default-model`), a bundle whose package is missing, or a dependency that is installed but not enabled.

```json
{ "profile": "desktop" }
```

It reads `profiles/<name>/package.json` plus each plugin's `cordis.patch.yml`, so it needs no runtime state and changes nothing. Runtime tool-name collisions are **not** covered: the tool registry does not expose which plugin registered a name, and the report says so instead of guessing. Shipped `@deepseek-ai/*` bundles live inside `app.asar`, so entry conflicts are compared between profile plugins only.

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
- It does not judge whether a skill is well written, and does not auto-fix.
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
