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
  /** 病历文件路径（支持 ~）；配 `auto` 则由插件按 profile 自动维护（会话内全自动复诊）。 */
  baseline?: string
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
  readonly baseline?: string
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

  let baseline: string | undefined
  if (raw.baseline !== undefined) {
    if (typeof raw.baseline !== 'string' || raw.baseline.trim().length === 0) {
      throw new Error('baseline must be a non-empty string (path to the record file)')
    }
    baseline = raw.baseline.trim()
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
    ...baseline === undefined ? {} : { baseline },
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
