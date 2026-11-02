#!/usr/bin/env node
/** dsh-skill-lint：不依赖 dsh 运行时的技能 lint CLI，供技能作者与 CI 使用。 */
import { basename } from 'node:path'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import {
  buildBaseline,
  currentMetaOf,
  diffBaseline,
  expandHome,
  loadBaseline,
  saveBaseline,
} from './baseline.js'
import { resolveConfig, withRuleFilter, type ResolvedConfig } from './config.js'
import { RULE_IDS, RULES } from './scanner/rules.js'
import { scanRoots, scanSkillFile } from './scanner/fs-scan.js'
import { lintSkill, lintSkills } from './scanner/scan.js'
import { renderLintJson, renderLintMarkdown } from './tools/report.js'
import { renderPluginJson, renderPluginMarkdown } from './plugins/report.js'
import { scanProfile } from './plugins/scan.js'
import { applyFixes, type FixOutcome, type Verify } from './fixer/apply.js'
import { setDescription } from './fixer/description.js'
import { FIXABLE_RULES, planFixes, type FixableRule } from './fixer/plan.js'
import { renderFixJson, renderFixMarkdown, type UnfixableHit } from './fixer/report.js'
import { readDshVersion } from './version-check.js'
import type { ScanResult, Severity } from './types.js'

const VERSION = '0.11.1'

interface CliOptions {
  readonly paths: string[]
  readonly json: boolean
  readonly warnAsError: boolean
  readonly maxDescription?: number
  readonly maxBodyTokens?: number
  readonly severity?: Severity
  readonly rules?: string[]
  readonly help: boolean
  readonly version: boolean
  readonly plugins: boolean
  readonly profile?: string
  readonly fix: boolean
  readonly apply: boolean
  readonly only?: FixableRule[]
  readonly save?: string
  readonly compare?: string
  readonly setDescription?: string
  readonly from?: string
}

function fail(message: string): never {
  process.stderr.write(`dsh-skill-lint: ${message}\n`)
  process.exit(2)
}

function positiveInteger(flag: string, value: string | undefined): number {
  if (value === undefined) fail(`${flag} requires a value`)
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`${flag} must be a positive integer`)
  return parsed
}

