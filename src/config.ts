/** 配置解析：严格拒绝未知键与错误类型，给出稳定默认值。 */
import { RULE_IDS } from './scanner/rules.js'
import type { RuleId, Severity } from './types.js'

/** 用户在 cordis.patch.yml 里能写的字段。 */
export interface Config {
  /** 模型目录渲染的 description 上限，默认 500。 */
  maxDescriptionLength?: number
  /** 单技能正文 token 估算预算，默认 8000。 */
  maxBodyTokens?: number
  /** 单文件读取上限，默认 1 MiB。 */
  maxFileBytes?: number
  /** 额外扫描的技能根目录（支持 ~ 展开）。默认空。 */
  extraRoots?: string[]
  /** 规则级覆盖：off 关闭，其余覆盖默认级别。 */
  rules?: Record<string, Severity | 'off'>
  /** 输出过滤阈值；默认 info（全部显示）。 */
  severityThreshold?: Severity
  /** 只检查这些 provider；默认全部。 */
  includeProviders?: string[]
  /** 跳过这些 provider。 */
  excludeProviders?: string[]
  /**
   * 病历（复诊）配置：缺省即 `auto`——按 profile 自动维护，装好即有复诊，无需配置。
   * 也接受具体文件路径（支持 ~）或 `off`（显式关闭，不写任何病历）。
   */
  baseline?: string
  /**
   * 插件页安装门禁：`block`（默认）在命中 GT 高危规则时拒绝安装；
   * `off` 完全关闭。注意它只覆盖经由 plugin-manager 服务的安装，
   * CLI 的 dsh plugin add 与手改 package.json 后的 pnpm install 不经过它。
   */
  installGate?: 'block' | 'off'
}

/** 解析后的配置，所有字段必填。 */
export interface ResolvedConfig {
  readonly maxDescriptionLength: number
  readonly maxBodyTokens: number
  readonly maxFileBytes: number
  readonly extraRoots: readonly string[]
  readonly rules: Readonly<Partial<Record<RuleId, Severity | 'off'>>>
  readonly severityThreshold: Severity
  readonly includeProviders: readonly string[]
  readonly excludeProviders: readonly string[]
  /** `auto`（默认）/ 文件路径 / `off`。 */
  readonly baseline: string
  /** 插件页安装门禁：block（默认）或 off。 */
  readonly installGate: 'block' | 'off'
}

const SEVERITIES: readonly Severity[] = ['info', 'warn', 'error']
const KNOWN_KEYS = new Set<keyof Config>([
  'maxDescriptionLength',
  'maxBodyTokens',
  'maxFileBytes',
  'extraRoots',
  'rules',
  'severityThreshold',
  'includeProviders',
  'excludeProviders',
  'baseline',
  'installGate',
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(name: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function stringArray(name: string, value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim().length === 0)) {
    throw new Error(`${name} must be an array of non-empty strings`)
  }
  return value.map(item => item.trim())
}

function severity(name: string, value: unknown): Severity {
  if (typeof value !== 'string' || !SEVERITIES.includes(value as Severity)) {
    throw new Error(`${name} must be one of: info, warn, error`)
  }
  return value as Severity
}

/**
 * 校验并补齐配置。任何非法输入都抛错；调用方负责降级为 warn + 不激活。
 * @param input - patch 行里的 config，允许 undefined。
 * @returns 所有字段已补默认值的配置。
 */
export function resolveConfig(input: Config | undefined): ResolvedConfig {
  if (input !== undefined && !isPlainObject(input)) {
    throw new Error('config must be an object')
  }
  const raw = (input ?? {}) as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key as keyof Config)) {
      throw new Error(`unknown config key "${key}"`)
    }
  }

  const maxDescriptionLength = positiveInteger('maxDescriptionLength', raw.maxDescriptionLength, 500)
  const maxBodyTokens = positiveInteger('maxBodyTokens', raw.maxBodyTokens, 8000)
  const maxFileBytes = positiveInteger('maxFileBytes', raw.maxFileBytes, 1024 * 1024)
  const extraRoots = stringArray('extraRoots', raw.extraRoots)
  const includeProviders = stringArray('includeProviders', raw.includeProviders)
  const excludeProviders = stringArray('excludeProviders', raw.excludeProviders)
  const severityThreshold = raw.severityThreshold === undefined
    ? 'info'
    : severity('severityThreshold', raw.severityThreshold)

  // 默认 auto：复诊是本插件的核心能力，默认关闭等于让绝大多数用户永远发现不了它。
  // 代价只是往插件自己的数据目录写一份几 KB 的 JSON；不想要就显式写 off。
  let baseline = 'auto'
  if (raw.baseline !== undefined) {
    if (typeof raw.baseline !== 'string' || raw.baseline.trim().length === 0) {
      throw new Error('baseline must be a non-empty string: "auto", "off", or a record file path')
    }
    baseline = raw.baseline.trim()
  }

  // 默认 block：门禁的价值在于默认生效；误报时用 off 关掉即可，不必卸载插件。
  let installGate: 'block' | 'off' = 'block'
  if (raw.installGate !== undefined) {
    if (raw.installGate !== 'block' && raw.installGate !== 'off') {
      throw new Error('installGate must be "block" or "off"')
    }
    installGate = raw.installGate
  }

  let rules: Partial<Record<RuleId, Severity | 'off'>> = {}
  if (raw.rules !== undefined) {
    if (!isPlainObject(raw.rules)) throw new Error('rules must be an object')
    const normalized: Partial<Record<RuleId, Severity | 'off'>> = {}
    for (const [key, value] of Object.entries(raw.rules)) {
      if (!(RULE_IDS as readonly string[]).includes(key)) {
        throw new Error(`unknown rule id "${key}" in rules`)
      }
      if (value !== 'off') severity(`rules.${key}`, value)
      normalized[key as RuleId] = value as Severity | 'off'
    }
    rules = normalized
  }

  return {
    maxDescriptionLength,
    maxBodyTokens,
    maxFileBytes,
    extraRoots,
    rules,
    severityThreshold,
    includeProviders,
    excludeProviders,
    baseline,
    installGate,
  }
}

/**
 * 只保留指定规则（用于工具/CLI 的 `--rule` 过滤）。
 * @param config - 已解析配置。
 * @param rules - 要保留的规则 ID；undefined 表示不筛选。
 * @param severity - 可选的输出阈值覆盖。
 */
export function withRuleFilter(
  config: ResolvedConfig,
  rules: readonly string[] | undefined,
  severity: Severity | undefined,
): ResolvedConfig {
  const nextRules: Partial<Record<RuleId, Severity | 'off'>> = { ...config.rules }
  if (rules !== undefined) {
    for (const rule of rules) {
      if (!(RULE_IDS as readonly string[]).includes(rule)) {
        throw new Error(`unknown rule id "${rule}"; known: ${RULE_IDS.join(', ')}`)
      }
    }
    for (const rule of RULE_IDS) {
      if (!rules.includes(rule)) nextRules[rule] = 'off'
    }
  }
  return {
    ...config,
    rules: nextRules,
    severityThreshold: severity ?? config.severityThreshold,
  }
}
