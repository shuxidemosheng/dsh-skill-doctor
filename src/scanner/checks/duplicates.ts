/** 同名技能/遮蔽检测（候选 root 扫描，非权威合并）。 */
import type { Finding, SkillInput } from '../../types.js'

/** 为每个技能生成其同名候选 findings；Map 以技能对象身份为键。 */
export function duplicateFindingsBySkill(
  skills: readonly SkillInput[],
): Map<SkillInput, Finding[]> {
  const groups = new Map<string, SkillInput[]>()
  for (const skill of skills) {
    const list = groups.get(skill.name) ?? []
    list.push(skill)
    groups.set(skill.name, list)
  }

  const result = new Map<SkillInput, Finding[]>()
  for (const [name, group] of groups) {
    if (group.length < 2) continue
    const files = group
      .map(skill => skill.path ?? `${skill.provider}:${skill.name}`)
      .join(', ')
    for (const skill of group) {
      const findings = result.get(skill) ?? []
      findings.push({
        rule: 'SD009',
        severity: 'warn',
        message: `有 ${group.length} 个技能都叫 "${name}"，分别在这些位置：${files}。dsh 只会加载其中一个，另一个等于不存在。`,
        file: skill.path,
        suggestion: '确认最后生效的是哪一个；把多余的副本改名或删掉，避免改了半天没生效。',
      })
      result.set(skill, findings)
    }
  }
  return result
}

/** 扁平版本，供 CLI 汇总使用。 */
export function checkDuplicates(skills: readonly SkillInput[]): Finding[] {
  const all: Finding[] = []
  for (const findings of duplicateFindingsBySkill(skills).values()) all.push(...findings)
  return all
}