function parseArgs(argv: readonly string[]): CliOptions {
  const paths: string[] = []
  let json = false
  let warnAsError = false
  let maxDescription: number | undefined
  let maxBodyTokens: number | undefined
  let severity: Severity | undefined
  const rules: string[] = []
  let help = false
  let version = false
  let plugins = false
  let profile: string | undefined
  let fix = false
  let apply = false
  let save: string | undefined
  let compare: string | undefined
  let setDescriptionTarget: string | undefined
  let from: string | undefined
  const only: FixableRule[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    switch (arg) {
      case '--json': json = true; break
      case '--warn-as-error': warnAsError = true; break
      case '--plugins': plugins = true; break
      case '--profile': profile = argv[++i]; break
      case '--fix': fix = true; break
      case '--apply': apply = true; break
      case '--save': {
        const value = argv[++i]
        if (value === undefined || value.trim().length === 0) fail('--save requires a file path')
        save = value.trim()
        break
      }
      case '--compare': {
        const value = argv[++i]
        if (value === undefined || value.trim().length === 0) fail('--compare requires a file path')
        compare = value.trim()
        break
      }
      case '--set-description': {
        const value = argv[++i]
        if (value === undefined || value.trim().length === 0) fail('--set-description requires a skill name')
        setDescriptionTarget = value.trim()
        break
      }
      case '--from': {
        const value = argv[++i]
        if (value === undefined || value.trim().length === 0) fail('--from requires a file path')
        from = value.trim()
        break
      }
      case '--only': {
        const value = argv[++i]
        if (value === undefined) fail(`--only must be one of: ${FIXABLE_RULES.join(', ')}`)
        for (const part of value.split(',')) {
          const name = part.trim().toUpperCase()
          if (!(FIXABLE_RULES as readonly string[]).includes(name)) {
            fail(`--only must be one of: ${FIXABLE_RULES.join(', ')}`)
          }
          only.push(name as FixableRule)
        }
        break
      }
      case '--all': break
      case '--help':
      case '-h': help = true; break
      case '--version':
      case '-v': version = true; break
      case '--max-description': maxDescription = positiveInteger(arg, argv[++i]); break
      case '--max-body-tokens': maxBodyTokens = positiveInteger(arg, argv[++i]); break
      case '--severity': {
        const value = argv[++i]
        if (value !== 'info' && value !== 'warn' && value !== 'error') {
          fail('--severity must be one of: info, warn, error')
        }
        severity = value
        break
      }
      case '--rule': {
        const value = argv[++i]
        if (value === undefined || !(RULE_IDS as readonly string[]).includes(value)) {
          fail(`--rule must be one of: ${RULE_IDS.join(', ')}`)
        }
        rules.push(value)
        break
      }
      default:
        if (arg.startsWith('-')) fail(`unknown option: ${arg}`)
        paths.push(arg)
    }
  }

  // --apply 单独出现是没意义的，也最可能是手滑；直接拒绝比“静默什么都做”好。
  // 但 --set-description 是合法的写路径：内容来自用户确认过的草稿，--apply 才落盘。
  if (apply && !fix && setDescriptionTarget === undefined) fail('--apply only makes sense together with --fix or --set-description')
  // --save 存的是“这次体检”的快照；--fix 会当场改文件，存下来的就是旧状态了。
  if (save !== undefined && fix) fail('--save cannot be used together with --fix')
  // 两个写路径互斥：一个改 BOM/CRLF，一个改 description，混在一起没法判断意图。
  if (setDescriptionTarget !== undefined && fix) fail('--set-description cannot be used together with --fix')
  if (setDescriptionTarget !== undefined && save !== undefined) fail('--set-description cannot be used together with --save')

  return {
    paths: paths.length === 0 ? ['.'] : paths,
    json,
    warnAsError,
    ...maxDescription === undefined ? {} : { maxDescription },
    ...maxBodyTokens === undefined ? {} : { maxBodyTokens },
    ...severity === undefined ? {} : { severity },
    ...rules.length === 0 ? {} : { rules },
    plugins,
    ...profile === undefined ? {} : { profile },
    fix,
    apply,
    ...only.length === 0 ? {} : { only },
    ...save === undefined ? {} : { save },
    ...compare === undefined ? {} : { compare },
    ...setDescriptionTarget === undefined ? {} : { setDescription: setDescriptionTarget },
    ...from === undefined ? {} : { from },
    help,
    version,
  }
}

function usage(): string {
  return [
    'Usage: dsh-skill-lint [path ...] [options]',
    '',
    'Scan skill files and report structural, budget, reference and heuristic findings.',
    '',
    'Options:',
    '  --plugins              check installed plugins for structural conflicts (no skill scanning)',
    '  --profile <name>       profile to inspect with --plugins (default desktop)',
    '  --json                 machine-readable output',
    '  --warn-as-error        exit 1 when any warning is present',
    '  --max-description <n>  description length limit (default 500)',
    '  --max-body-tokens <n>  body token budget (default 8000)',
    '  --severity <level>     info | warn | error (default info)',
    '  --rule <id>            only run this rule; repeatable',
    '  --all                  accepted for compatibility (roots are scanned one level)',
    '',
    'Fix options (only byte-exact fixes; semantic problems are never touched):',
    `  --fix                  plan fixes for ${FIXABLE_RULES.join(' / ')}; writes nothing`,
    '  --apply                write the planned fixes (backs up to <file>.bak first)',
    `  --only <rule,...>      restrict --fix to these rules: ${FIXABLE_RULES.join(', ')}`,
    '',
    'Follow-up options (medical record / re-examination):',
    '  --save <file>          save this scan as a baseline (medical record) for later comparison',
    '  --compare <file>       compare this scan against a baseline; adds a follow-up section',
    '',
    'Description writing (applies a user-confirmed draft; plan only until --apply):',
    '  --set-description <n>  write a new description into skill <n> (single line, within limit)',
    '  --from <file>          the new description comes from this UTF-8 file (or stdin)',
    '',
    '  --help, -h             show this help',
    '  --version, -v          show version',
    '',
    `Rules: ${RULE_IDS.join(', ')}`,
    '',
    'Exit codes: 0 clean, 1 findings, 2 usage/read error.',
  ].join('\n')
}

