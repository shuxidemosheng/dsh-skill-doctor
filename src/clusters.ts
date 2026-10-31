/**
 * 共性问题聚类：把 N 个同规则的命中，看成 1 个根因。
 *
 * 为什么要做这个：29 个技能里 13 个都"简介超长"，如果逐条列，用户看到的是
 * 13 条噪音，改完 3 条还剩 10 条；而真实原因往往只有一个——它们来自同一套模板。
 * 医生看到同一栋楼 13 个人铅中毒，不会开 13 张处方，会去查水管。
 *
 * 这里只做聚类与"共同特征"的推测，不下断言：共同前缀只说明"命名相似"，
 * 不等于它们真是同一套模板生成的，报告里用"多半/大概率"这种措辞。
 */
import { RULES } from './scanner/rules.js'
import type { RuleId, SkillLintResult } from './types.js'

/** 至少这么多个技能命中，才值得当成共性问题。 */
const MIN_COUNT = 3

/** 至少占全部技能的这么多比例；技能少时靠 COUNT，技能多时靠 SHARE。 */
const MIN_SHARE = 0.2

/** 一组同规则的命中。 */
export interface RuleCluster {
  readonly rule: RuleId
  /** 人话标题，直接放进报告。 */
  readonly plainTitle: string
  readonly count: number
  /** 占全部技能的比例，0–1。 */
  readonly share: number
  /** 命中的技能名，按名字排序，方便看。 */
  readonly skills: readonly string[]
  /** 名字的公共前缀；有值说明这些技能命名同源，多半出自同一套模板。 */
  readonly commonPrefix?: string
}

/** 按 `-` 分段求公共前缀；只返回"完整段"，不返回半个单词。 */
function commonNamePrefix(names: readonly string[]): string | undefined {
  if (names.length < 2) return undefined
  const parts = names.map(name => name.split('-'))
  const first = parts[0]
  if (first === undefined) return undefined

  // names 来自 Set（同一技能只算一次），所以不会出现"全部同名"——
  // 那是 SD009 的重名问题，轮不到这里判断。
  let length = 0
  for (let index = 0; index < first.length; index++) {
    const segment = first[index]
    if (segment === undefined || segment.length === 0) break
    if (!parts.every(other => other[index] === segment)) break
    length = index + 1
  }

  if (length === 0) return undefined
  return first.slice(0, length).join('-')
}

/**
 * 从多技能结果里聚出共性问题。
 * @param results - 全部技能的结果。
 */
export function clusterFindings(results: readonly SkillLintResult[]): RuleCluster[] {
  const total = results.length
  if (total === 0) return []

  // rule → 命中的技能名集合（同一技能同一规则出现多次只算一个）。
  const byRule = new Map<RuleId, Set<string>>()
  for (const result of results) {
    for (const finding of result.findings) {
      const set = byRule.get(finding.rule) ?? new Set<string>()
      set.add(result.skill.name)
      byRule.set(finding.rule, set)
    }
  }

  const clusters: RuleCluster[] = []
  for (const [rule, names] of byRule) {
    const count = names.size
    const share = count / total
    if (count < MIN_COUNT || share < MIN_SHARE) continue
    const skills = [...names].sort()
    const prefix = commonNamePrefix(skills)
    clusters.push({
      rule,
      plainTitle: RULES[rule].plainTitle,
      count,
      share,
      skills,
      ...prefix === undefined ? {} : { commonPrefix: prefix },
    })
  }

  // 影响面大的排前面；同数量时按规则 ID 稳定排序。
  clusters.sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule))
  return clusters
}

/**
 * 一句根因推测。
 * @param cluster - 聚类结果。
 */
export function clusterHint(cluster: RuleCluster): string {
  if (cluster.commonPrefix !== undefined) {
    const matched = cluster.skills.filter(name => name.startsWith(`${cluster.commonPrefix}-`)).length
    const subject = matched === cluster.count
      ? `${cluster.count} 个技能全部`
      : `${cluster.count} 个技能里有 ${matched} 个`
    return `${subject}以 \`${cluster.commonPrefix}-\` 开头，大概率出自同一套模板——改模板比逐个改省事得多。`
  }
  return '这些技能没有共同的命名规律，可能各自独立写错，只能逐个看。'
}
