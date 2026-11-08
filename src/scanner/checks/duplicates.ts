/**
 * 同名技能 / 遮蔽检测。
 *
 * 默认只做「候选」判断：扫描到两个同名的 SKILL.md，只能说 dsh 会加载其中一个，
 * 因为裁决发生在 registry（按 provider rank），扫描器看不到那一步。
 * 调用方如果拿到了 registry 的 snapshot，可以传入 winners，此时才能确定地说
 * 「哪一份胜出、哪一份被遮蔽」。
 */
import { comparablePath } from '../text.js'
import type { Finding, SkillInput, WinnerInfo } from '../../types.js'

/** 为每个技能生成其同名候选 findings；Map 以技能对象身份为键。 */
export function duplicateFindingsBySkill(
  skills: readonly SkillInput[],
  winners?: ReadonlyMap<string, WinnerInfo>,
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

    // 只有三个条件同时满足才敢升级措辞：
    // 1) 调用方给了 winners；2) 该名字在 registry 里有记录且有本地路径；
    // 3) 这个路径能与组内某个候选对上（ad-hoc 根可能根本没注册进 registry）。
    // 否则保持原来的「候选」文案，不臆测胜负。
    const winnerPath = comparablePath(winners?.get(name)?.path)
    const winnerSkill = winnerPath === undefined
      ? undefined
      : group.find(skill => comparablePath(skill.path) === winnerPath)

    for (const skill of group) {
      const findings = result.get(skill) ?? []
      const message = winnerSkill === undefined
        ? `有 ${group.length} 个技能都叫 "${name}"，分别在这些位置：${files}。dsh 只会加载其中一个，另一个等于不存在。`
        : `有 ${group.length} 个技能都叫 "${name}"，分别在这些位置：${files}。registry 实际加载的是 ${winnerSkill.path}；`
          + (skill === winnerSkill
            ? '这一份是生效的，其余同名副本等于不存在。'
            : `这一份被遮蔽，等于不存在（生效的是 ${winnerSkill.path}）。`)
      findings.push({
        rule: 'SD009',
        severity: 'warn',
        message,
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
