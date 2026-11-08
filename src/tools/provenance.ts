/**
 * 「来源与遮蔽」视图：把一次扫描的技能按 provider / 根目录分组，并结合
 * registry 的获胜者信息标出同名遮蔽。
 *
 * 设计边界（很重要）：
 * - 这个模块只**派生展示数据**，不产生 Finding、不改 SkillInput。病历
 *   （baseline）只按 finding.rule 计数，多一条 finding 就会让老病历误报
 *   「新冒出来一个」，所以视图必须独立于 findings 集合。
 * - 不猜测「原生 / 导入」：真实 dsh 会话里导入技能的 provider 取值还没逐项
 *   核对过，硬编一套分类迟早会写错。这里如实列出实际的 provider 字符串。
 * - 所有路径在离开本模块前都已折叠，报告、纯文本摘要、JSON 三条输出
 *   共用同一份脱敏结果，不会出现某一条漏改。
 */
import { comparablePath, formatProvenancePath } from '../scanner/text.js'
import type { ProvenanceShadow, ProvenanceView, SkillInput, WinnerInfo } from '../types.js'

/** 计数表转成稳定排序的数组：数量降序，同数量按名字字典序，方便测试断言。 */
function sortedCounts(map: Map<string, number>): { label: string; count: number }[] {
  return [...map.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/**
 * 技能所在「根目录」的展示标签。
 * `<root>/<skill>/SKILL.md` 要去掉文件名与技能目录两层，平铺的
 * `<root>/<name>.md` 只去掉一层；否则每个技能都会自成一个「根」，分组没意义。
 */
function rootLabel(skill: SkillInput, cwd: string | undefined): string {
  const raw = skill.path
  if (raw === undefined) return '(无本地路径)'
  const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '')
  const segments = normalized.split('/')
  const last = segments[segments.length - 1] ?? ''
  const drop = last.toLowerCase() === 'skill.md' ? 2 : 1
  const root = segments.slice(0, Math.max(0, segments.length - drop)).join('/')
  return formatProvenancePath(root.length === 0 ? '/' : root, cwd)
}

/**
 * 构造视图。返回 undefined 表示**这一节不必输出**。
 *
 * 条件渲染是刻意的：纯原生、单一 provider、又没有同名副本时，「来源」这一节
 * 只会重复统计行，还会挤掉纯文本报告的首屏。加了外部技能挂载（0.14.0 第二
 * 组件）或出现同名遮蔽后才值得展示；这样普通 `/scope` 示例报告与已发布的
 * 「示例输出」配图完全不受影响。
 */
export function buildProvenance(
  skills: readonly SkillInput[],
  winners?: ReadonlyMap<string, WinnerInfo>,
  cwd?: string,
): ProvenanceView | undefined {
  const byProvider = new Map<string, number>()
  const byRoot = new Map<string, number>()
  const groups = new Map<string, SkillInput[]>()
  for (const skill of skills) {
    const provider = skill.provider.length > 0 ? skill.provider : '(未知)'
    byProvider.set(provider, (byProvider.get(provider) ?? 0) + 1)
    const root = rootLabel(skill, cwd)
    byRoot.set(root, (byRoot.get(root) ?? 0) + 1)
    const list = groups.get(skill.name) ?? []
    list.push(skill)
    groups.set(skill.name, list)
  }

  const shadows: ProvenanceShadow[] = []
  for (const [name, group] of groups) {
    if (group.length < 2) continue
    // 与 SD009 用同一套比较口径（见 scanner/text.ts 的 comparablePath）。
    // 只有 winners 里该名字带 path、且能对上组内某个候选，才敢下确定结论；
    // ad-hoc 扫描的根可能压根没注册进 registry，此时必须降级为「候选」。
    const winnerPath = comparablePath(winners?.get(name)?.path)
    const winnerSkill = winnerPath === undefined
      ? undefined
      : group.find(skill => comparablePath(skill.path) === winnerPath)
    const display = (skill: SkillInput): string => formatProvenancePath(skill.path, cwd)
    shadows.push(winnerSkill === undefined
      ? { name, shadowed: group.map(display), resolved: false }
      : {
          name,
          winner: display(winnerSkill),
          shadowed: group.filter(skill => skill !== winnerSkill).map(display),
          resolved: true,
        })
  }

  if (byProvider.size < 2 && shadows.length === 0) return undefined

  return {
    byProvider: sortedCounts(byProvider).map(item => ({ provider: item.label, count: item.count })),
    byRoot: sortedCounts(byRoot).map(item => ({ root: item.label, count: item.count })),
    shadows,
  }
}

/** 纯文本摘要用的行：斜杠命令的输出是会话流里的文本节点，不能渲染表格。 */
export function provenancePlainLines(view: ProvenanceView): string[] {
  const lines = ['来源与遮蔽']
  lines.push(`· 按来源：${view.byProvider.map(item => `${item.provider} ${item.count}`).join(' · ')}`)
  lines.push('· 按根目录：')
  for (const item of view.byRoot.slice(0, 6)) lines.push(`    ${item.root}  ${item.count} 个`)
  if (view.byRoot.length > 6) lines.push(`    …还有 ${view.byRoot.length - 6} 个根目录`)

  if (view.shadows.length > 0) {
    lines.push('· 同名遮蔽：')
    for (const shadow of view.shadows.slice(0, 6)) {
      if (!shadow.resolved) {
        lines.push(`    ${shadow.name}  候选 ${shadow.shadowed.length} 个，未判定胜出者，以 registry 为准`)
        continue
      }
      lines.push(`    ${shadow.name}  胜出 → ${shadow.winner}`)
      for (const path of shadow.shadowed) lines.push(`          被遮蔽 → ${path}`)
    }
    if (view.shadows.length > 6) lines.push(`    …还有 ${view.shadows.length - 6} 组同名技能`)
  }
  return lines
}

/** 完整 Markdown 报告用的行；这里允许列表与代码样式，但路径仍是脱敏后的。 */
export function provenanceMarkdownLines(view: ProvenanceView): string[] {
  const lines = ['## 来源与遮蔽', '', '**按来源（provider）**', '']
  for (const item of view.byProvider) lines.push(`- \`${item.provider}\`：${item.count} 个`)
  lines.push('', '**按根目录**', '')
  for (const item of view.byRoot.slice(0, 6)) lines.push(`- \`${item.root}\`：${item.count} 个`)
  if (view.byRoot.length > 6) lines.push(`- …还有 ${view.byRoot.length - 6} 个根目录`)

  if (view.shadows.length > 0) {
    lines.push('', '**同名遮蔽**', '')
    for (const shadow of view.shadows.slice(0, 6)) {
      if (!shadow.resolved) {
        lines.push(`- \`${shadow.name}\`：${shadow.shadowed.length} 个同名候选，未判定胜出者，以 registry 为准。`)
        continue
      }
      lines.push(`- \`${shadow.name}\`：胜出 \`${shadow.winner}\``)
      for (const path of shadow.shadowed) lines.push(`  - 被遮蔽 \`${path}\``)
    }
    if (view.shadows.length > 6) lines.push(`- …还有 ${view.shadows.length - 6} 组同名技能`)
  }
  lines.push('')
  return lines
}

/** JSON 输出用的形状；与 Markdown / 纯文本同源，保证三种输出结论一致。 */
export function provenanceJson(view: ProvenanceView): Record<string, unknown> {
  return {
    byProvider: view.byProvider.map(item => ({ provider: item.provider, count: item.count })),
    byRoot: view.byRoot.map(item => ({ root: item.root, count: item.count })),
    shadows: view.shadows.map(shadow => ({
      name: shadow.name,
      resolved: shadow.resolved,
      winner: shadow.winner ?? null,
      shadowed: [...shadow.shadowed],
    })),
  }
}
