<div align="center">

# dsh-skill-doctor

English | [中文](README.md)

**Health checks for DeepSeek Harness skills and plugins: what the model actually sees, whether a plugin really started, and what to fix next.**

[![npm version](https://img.shields.io/npm/v/dsh-skill-doctor)](https://www.npmjs.com/package/dsh-skill-doctor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](package.json)
[![dsh](https://img.shields.io/badge/dsh-%E2%89%A50.2.0--rc.2-4176E6.svg)](https://github.com/deepseek-ai/deepseek-harness)

[Highlights](#highlights) | [Install](#install) | [Usage](#usage) | [Panel](#panel) | [Tools](#tools) | [Rules](#rules) | [CLI](#cli) | [External skill sources](#external-skill-sources-optional-second-row) | [Limits](#limits) | [Troubleshooting](#troubleshooting)

</div>

Broken skills fail **silently**: not loaded, shadowed by a same-named copy, description truncated, referenced files missing — all you notice is "the model never uses it".

`dsh-skill-doctor` turns those invisible problems into a readable report. It is not a marketplace and not a security scanner; it answers one question: **does this thing actually work inside dsh?**

## Highlights

- **Shows what the model actually sees.** Not "description too long", but the truncated text **verbatim** — you can tell at a glance whether your trigger words made the cut.
- **Every problem comes with a prescription.** 🔧 auto-fixable / 🖥 one command / ✍️ human only, clearly separated. Truncated descriptions get a **rewrite worksheet** (trigger skeleton + budget): the model drafts, you confirm before it is written — the loop from diagnosis to fix stays closed.
- **Tells whether a plugin really started, not just installed.** Reads the runtime fiber phase and names bundles that failed; when it cannot check, it says so instead of implying "no problems".
- **Consults across layers.** "0 skills" does not mean the skills broke — the plugin report lists every patch that touched the skill chain (who → which entry → which key), and the skill report points back at the plugin layer when it comes up empty.
- **Usable straight from the composer, without the model.** Type `/` for a group of Chinese entries (体检 / 查目录 / 改写 / 复诊 / 诊断 / 会诊 / 审查); picking one yields a blue chip and Enter runs it locally — fast, and nothing gets reworded in transit. The seven panel buttons write these same commands.
- **Live activity in the session.** A bar above the composer shows which skill the model just loaded and which tools it is calling.
- **Keeps a record, so checkups can be compared.** Run it again after fixing 11 oversized descriptions and the report should not still read "2 left" — it diffs against the last record and tells you "11 fixed, 1 new". On by default, no configuration.
- **Shows which skills the model never uses.** The panel's Usage tab ranks skills by load count across sessions — the dynamic evidence static checks cannot give you.
- **Groups by root cause, not by count.** If 13 skills are all "description too long" and all named `nature-*`, that is one template problem — the report says so and tells you fixing the template beats fixing 13 files.
- **Says which dsh version its ruler was calibrated against.** "Over 500 chars is long" is a dsh convention, not a constant. The report states its baseline; when your dsh moved to another `major.minor`, it warns that thresholds may be stale instead of asserting them.
- **One plugin, three component rows, switched independently.** The second row mounts Claude Code / Codex / ZCode skill directories into dsh; the third is the install gate — switch it off in the plugin page when you knowingly want to install a plugin it would refuse. Diagnosis stays the main job; the other two rows are optional.
- **Runs in CI.** `dsh-skill-lint` needs no dsh runtime, with proper exit codes and `--json`.

## Install

```bash
dsh plugin --profile <your-profile> add dsh-skill-doctor
```

That installs the latest version; pin it by appending a version, e.g. `@0.17.0`.

From 0.14.0 the plugin page shows **three component rows** (checkup / install gate / external skill sources), each with its own switch. The third row mounts all three external directories by default; switch it off there if you do not want that. See [External skill sources](#external-skill-sources-optional-second-row).

Then **fully quit and reopen** dsh (the panel is client-side code loaded at startup).

After that just talk to it — no need to memorize tool names:

> run a health check on my skills

## Usage

**The fastest path is the slash command**: type `/`, pick an entry (the menu is Chinese), add a path or skill name and press Enter — it runs locally, not through the model. The three situations below fit talking to the model instead, letting it pick the tool.

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

The overlay has three tabs: **Modes**, **Activity**, **Usage**. **Modes is the entry point**: eight buttons (full checkup, one directory, one skill, rewrite worksheet, follow-up, plugin consultation, plugin review, gated install) — click one, it highlights and puts the matching `/command ` into the composer; add a path or a skill name and press enter. When the composer API is unavailable it falls back to the clipboard and says so in the panel. Usage is **cross-session**: how many times each skill was loaded into context, when it was last used, and how many sessions are covered — the "which skills does the model never use" ranking is the dynamic evidence behind static diagnosis. Data lives only in this machine's browser storage (localStorage); it is never uploaded, never written into skill files, and can be cleared with one click in the panel. Skills the model reads directly via `read` are not counted — the ownership is unknowable, so it prefers under-counting over mis-counting.

## Slash commands (the fastest entry point in the client)

Eight commands ship with the plugin. Type `/` — the menu gains a Chinese group; pick one and it becomes a **blue chip** in the composer, add the argument and press enter. They run **without the model**, so they are instant and cannot be reworded:

| Menu | Composer | What it does |
|---|---|---|
| 体检 | `/doctor` | Check every skill for breakage and visibility, merging repeated findings into one cause |
| 查目录 | `/scope <dir>` | Check only the directory you name |
| 改写 | `/rewrite <skill>` | Draft a rewrite for an oversized description, with budget and cut-off triggers |
| 复诊 | `/followup` | Diff against the previous checkup |
| 诊断 | `/why <skill>` | Why one skill is not being picked, with a concrete fix |
| 会诊 | `/clash` | Whether a plugin broke the skill-directory config |
| 审查 | `/review <pkg>` | Static risk hints for a newly installed plugin and its conflicts with installed ones; empty reads the last automatic review |
| 安装 | `/install <pkg>` | Gate a registry tarball first, then install through the official service; a high-risk hit refuses the install |

Output is plain text (one node in the flow, no Markdown tables), so it is trimmed to "what to look at first":

```text
技能体检 · 4 个技能（只查 D://skills）
⛔ 用不了 0 · ⚠️ 影响大 3 · 💡 影响小 0 · 💡 其他 0 · ✅ 正常 1

共性问题（先改这里最划算）
· 简介太长，后半段模型看不到：3 个（占 75%）；名字都以 nature- 开头，多半同一套模板

模型看不到部分触发说法（3 个）
· nature-alpha（565 字）被切掉：分段引用、自动给出引用
```

For the full report with prescriptions, still ask the model to run `skill_doctor` — both paths share the same scanner.

**Why the menu is Chinese but the composer is ASCII**: the menu column comes from the plugin, so it has no character-set limit; turning composer text into a chip goes through dsh's `TEXT_REF_RE = /(^|\s)([/@])([\w-]+)/g`, and **JS `\w` is `[A-Za-z0-9_]` only**, so a Chinese name never matches. A Chinese chip is therefore impossible on the current dsh — this release keeps the chip and puts Chinese in the menu. The tokens come from a **reference source** registered via `ctx.inputTriggers.registerSource` (the same mechanism as a skill's `/name`), and are handed to the command verbatim on submit.

Panel buttons write these same seven tokens: clicking 复诊对比 puts `/followup ` into the composer.

> If dsh ever widens that regex to `\p{L}`, switch the candidates' `token` back to Chinese in `src/source.ts`; nothing else changes.

> Update (2026-11-08): a community plugin, `dsh-chinese-skill-patch`, makes Chinese skill names discoverable and invocable. It uses `require.resolve` to locate `dsh-skill` / `dsh-skill-filesystem` / `dsh-tool-skill`, replaces the `SKILL_NAME` regex with `[\p{L}0-9]`, and adds a `CN_GESTURE` branch plus a CN variant of the `skill` tool. It fixes **name discovery and invocation**, not the composer `TEXT_REF_RE`, and does not make Chinese chips possible — the conclusion above still stands. The cost is a persistent edit to host files that must be re-applied after a dsh upgrade, which conflicts with this plugin's read-only, no-host-modification rule, so we do not adopt it.

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
| `setDescription?` | Write a confirmed description draft into the skill's frontmatter line (requires `name`) |
| `fix?` | Apply the byte-level fixes only (BOM / CRLF), with backup and rollback (requires `name`) |
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
| SD012 | warn | suspicious-instruction heuristics: ignore prior instructions, leak credentials, hidden Unicode, raw ESC, Unicode tag characters, download-piped-into-shell, long base64 |
| SD013 | info | file starts with a UTF-8 BOM |
| SD014 | info | file uses CRLF |
| SD015 | warn | resource reference contains path traversal |

> SD012 is heuristic: a hit is not a malware verdict. It does not replace a security review; the same holds for RV001-RV012 in the plugin review below.

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

### Newly installed plugin review (static heuristics, not a verdict)

A read-only pass over an **already unpacked** plugin directory (usually `<profile>/node_modules/<pkg>`) answering two questions:

- **Static risk hints**: reads `package.json` (`dsh`, `scripts`, dependencies), `cordis.patch.yml` (insert ids and config keys) and the package text, then applies RV001-RV012: install-time download/execute, credential paths, non-registry dependencies, near-miss official scope, loader id collisions, skill-chain edits, remote execution pipes, dynamic execution, invisible characters, size caps, YAML anchors.
- **Conflict focus**: reuses `plugin_doctor`'s PL001-PL006 and lists only the conflicts involving this package, naming the other plugin.

Three entry points:

```bash
# Git Bash; exit code is always 0 (only a missing directory / bad argument returns 2)
npx --package dsh-skill-doctor dsh-skill-lint --review <plugin-dir> --json
```

```text
/review <pkg>     slash command; with no argument it reads the last automatic review
```

The model can also call `plugin_doctor` with `review: "<pkg>"`, which adds an "Installation review" section and a `review` field in JSON.

**Boundaries (more important than the rule list)**:

- These are **static heuristic hints, not a security verdict**. They do not replace a security review and do not decide whether code is malicious. `eval`, `child_process` and `postinstall` appear in almost every bundled artifact, so those rules are deliberately `info`; a hit is not a malware verdict. No AST, sandbox or dependency supply-chain audit.
- `--review` itself is read-only: no rollback, no deletion, no code from the reviewed package is executed. Only `readFile`. Whether to install is decided by the separate gate below.
- Directories only, **no `.tgz` parsing**; the package's inner `node_modules` is skipped; single files over 2 MiB, bundles over 10 MiB and more than 500 files are skipped and noted in the report.
- **Automatic triggering only covers installs from the plugin page**: it subscribes to `plugin-manager/changed`. That event's payload has only `reason` and **no package name**, so the new package is located by diffing `scanProfile`'s `bundles` before and after; official docs say CLI installs and manual edits do not emit it. Subscription uses the in-process Cordis event table (`ctx.on`), a single instance shared by the whole context tree — independent of load order and of whether the contexts are siblings. `tests/review.spec.ts` pins that premise down with a real `Context`, and has an end-to-end case. **Verified against the real dsh desktop build** (0.15.0 build): `apply` ran, `ctx.on` subscribed, and toggling a plugin delivered two `{reason:"bundle"}` events. `bundles` did not change in that test, so the diff was empty and the review correctly skipped; the step where an actually new package triggers a review has not been exercised. Results go to an in-memory cache plus one log line, read via `/review`. **Do not rely on it as a gate.**

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

### Pre-install self-check (no automatic blocking)

Before installing new skills, run the check manually against the directory you are about to import:

```bash
npx --package dsh-skill-doctor dsh-skill-lint <candidate-dir> --json --warn-as-error
```

`--json` gives machine-readable `ok / summary / findings`, and `--warn-as-error` makes warnings fail too; exit code `1` can drive a script that decides whether to continue. SD012 flags raw ESC, invisible Unicode tag characters and download-piped-straight-into-a-shell forms, all as `warn` heuristics: a skill that teaches `curl` will also match, and a hit is not a malware verdict.

**You start this skill check yourself**; the plugin does not hook the skill import flow.

### Install gate (inspect before installing)

This release adds an **optional** install gate. It fetches the registry tarball, inspects it in memory, refuses on high-risk findings, and only then calls dsh's official `installBundle`. All three entry points share one verdict:

**Turning it off**: the gate is its own component row (`skill-doctor-gate`). Switching it off in the plugin page releases installs started from the plugin page and from model tools; `--gate` on the command line and the `/install` command belong to the main row and still inspect. The switch takes effect immediately — the row switch unloads that fiber, and the restore function registered through `ctx.effect` puts `installBundle` back, so no restart is needed (inferred from the same mechanism the compat row uses; this row has not been stepped through in a real dsh build). The old `installGate` config key is still accepted but no longer takes effect, and logs a migration hint.

```bash
# Git Bash: inspect only, for scripts to consume the exit code
npx --package dsh-skill-doctor dsh-skill-lint --gate <pkg-or-exact-version> --json
```

```text
/install <pkg-or-exact-version>    slash command; inspects then installs inside dsh
```

**Rules**: GT001 install scripts that pipe downloaded content into a shell, GT002 patches that overwrite official-scope entries or silently disable another plugin with `disabled: true`, GT003 runtime dependencies pointing at non-registry remote sources. These are `error`-level and refuse the install. RV001-RV012 remain `info`/`warn` hints shown for context only — normal bundles almost always contain `eval` or `postinstall`, so using them to block would reject legitimate packages.

**Exit codes**: `--gate` returns `0` on pass, `1` on a high-risk hit, `2` when the inspection could not finish. Any fetch, parse or network failure yields `decision: 'error'` — **fail closed, never treated as a pass**.

**Trust list (per-package override)**

The GT rules are heuristics: expect false positives, and expect the case where you simply want the package. Neither needs a config edit or switching the row off — add the package to the trust list:

```text
/doctor trust <pkg>        trust it; high-risk hits are then released, and the report says so
/doctor trust              list what is trusted and where the file lives
/doctor untrust <pkg>      revoke
```

The list lives at `$DSH_HOME/skill-doctor/trusted.json`, next to the checkup records but **not per profile** — trust is "I trust this package", and switching profiles should not mean re-recording it. It is keyed by **package name, not version**: trust applies to the package, not to one release. The file is read on every install, so adding an entry takes effect on the next retry with no restart.

Three deliberate choices:

- **Released is not the same as clean.** The findings still appear in the report; only the verdict changes, from "refuse" to "pass (high-risk hit, but trusted — released under your authorisation)", together with the revoke command.
- **`--gate` does not consult the list.** It is the inspect-only tool that scripts gate on; being whitelisted there would defeat the gate. The list affects `/install` and the plugin page only.
- **A corrupt file reads as empty.** Worst case the gate falls back to its default behaviour (still refusing what it should); throwing would make the install itself fail, which is worse than a false refusal.

When the plugin page refuses an install, the dialog names both ways out: `/doctor trust <pkg>` then retry, or switch the `skill-doctor-gate` row off temporarily.

**Boundaries (more important than the rule list)**:

- **Plugin-page installs are gated, command-line ones are not.** A plugin-page install calls `installBundle` on the `plugin-manager` service instance, and doctor wraps that very method, so **both the plugin page and the `plugin_manager` tool go through the gate**. This is measured, not assumed: wrapping `setBundleEnabled` on the real build showed the plugin-page toggle flow passing through the wrapper. CLI `dsh plugin add` and a hand-edited `package.json` followed by `pnpm install` never touch the service — that is the package manager write path and **cannot be covered**.
- **Fail open on the passive path.** The plugin-page path refuses only on a GT hit; a fetch failure, network error or a bug in the wrapper **lets the install through with a warning** — one hiccup should not block every install, and the user may not know doctor caused it. The proactive entry points (`--gate` / `/install`) still fail closed. For a false positive, or when you knowingly accept the risk, prefer `/doctor trust <pkg>` to release that one package (see below). To disable the gate entirely, switch the `skill-doctor-gate` row off in the plugin page, install, then switch it back on — no config edit, no restart, no need to uninstall the whole plugin.
- **The official approval chain is bypassed.** `/install` calls `ctx.pluginManager.installBundle` directly, skipping the `danger-full-access` / per-call approval enforced by the `plugin_manager` tool. It installs with host-process privileges and may run allowed build scripts. That is the cost of an automatic gate.
- **The inspected and installed package share the exact version and the same registry.** `--gate` accepts a bare name, an exact version or a dist-tag; ranges such as `^1` or `1.x` are rejected. The resolved `name@exactVersion` is passed to `installBundle`. The registry is aligned too: the plugin page passes an explicit `registry` to `installBundle`, and the gate **fetches from that same source** instead of re-reading `~/.npmrc`; `/install` hands the same source back to the installer.
  One difference cannot be removed: when the requested registry is unreachable, pnpm falls back to the configured one, so **byte-identical content is still not guaranteed**. An explicitly passed registry that is not a valid http(s) URL makes the gate return `error` and it does **not** fall back — a silent fallback would recreate the inspect-A-install-B gap.
- **Failures name their cause.** `problem` carries a fixed category, never a URL or local path: `version-not-found`, `http-404`, `network-error`, `timeout`, `bad-packument`, `no-tarball`, `tarball-too-large`, `registry-override-invalid`. This matters because network failures used to collapse into `UNKNOWN`, leaving no way to tell a broken connection from a bad package.
- **Nothing is written during inspection.** The tarball is decompressed in memory with a hand-written tar reader; no temp directory, no cleanup, no code from the reviewed package executed.
- **Not a malware verdict.** No AST, sandbox or dependency supply-chain audit. The GT rules are structural heuristics with both false negatives and false positives.

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

## External skill sources (optional second row)

From 0.14.0 the package exposes component rows in the plugin page, each with its own switch (the first two also carry their own `config`). There are **three** today:

| Row | Module | What it does |
|---|---|---|
| `skill-doctor` | `dsh-skill-doctor` | Four checkup tools, slash commands, panel (read-only diagnosis) |
| `skill-doctor-gate` | `dsh-skill-doctor/gate` | Wraps `installBundle` and inspects the tarball before a plugin-page install; switching it off lets the install through |
| `skill-doctor-compat` | `dsh-skill-doctor/compat` | Mounts Claude Code / Codex / ZCode skill directories into the dsh skill view |

Switching any row off unloads only that row: the mount row drops the provider, the gate row removes the wrapper, and the checkup keeps running. Why separate modules: one component row in dsh is one child under `- insert:` in `cordis.patch.yml`, and a row switch acts on that row's whole fiber (unload/mount). Putting several abilities in one `apply()` would force them on and off together, so they live behind separate entry points exposed through `package.json` `exports` (`./compat`, `./gate`).

**Defaults**: all three sources are `true` in the shipped patch, so installing mounts them immediately; missing directories are skipped silently. A native dsh skill always wins over a same-named imported one (rank 100/400 < imported 210-470), and project-level imports beat user-level ones.

```yaml
- insert:
    - id: skill-doctor
      name: dsh-skill-doctor
      config:
        maxDescriptionLength: 500
    - id: skill-doctor-compat
      name: dsh-skill-doctor/compat
      config:
        sources:
          claude: true
          codex: false
          zcode: false
```

Fields on the second row (unknown keys fail fast; the plugin logs one warning and disables itself, **never blocking session creation**):

| Field | Default | Meaning |
|---|---|---|
| `sources` | all three on | `claude` / `codex` / `zcode`; use `false` to disable, or an object `{ enabled, project, root, rank }` |
| `extraDirs` | `[]` | Add arbitrary directories: `{ path, label?, rank? }` |
| `providerName` | `skill-doctor-compat` | Provider name, kept distinct from a separately installed `dsh-skill-compat-plus` |
| `slugifyNames` | `true` | Rewrite names that break dsh kebab-case; with it off those skills are skipped |
| `synthesizeDescription` | `true` | Claude allows a missing description; synthesize one from the first non-empty body line |

Fields are mapped on import: `when_to_use` / `whenToUse` -> `whenToUse`, `disable-model-invocation` and `user-invocable` are folded by meaning; fields with no dsh equivalent (`allowed-tools`, `model`, `hooks`) stay in metadata. Bodies are still read from the original file on demand, never copied.

**Four boundaries, read before installing:**

- **No hot reload.** `list()` results are cached by registry revision, so editing `SKILL.md` needs a dsh restart to be rediscovered (`get()` still reads the current file). This is what removing `chokidar` buys: **zero new runtime dependencies**.
- **Read-only discovery, not management.** It never installs, deletes or rewrites foreign skill files, and never executes a skill's scripts.
- **Imported skills are checked too.** `SD002` (kebab-case name) and `SD004` (500-char truncation) are dsh conventions, not universal standards, so foreign skills easily produce false positives. To see native skills only, add `excludeProviders: [skill-doctor-compat]` to the first row.
- **Not the same as `extraRoots`.** `extraRoots` scans files once during a checkup (one-off, affects the report only); `compat` mounts skills into the model-visible catalogue at runtime (persistent). Both can stay off.

> Update (2026-11-08): `dsh-plugin-skill-autoroute` from the community listens to dsh's native `skills/change` event to invalidate its own catalogue cache, which suggests a cheaper path than a resident `chokidar` watcher. **Unverified**: whether that event can make a third-party provider trigger a registry re-collect (that plugin only invalidates its own cache). Until verified, this plugin still has no hot reload and the conclusion above stands.

> The third-party subpath `name: dsh-skill-doctor/compat` has been verified in a real dsh desktop build: the plugin page showed two component rows, both running (that build predates the third row, `skill-doctor-gate`; it loads the same way). That validates loading and fibers, not the exact provider/source values imported skills get inside a real `/doctor` report. If the second row misbehaves in your environment, check the load error in devtools first.

### Provenance & shadowing (a new report metric)

From 0.15.0 the report gains a "Provenance & shadowing" section answering two catalogue-level questions:

- **Where these skills came from.** Grouped by `provider` and source root, listing the actual strings without guessing which are "native" or "imported".
- **Which same-named skill actually runs.** With the registry verdict, it names the winner: `demo  winner -> ~/.claude/skills/demo/SKILL.md`, others labelled shadowed. The basis: `ctx.skills.snapshot()` returns the already-adjudicated catalogue — each name appears exactly once — so matching the winner's file path against the candidates settles it. When paths do not match (e.g. `/scope` pointed at a directory never registered with the registry), it honestly reports "winner undetermined, registry is authoritative" instead of guessing.

Every path is folded before it enters a report: home directory becomes `~`, the project root becomes `<project>`, other absolute paths keep only the last two segments without the drive letter. Like the announcement budget, this section is display-only — no Finding, no baseline entry, no change to `ok` or exit codes — and it only appears when sources differ or a same-named group exists, so single-source reports stay unchanged.

### Announcement budget (a new report metric)

dsh does not hand the model skill bodies; it first injects a compact first-layer catalogue with only `name` / `description` / `whenToUse` per skill. That catalogue stays in context, so its **total length** is a budget: every skill can pass individually while dozens of them together push trailing entries out, which shows up as "installed but never triggers". Per-skill rules (including SD004's 500-char truncation) cannot see this aggregate problem. It only became worth measuring after the second row mounted roughly 50 external skills.

From 0.15.0, once the catalogue reaches ten skills, or half the reference budget in characters, the report gains an "Announcement budget" section with the participating skill count, measured characters and a rough token estimate; JSON always carries an `announcement` field. Small plain-text reports stay byte-identical, so the published "example output" screenshots are unaffected. This section is display-only: **no Finding**, no baseline entry, no change to `ok` or exit codes.

> **The 8000-character reference is not a known dsh threshold.** It comes from a comment in the community plugin `dsh-skill-hub` (described as Codex's hard cap for the initial skill list). We found no dsh documentation confirming the same value, and have not reproduced "trailing entries get truncated" in a real session. So this reports measured numbers only and never declares the budget exceeded; `referenceCalibrated: false` in JSON says the same thing.

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
- **Skills dsh never indexed** — a name that breaks the grammar, or frontmatter that fails to parse, is not in the view at all; point `roots` at that directory to scan files directly.
- **Whether a skill is well written** — not judged. Auto-fix covers two byte-level rules only.
- **Plugin-page installs are not gated** — `--review` is read-only and never rejects, rolls back or deletes. Only `--gate` / `/install` refuse, and only for installs they start themselves. The announcement budget also reports measured numbers only, without an exceeded verdict.
- **Token counts are estimates** — ASCII ≈ 4 chars/token, CJK ≈ 0.75 token/char.
- **Shadow detection only scans configured roots** — registry-internal candidates are invisible; results are labelled as candidates.
- **Remote/virtual skills get no file-level checks** — no local path, so encoding and reference rules are skipped.
- **The external-source row does not watch files.** It has no watcher, so editing `SKILL.md` needs a dsh restart; it also performs no semantic conversion beyond field mapping, so names that break dsh rules are either slugified or skipped.
- **Foreign skills are not judged by the rules of their original agent.** Checkups use dsh rules (SD001-SD015); a Claude / Codex skill is only reported as "how it behaves in dsh", not as broken in its original tool.

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

`skill_doctor` only sees the current dsh view. To check just a directory dsh does not index (`~/.claude/skills`), pass `roots` (a scope, not an addition).

**"runtime state not checked" in the plugin report**

That is a degradation, not a failure: `pluginInventory` is mounted on the desktop profile only.

**All tools vanished after editing config**

Invalid config disables the plugin on purpose, so a bad config cannot block the session. Check the field names and types in `cordis.patch.yml`.

## How it works

1. `ctx.skills.snapshot({ cwd, scope })` for the winning skills in the current view
2. `ctx.skills.get(name)` for the full body, proving it really resolves
3. When `path` is local, the raw `SKILL.md` is read once (read-only) for frontmatter/reference/encoding checks
4. Remote and virtual skills have no local path, so file-level rules are skipped
5. Two scope parameters with different semantics: `roots` **restricts** the scan to those directories (use it when the user names one), `extraRoots` **adds** roots on top of the session skills (for shadow detection)
6. File-level checks are read-only; there are exactly three write paths (`baseline` record JSON, `setDescription` for the confirmed line, `fix` for BOM/CRLF), each with a `.bak` and verification rollback
7. The second row is a separate module (`src/compat-entry.ts`) whose `apply()` only calls `ctx.skills.registerProvider()`; it discovers foreign skills read-only and takes part in none of the write paths above

It **never executes** the scripts inside a skill, **never rewrites** wording or semantics on its own (only the three verified write paths above), and **never sends** skill content over the network.

## How it relates to similar plugins

Three kinds of skill-adjacent plugins exist, and they answer different questions — they compose well:

- **Managers** (browse, search, import/export, delete skills): "where are my skills, how do I add or remove one".
- **Usage boards** (skill scoreboards, call-count rankings): "how often is it used". This plugin's panel counts loads too, but as evidence for diagnosis, not as a long-term dashboard.
- **Plugin auditors** (ecosystem scoring, route auth, pre-install gating): "is this plugin safe, can I install it" — and **refuse** the install when it is not.

This plugin answers **"why is it broken / why does the model not pick it"** — diagnosis. It has two hint groups (SD012, RV001-RV012) that never conclude, and three gate rules (GT001-GT003) that refuse only installs started through `--gate` / `/install`. There is no malware verdict and no full supply-chain audit; plugin-page installs are not intercepted.

From 0.14.0 the second row also mounts external skill directories, but only as read-only discovery: no browsing, add/remove, import/export, marketplace or hot reload. If `dsh-skill-compat-plus` is installed separately, both providers can coexist (different default names).

## Roadmap

- ✅ Prescription tiers (auto-fixable / one command / human only)
- ✅ Plugin runtime checkup (fiber phase + tool registry cross-reference)
- ✅ In-session activity panel + cross-session usage stats
- ✅ Record and follow-up (`baseline: auto`, on by default)
- ✅ Root-cause grouping, rule-threshold calibration against the dsh version
- ✅ Skill × plugin consultation (`PL006`)
- ✅ Rewrite worksheet + confirmed writes (`setDescription`)
- ✅ Scope parameter, slash commands and the Chinese menu
- ✅ Three component rows: checkup + install gate + optional external skill mounting (`./gate`, `./compat` subpath exports, zero new dependencies)
- ⬜ Rule documentation site and capability registry
- ⬜ `skill_ab`: run the same prompt with and without a skill, compare tokens, latency and output

## Development

```bash
npm install
npm run build     # tsc + esbuild (host / cli / client / compat)
npm test          # 399 tests
npm run smoke
npm run e2e:all   # real dsh headless, all groups
```

After changing the panel, run `npm run build` and restart dsh. `tests/client-bundle.spec.ts` checks the bundle shell, exports and slot registration; the visuals still need human eyes.

## License

MIT
