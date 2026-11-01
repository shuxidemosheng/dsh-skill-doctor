/**
 * 改写工单：把「简介被截断」的诊断变成可执行的改写材料。
 *
 * 为什么要有这张工单：诊断出"13 个简介超长"之后，修复闭环断在语义层——
 * 插件不能替用户写文案（没有唯一解，纪律是"不自动改语义"），但会话里
 * 恰好有模型。工单的作用是把插件独有的信息（模型可见原文、被切原文、
 * 提取到的触发说法、字数预算）整理成结构化材料，由模型填稿、用户确认、
 * 写入后重跑体检用复诊对比验证闭环。
 *
 * 边界：本模块只产出材料和确定性骨架（触发词组句），绝不产出"已改好"
 * 的结论，也绝不写文件——写不写、写什么，决定权在用户。
 */
import type { SkillLintResult } from '../types.js'
import { analyzeTruncation, extractTriggers, oneLine, triggerLabel } from './report.js'

/** 工单只服务简介截断（SD004）；其他问题没有确定性的改写材料。 */
function isTruncated(result: SkillLintResult, limit: number): boolean {
  return result.errors === 0 && result.skill.description.length > limit
}

/**
 * 单技能改写工单。
 * @param result - 该技能的 lint 结果（用 description / findings，不用错误计数）。
 * @param limit - 模型目录的 description 上限。
 */
export function renderRewriteWorksheet(result: SkillLintResult, limit: number): string[] {
  const description = result.skill.description
  const lines: string[] = [
    `# 简介改写工单：\`${result.skill.name}\``,
    '',
    '**这是一张工单，不是最终文案。** 请基于下面的材料写出新简介，',
    '**先给用户确认，确认后再写入** SKILL.md 的 frontmatter（`name` 保持不变），',
    `写完重跑 \`skill_doctor { name: "${result.skill.name}" }\`——复诊对比里好转即闭环。`,
    '',
    '## 硬约束',
    '',
    `- 新简介不超过 **${limit} 字**（当前 ${description.length} 字，超限 ${description.length - limit} 字）。`,
    '- “什么时候用”必须写在前 80 字内：模型目录按前 ' + `${limit} 字渲染，且开头权重最高。`,
    '- 保留下面提取到的触发说法（用户平时真的会这么说），不要发明新说法。',
    '- 能力清单、边界说明移到正文（body）——正文不受简介上限约束。',
    '',
  ]

  if (description.length === 0) {
    lines.push(
      '## 现状材料',
      '',
      '当前简介是**空的**：模型完全不知道这个技能是干什么的。工单里没有原文可抄，',
      '触发说法也没有——请先向用户确认技能用途，再动笔。',
      '',
    )
    return lines
  }

  const info = analyzeTruncation(description, limit)
  const triggers = extractTriggers(description)

  lines.push(
    '## 现状材料',
    '',
    `- 模型当前可见的前 ${limit} 字：`,
    '',
    `> ${oneLine(description.slice(0, limit))}`,
    '',
  )
  const cut = description.slice(limit)
  if (cut.length > 0) {
    lines.push(
      `- 被切掉的 ${cut.length} 字（里面的触发说法模型完全看不到）：`,
      '',
      `> ${oneLine(cut)}`,
      '',
    )
  }
  if (triggers.length > 0) {
    lines.push(
      '- 提取到的触发说法（新简介的优先材料）：',
      '',
      ...triggers.map(trigger => `  - “${triggerLabel(trigger, 60)}”`),
      '',
    )
  }

  lines.push('## 确定性骨架（在此基础上润色，不要照抄）', '')
  if (triggers.length > 0) {
    const quoted = triggers.slice(0, 3).map(trigger => `「${triggerLabel(trigger, 20)}」`).join('')
    lines.push(
      `> 当用户说${quoted}时使用本技能。<用一句话概括这个技能做什么、解决什么问题>。`,
    )
  } else {
    lines.push('> 当用户<触发场景>时使用本技能。<用一句话概括这个技能做什么>。')
  }
  lines.push('')

  lines.push(
    '## 验收标准（写完自查）',
    '',
    `- 字数 ≤ ${limit}。`,
    '- 上面的触发说法全部出现在前 ' + `${limit} 字内。`,
    `- 重跑 \`skill_doctor { name: "${result.skill.name}" }\`：截断影响从“${info.level === 'high' ? '大' : '不大'}”变成“无”。`,
    '',
  )
  return lines
}