/** 汇总“命中了但不在可修范围”的规则，报告里要解释为什么没动它们。 */
function summarizeUnfixable(result: ScanResult): UnfixableHit[] {
  const counts = new Map<string, number>()
  for (const item of result.results) {
    for (const finding of item.findings) {
      if ((FIXABLE_RULES as readonly string[]).includes(finding.rule)) continue
      counts.set(finding.rule, (counts.get(finding.rule) ?? 0) + 1)
    }
  }
  return [...counts].map(([rule, count]) => ({
    rule,
    count,
    plainTitle: RULES[rule as keyof typeof RULES].plainTitle,
  }))
}

/**
 * `--fix` 分支：默认只出计划，`--apply` 才落盘。
 * @param options - 已解析的命令行选项。
 * @param result - 本次 lint 的完整结果（修复计划与复验基线都来自它）。
 * @param config - 用户配置（只读，取 maxFileBytes）。
 * @param effective - 叠加了 --rule/--severity 的配置，复验必须用同一份，
 *                    否则“修完的错误数”和“原来的错误数”没有可比性。
 */
async function runFix(
  options: CliOptions,
  result: ScanResult,
  config: ResolvedConfig,
  effective: ResolvedConfig,
): Promise<void> {
  const plan = await planFixes(result.results, options.only ?? FIXABLE_RULES)
  const unfixable = summarizeUnfixable(result)

  let outcomes: FixOutcome[] | undefined
  if (options.apply && plan.targets.length > 0) {
    // 复验基线：同一份文件修复前有多少个 error。
    // 只看 error 而不是全部 finding，是因为修 BOM 可能顺带让 SD001 消失，那是好事。
    const baseline = new Map<string, number>()
    for (const item of result.results) {
      if (item.skill.path !== undefined) baseline.set(item.skill.path, item.errors)
    }

    const verify: Verify = async target => {
      // 按文件重新扫一遍，而不是复用内存里的对象：要证明的是“磁盘上现在这份是好的”。
      const skill = await scanSkillFile(target.file, config.maxFileBytes)
      if (skill === undefined) return ['修复后这个文件读不出来了']
      const after = await lintSkill(skill, effective)
      const problems: string[] = []
      const remaining = [...new Set(
        after.findings
          .filter(item => item.rule === 'SD013' || item.rule === 'SD014')
          .map(item => item.rule),
      )]
      if (remaining.length > 0) problems.push(`修完仍然命中 ${remaining.join('、')}`)
      const errorsBefore = baseline.get(target.file)
      if (errorsBefore !== undefined && after.errors > errorsBefore) {
        problems.push(`修完出现了新的错误（现在 ${after.errors} 个，原来 ${errorsBefore} 个）`)
      }
      return problems
    }

    outcomes = await applyFixes(plan.targets, verify)
  }

  const report = {
    plan,
    ...outcomes === undefined ? {} : { outcomes },
    unfixable,
  }
  process.stdout.write(`${options.json ? renderFixJson(report) : renderFixMarkdown(report)}\n`)

  if (outcomes === undefined) {
    // 试运行：有可修项就返回 1，等于告诉 CI“还有能自动清理的东西”。
    process.exitCode = plan.targets.length === 0 ? 0 : 1
    return
  }
  process.exitCode = outcomes.every(item => item.status === 'applied') ? 0 : 1
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return
  }

  // 插件体检不依赖技能扫描，也不读技能配置，先单独分流。
  if (options.plugins) {
    const report = await scanProfile(options.profile ?? 'desktop')
    process.stdout.write(`${options.json ? renderPluginJson(report) : renderPluginMarkdown(report)}\n`)
    process.exitCode = report.conflicts.some(item => item.severity === 'error') ? 1 : 0
    return
  }

  let config
  try {
    config = resolveConfig({
      ...options.maxDescription === undefined ? {} : { maxDescriptionLength: options.maxDescription },
      ...options.maxBodyTokens === undefined ? {} : { maxBodyTokens: options.maxBodyTokens },
      ...options.severity === undefined ? {} : { severityThreshold: options.severity },
    })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }

  const scan = await scanRoots(options.paths, config.maxFileBytes)
  for (const issue of scan.issues) process.stderr.write(`dsh-skill-lint: ${issue}\n`)

  if (scan.skills.length === 0) {
    process.stderr.write('dsh-skill-lint: no skills found\n')
    process.exitCode = 0
    return
  }

  const effective = withRuleFilter(config, options.rules, options.severity)
  const result = await lintSkills(scan.skills, effective)

  if (options.setDescription !== undefined) {
    const draft = options.from !== undefined
      ? readFile(options.from, 'utf8')
      : Promise.resolve(readFileSync(0, 'utf8'))
    const text = (await draft).replace(/^\uFEFF/, '')
    const outcome = await setDescription({
      skillName: options.setDescription,
      draft: text,
      candidates: scan.skills,
      config,
      apply: options.apply,
    })
    process.stdout.write(`${options.json ? JSON.stringify(outcome, null, 2) : [
      `# 写入 description：\`${outcome.skillName}\``,
      '',
      outcome.status === 'planned'
        ? '状态：**计划（未写入）**——确认无误后加 `--apply` 执行。'
        : outcome.status === 'applied'
          ? '状态：✅ **已写入**（原文件备份在 .bak）。'
          : `状态：⛔ ${outcome.error}`,
      `文件：${outcome.file}`,
      `长度：${outcome.beforeLength} → ${outcome.afterLength} 字（上限 ${config.maxDescriptionLength}）`,
      '',
      '写完后重跑体检：复诊对比里会显示这次修复。',
    ].join('\n')}\n`)
    process.exitCode = outcome.status === 'failed' ? 2 : 0
    return
  }

  if (options.fix) {
    await runFix(options, result, config, effective)
    return
  }

  // 复诊：先算差值再存新病历，这样「对比旧病历 + 保存新病历」可以一条命令完成。
  let baselineDiff: ReturnType<typeof diffBaseline> | undefined
  let baselineLabel: string | undefined
  let baselineMissing: string | undefined
  if (options.compare !== undefined) {
    const path = expandHome(options.compare)
    const baseline = await loadBaseline(path)
    if (baseline === undefined) {
      baselineMissing = path
      process.stderr.write(`dsh-skill-lint: cannot read baseline "${path}" (missing or invalid); skipping comparison\n`)
    } else {
      baselineDiff = diffBaseline(baseline, result, currentMetaOf(effective))
      baselineLabel = `\`${basename(path)}\`（${baseline.savedAt.slice(0, 10)} 存档）`
    }
  }
  if (options.save !== undefined) {
    const path = expandHome(options.save)
    await saveBaseline(path, buildBaseline(result, currentMetaOf(effective)))
    process.stderr.write(`dsh-skill-lint: baseline saved to ${path}\n`)
  }

  const reportOptions = {
    maxDescriptionLength: config.maxDescriptionLength,
    dshVersion: await readDshVersion(),
    ...baselineDiff === undefined ? {} : { baselineDiff },
    ...baselineLabel === undefined ? {} : { baselineLabel },
    ...baselineMissing === undefined ? {} : { baselineMissing },
  }
  process.stdout.write(`${options.json
    ? renderLintJson(result, reportOptions)
    : renderLintMarkdown(result, reportOptions)}\n`)

  if (result.errors > 0 || (options.warnAsError && result.warnings > 0)) process.exitCode = 1
}

await main()
