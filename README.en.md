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
- **Every problem comes with a prescription.** 🔧 auto-fixable / 🖥 one command / ✍️ human only, clearly separated. Truncated descriptions get a **rewrite worksheet** (trigger skeleton + budget): the model drafts, you confirm before it is written — the loop from diagnosis to fix stays closed.
- **Tells whether a plugin really started, not just installed.** Reads the runtime fiber phase and names bundles that failed; when it cannot check, it says so instead of implying "no problems".
- **Consults across layers.** "0 skills" does not mean the skills broke — the plugin report lists every patch that touched the skill chain (who → which entry → which key), and the skill report points back at the plugin layer when it comes up empty.
- **Live activity in the session.** A bar above the composer shows which skill the model just loaded and which tools it is calling.
- **Groups by root cause, not by count.** If 13 skills are all "description too long" and all named `nature-*`, that is one template problem — the report says so and tells you fixing the template beats fixing 13 files.
- **Says which dsh version its ruler was calibrated against.** "Over 500 chars is long" is a dsh convention, not a constant. The report states its baseline; when your dsh moved to another `major.minor`, it warns that thresholds may be stale instead of asserting them.
- **Runs in CI.** `dsh-skill-lint` needs no dsh runtime, with proper exit codes and `--json`.

## Install

```bash
dsh plugin --profile <your-profile> add dsh-skill-doctor
```

That installs the latest version; pin it by appending `@0.7.0` if you prefer.

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

The overlay has three tabs: **Modes**, **Activity**, **Usage**. **Modes is the entry point**: six buttons (full checkup, one directory, one skill, rewrite worksheet, follow-up, plugin consultation) — click one, it highlights and its request template is put into the composer; add a path or a skill name and press enter. When the composer API is unavailable it falls back to the clipboard and says so in the panel. Usage is **cross-session**: how many times each skill was loaded into context, when it was last used, and how many sessions are covered — the "which skills does the model never use" ranking is the dynamic evidence behind static diagnosis. Data lives only in this machine's browser storage (localStorage); it is never uploaded, never written into skill files, and can be cleared with one click in the panel. Skills the model reads directly via `read` are not counted — the ownership is unknowable, so it prefers under-counting over mis-counting.

## Slash commands (the fastest entry point in the client)

Four commands ship with the plugin. Type `/` in the composer, pick one — it becomes a **blue command chip**; add the argument inline and press enter. They run **without the model**, so they are instant and cannot be reworded:

| Command | What it does | Example |
|---|---|---|
| `/doctor` | Plain-text checkup summary: tier counts, common root cause, cut-off triggers | `/doctor` or `/doctor D://skills` |
| `/scope` | Check one directory (or a single `SKILL.md`) | `/scope D://AIcoding//test-skills` |
| `/followup` | Follow-up diff against the last record | `/followup` |
| `/rewrite` | Description rewrite worksheet (budget + cut triggers + skeleton) | `/rewrite nature-alpha` |

Output is plain text (one node in the flow, no table rendering), so it is trimmed to "what to look at first". For the full report with prescriptions, still ask the model to run `skill_doctor` — both paths share the same scanner.

> Why commands are blue chips but panel buttons are not: a chip is dsh's command node and only host-registered commands get one; the panel runs in the webview and can only put text into the composer.

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

Omit `name` for a full check. Two scope parameters, with different semantics:

- `roots` — check **only** these directories (or a single `SKILL.md`). Use it whenever the user names a directory; the report header then says the check was scoped.
- `extraRoots` — **add** roots on top of the session's visible skills (for duplicate/shadow detection); existing skills stay in the report.

Add `"rewrite": true` for the **rewrite worksheet** mode: without `name`, worksheets for every description-truncated skill (same-prefix skills grouped into a template — one template draft plus per-skill variable parts); with `name`, a single worksheet. A worksheet = hard constraints + verbatim visible/cut text + extracted trigger phrases + a deterministic skeleton — the model fills in the copy, **the user confirms before anything is written**, and a re-run of skill_doctor verifies the fix via the follow-up comparison.

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
| PL006 | warn | A plugin touched the skill chain: disabled the skill entry, or turned off default roots with no replacement |

**Consultation: skills × plugins.** `skill_doctor` handles skills, `plugin_doctor` handles plugins — but real failures often span both layers: a plugin patch changes the skill catalogue, the skill report just says "0 skills", and it looks like the skills broke. The plugin report's consultation section puts every bundle touchpoint on the skill chain (who → which entry → which key) on one table; conversely, the skill report points at the plugin layer when it finds nothing. One entry point, one cross-check.

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
| `baseline` | `auto` (on by default) | Record: `auto` maintains it per profile; `off` disables it; or a file path (supports `~`). The follow-up comparison works out of the box |

Invalid config makes the plugin log one warning and disable itself — it **never blocks session creation**.

## Record & follow-up

One checkup is easy; knowing whether this run is better than the last one is not. Two ways:

**On by default, nothing to configure**: every checkup stores the record and diffs against the previous one automatically. The first run archives ("first record"), from the second on the report carries the follow-up comparison. Records live per profile under `~/.dsh/skill-doctor/` — your own data directory, a few KB.

To turn it off explicitly (this is the only feature that writes anything besides an explicit description/fix):

```yaml
config:
  baseline: off    # or a concrete file path if you want to manage the file yourself
```

**Manual via CLI (CI / you own the file)**:

```bash
# First run: check and save the record
dsh-skill-lint ~/.claude/skills --save skill-doctor-baseline.json

# After fixing: re-examine; the report gains a follow-up section
dsh-skill-lint ~/.claude/skills --compare skill-doctor-baseline.json

# Once confirmed, store the new state as the next record (diff + save in one command)
dsh-skill-lint ~/.claude/skills --compare skill-doctor-baseline.json --save skill-doctor-baseline.json
```

The comparison is grouped by rule — same philosophy as clustering: root causes, not counts:

```text
## Follow-up comparison

Against the record `skill-doctor-baseline.json` (saved 2026-10-31), by rule:

- ✅ Improved: description too long 4 → 2; description too vague 1 → 0
- ⚠️ Worse: referenced file missing 0 → 1 (`new-report`)
- 🆕 New this run: `new-report`
- 🗑 Gone since last time: `other-pdf` (renamed or removed?)

Overall: 5 → 3 findings.
```

- The record is plain JSON and can be committed; in CI, run `--compare --json` and gate on a non-empty `comparison.regressed`.
- Keep the same measuring stick: the record stores the `severityThreshold` and enabled rules it was saved with; on mismatch the report says the numbers are not directly comparable instead of silently diffing.
- **There are exactly three write paths, all with backup and verification**: (1) its own record JSON when `baseline` is configured; (2) `skill_doctor { name, setDescription }`, which writes the description line after the user confirmed that exact draft; (3) `skill_doctor { name, fix: true }`, which applies byte-level BOM/CRLF fixes. The tool never invents or rewrites copy and never touches semantic content.
- **The same writes exist as deterministic CLI commands**: `dsh-skill-lint --set-description <skill> --from <draft-file>` (add `--apply`) and `--fix --apply`. Both share the same implementation (YAML-safe escaping, everything else byte-preserved including line endings, `.bak`, automatic rollback when post-write verification fails), so nothing in the client requires a terminal.

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
