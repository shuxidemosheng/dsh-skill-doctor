/** 扫描编排：收集 findings → 规则覆盖 → 阈值过滤 → 汇总。 */
import type { ResolvedConfig } from '../config.js'
import type { Finding, ScanResult, Severity, SkillInput, SkillLintResult } from '../types.js'
import { checkBudget } from './checks/budget.js'
import { duplicateFindingsBySkill } from './checks/duplicates.js'
import { checkInstructions } from './checks/instructions.js'
import { checkResources } from './checks/resources.js'
import { checkStructure } from './checks/structure.js'

const RANK: Record<Severity, number> = { info: 0, warn: 1, error: 2 }

/** 应用 config.rules 覆盖与 severityThreshold；返回新的 finding 列表。 */
function applyRuleConfig(findings: readonly Finding[], config: ResolvedConfig): Finding[] {
  const threshold = RANK[config.severityThreshold]
  const out: Finding[] = []
  for (const finding of findings) {
    const override = config.rules[finding.rule]
    if (override === 'off') continue
    const severity = override ?? finding.severity
    if (RANK[severity] < threshold) continue
    out.push({ ...finding, severity })
  }
  return out
}

function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = RANK[b.severity] - RANK[a.severity]
    if (bySeverity !== 0) return bySeverity
    const byFile = (a.file ?? '').localeCompare(b.file ?? '')
    if (byFile !== 0) return byFile
    const byLine = (a.line ?? 0) - (b.line ?? 0)
    if (byLine !== 0) return byLine
    return a.rule.localeCompare(b.rule)
  })
}

function count(findings: readonly Finding[], severity: Severity): number {
  return findings.filter(finding => finding.severity === severity).length
}

/** 检查单个技能。 */
export async function lintSkill(
  skill: SkillInput,
  config: ResolvedConfig,
  extraFindings: readonly Finding[] = [],
): Promise<SkillLintResult> {
  const raw = [
    ...checkStructure(skill, config),
    ...checkBudget(skill, config),
    ...checkInstructions(skill),
    ...await checkResources(skill),
    ...extraFindings,
  ]
  const findings = sortFindings(applyRuleConfig(raw, config))
  const errors = count(findings, 'error')
  return {
    skill,
    findings,
    errors,
    warnings: count(findings, 'warn'),
    infos: count(findings, 'info'),
    ok: errors === 0,
  }
}

/**
 * 按配置过滤 provider。
 *
 * 单技能诊断也要用同一口径：否则 includeProviders/excludeProviders 在
 * “只查一个技能”和“查全部”两种模式下会给出不同结论。
 * @param skills - 待过滤的技能。
 * @param config - 解析后的配置。
 * @returns 保留下来的技能（保持原顺序、原对象身份，方便后续按身份查 Map）。
 */
export function filterSkills(
  skills: readonly SkillInput[],
  config: ResolvedConfig,
): SkillInput[] {
  return skills.filter(skill => {
    if (config.includeProviders.length > 0 && !config.includeProviders.includes(skill.provider)) return false
    if (config.excludeProviders.includes(skill.provider)) return false
    return true
  })
}

/** 检查一批技能；先做 provider 过滤与同名检测。 */
export async function lintSkills(
  skills: readonly SkillInput[],
  config: ResolvedConfig,
): Promise<ScanResult> {
  const filtered = filterSkills(skills, config)
  const duplicates = duplicateFindingsBySkill(filtered)
  const results = await Promise.all(
    filtered.map(skill => lintSkill(skill, config, duplicates.get(skill) ?? [])),
  )
  const errors = results.reduce((sum, result) => sum + result.errors, 0)
  const warnings = results.reduce((sum, result) => sum + result.warnings, 0)
  const infos = results.reduce((sum, result) => sum + result.infos, 0)
  return { results, errors, warnings, infos, ok: errors === 0 }
}