/**
 * 模板分组：按技能名的第一段归组（`nature-pdf` → `nature`），
 * 同段 ≥ 2 个才算模板组——不能复用 clusterFindings，那是按规则聚合的：
 * 所有截断技能会混进同一个 SD004 组，`solo-tool` 会把 `nature-*` 的公共前缀稀释掉。
 */
function groupByPrefix(truncated: readonly SkillLintResult[]): Map<string, SkillLintResult[]> {
  const groups = new Map<string, SkillLintResult[]>()
  for (const result of truncated) {
    const segment = result.skill.name.split('-')[0] ?? result.skill.name
    groups.set(segment, [...groups.get(segment) ?? [], result])
  }
  return groups
}

/**
 * 批量改写工单：只覆盖被截断的技能，按公共名字前缀归组。
 *
 * 13 个 `nature-*` 逐个写 13 份草稿是浪费——如果是同一套模板，
 * 正确做法是写一份模板简介 + 每个技能的变量段，这正是聚类想传达的。
 */
export function renderRewriteBatch(results: readonly SkillLintResult[], limit: number): string[] {
  const truncated = results
    .filter(result => isTruncated(result, limit))
    .sort((a, b) => b.skill.description.length - a.skill.description.length)

  if (truncated.length === 0) {
    return [
      '# 简介改写工单',
      '',
      '当前没有简介被截断的技能，不需要改写。',
      '（只处理简介超过上限的技能；其他问题没有确定性的改写材料，见体检报告的处方。）',
      '',
    ]
  }

  const lines: string[] = [
    `# 简介改写工单（${truncated.length} 个技能）`,
    '',
    '**这是一批工单，不是最终文案。** 逐个写出新简介草案，**全部先给用户确认，',
    '确认后才写入**各自的 SKILL.md（`name` 保持不变）；写完重跑 `skill_doctor`（不带参数），',
    '「复诊对比」里这些技能全部好转即闭环。',
    '',
    '## 硬约束（每张工单都适用）',
    '',
    `- 新简介不超过 **${limit} 字**；"什么时候用"写在前 80 字内。`,
    '- 保留每个技能已提取的触发说法；能力清单移到正文（body）。',
    '',
  ]

  for (const [segment, group] of groupByPrefix(truncated)) {
    const isTemplate = group.length >= 2
    if (isTemplate) {
      lines.push(
        `## 模板组 \`${segment}-*\`（${group.length} 个技能，大概率同一套模板）`,
        '',
        `**先写一份模板简介，再为每个技能替换变量**——比逐个写 ${group.length} 份省事，`,
        '且保证同一套技能的触发风格一致。',
        '',
      )
    }
    for (const result of group) {
      const info = analyzeTruncation(result.skill.description, limit)
      const triggers = extractTriggers(result.skill.description)
      lines.push(
        `### \`${result.skill.name}\`（${result.skill.description.length} 字 → 需 ≤ ${limit} 字）`,
        '',
        `- 触发说法：${triggers.length > 0 ? triggers.map(trigger => `“${triggerLabel(trigger, 50)}”`).join('、') : '（未能自动提取，读原文找）'}`,
        `- 模型可见的前 ${limit} 字：${oneLine(result.skill.description.slice(0, limit))}`,
      )
      if (isTemplate) {
        lines.push(`- 模板变量段：这个技能区别于同组其他技能的那句话（从被切掉的部分找）。`)
      } else if (info.level === 'high') {
        lines.push(`- 影响大：被切掉的部分里有触发说法，模型完全看不到。`)
      }
      lines.push('')
    }
  }

  lines.push(
    '## 验收标准（全部写完后自查）',
    '',
    `- 每份新简介 ≤ ${limit} 字，触发说法都在前 ${limit} 字内。`,
    `- 重跑 \`skill_doctor\`（不带参数）：「共性问题」里 ${truncated.length} 个技能的超长命中数应归零。`,
    '',
  )
  return lines
}
