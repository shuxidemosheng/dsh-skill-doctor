#!/usr/bin/env node
/** dsh-skill-lint：不依赖 dsh 运行时的技能 lint CLI，供技能作者与 CI 使用。 */
import { resolveConfig, withRuleFilter } from './config.js'
import { RULE_IDS } from './scanner/rules.js'
import { scanRoots } from './scanner/fs-scan.js'
import { lintSkills } from './scanner/scan.js'
import { renderLintJson, renderLintMarkdown } from './tools/report.js'
import { renderPluginJson, renderPluginMarkdown } from './plugins/report.js'
import { scanProfile } from './plugins/scan.js'
import type { Severity } from './types.js'

const VERSION = '0.3.0'

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

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    switch (arg) {
      case '--json': json = true; break
      case '--warn-as-error': warnAsError = true; break
      case '--plugins': plugins = true; break
      case '--profile': profile = argv[++i]; break
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
    '  --help, -h             show this help',
    '  --version, -v          show version',
    '  --plugins              check installed plugins instead of skills',
    '',
    `Rules: ${RULE_IDS.join(', ')}`,
    '',
    'Exit codes: 0 clean, 1 findings, 2 usage/read error.',
  ].join('\n')
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
  const reportOptions = { maxDescriptionLength: config.maxDescriptionLength }
  process.stdout.write(`${options.json
    ? renderLintJson(result, reportOptions)
    : renderLintMarkdown(result, reportOptions)}\n`)

  if (result.errors > 0 || (options.warnAsError && result.warnings > 0)) process.exitCode = 1
}

await main()
