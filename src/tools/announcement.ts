/**
 * 「目录预算」视图：估算模型第一层渐进披露注入的技能清单有多大。
 *
 * 原理：dsh 不会把每个 `SKILL.md` 全文塞进上下文，而是先给一份只含
 * `name` / `description` / `whenToUse` 的精简目录；模型靠它决定要不要用某个
 * 技能，决定之后才去读那个技能的正文。这份目录常驻、每轮对话都在，所以它的
 * 总长度占用的是一份固定的上下文预算。
 *
 * 关键在于它是**总量**而不是单技能上限：每个技能单看都合规（简介 300 字、
 * 名字正确），50 个加起来仍可能把预算吃掉，排在目录后面的整条技能条目可能
 * 被静默丢掉 —— 表现为「文件在、已启用、但模型从来没触发过」。
 * 逐技能规则（包括 SD004 的 500 字截断）发现不了这个问题。
 *
 * 设计边界（很重要）：
 * - **只给实测数字，不判定是否超限。** 8000 这个参考值来自社区插件
 *   `dsh-skill-hub` 的注释（称取自 Codex 对初始技能清单的硬上限），我没有
 *   查到 dsh 官方资料确认它是同一阈值，也没有在真实会话里复现「尾部条目
 *   被截断」的行为。硬写一个 `overBudget: true` 会把未核实的经验值包装成
 *   结论，所以这里明确标注「未在 dsh 校准」。
 * - **不产生 Finding。** 病历（baseline）只按 `finding.rule` 计数；多一条
 *   告警会让老病历被误判成「新冒出来一个」。本模块和 provenance 一样，
 *   只派生展示数据，findings 集合保持零变化。
 * - **不改 `ok` / errors**，因此不影响 CLI 退出码与 `--warn-as-error`。
 * - **数据完全从 `result.results` 派生**，调用方不需要传参，也不需要多一次
 *   registry 往返。这与 provenance 不同（后者需要 winners 这种外部裁决信息）。
 */
import type { AnnouncementBudget, SkillInput } from '../types.js'

/**
 * 对照用的参考预算（字符）。
 *
 * 来源：`dsh-skill-hub` 的 `src/protocol/catalog.ts` 注释，称这是 Codex
 * 在上下文窗口未知时对初始技能清单的硬上限。这是社区自述，不是 dsh 的
 * 已知阈值；命名用 `REFERENCE_` 而不是 `MAX_`，就是为了不让调用方误读。
 */
export const REFERENCE_CHAR_BUDGET = 8000

/**
 * 粗估 token 用的换算：按 3 字符 ≈ 1 token。
 * 中英文差异很大，这个数字只用来表达量级，不要拿它做容量规划。
 */
const CHARS_PER_TOKEN = 3

/**
 * 从一批技能算出第一层目录的字符成本。
 *
 * 只统计 `modelInvocable === true` 的技能：只能手动 `/名字` 调用的技能
 * 不参与模型自动选择，也就不占这份目录。字段取值全部来自 `SkillInput`，
 * 远端技能没有 `whenToUse` 时按 0 计。
 */
export function buildAnnouncement(skills: readonly SkillInput[]): AnnouncementBudget {
  let count = 0
  let chars = 0
  for (const skill of skills) {
    if (!skill.invocation.modelInvocable) continue
    count += 1
    chars += skill.name.length + skill.description.length + (skill.whenToUse?.length ?? 0)
  }
  return {
    skills: count,
    chars,
    approxTokens: Math.ceil(chars / CHARS_PER_TOKEN),
    referenceBudget: REFERENCE_CHAR_BUDGET,
  }
}

/**
 * 是否值得在「给人看」的报告里显示这一行。
 *
 * 条件渲染是刻意的：只有几个技能时，这一行只是重复统计行，还会挤掉纯文本
 * 报告的首屏，也会让已经发布出去的「示例输出」配图作废。0.14.0 第二组件
 * 把约 50 个外部技能挂进目录后，这个数字才真正有预警价值。
 * 阈值取「技能数 ≥ 10」或「字符数达到参考值一半」，是展示策略而非规则判定。
 *
 * JSON 输出不受此限制：机器读它，多一个字段不会干扰任何人。
 */
export function shouldShowAnnouncement(view: AnnouncementBudget): boolean {
  return view.skills >= 10 || view.chars >= view.referenceBudget / 2
}

/** 纯文本摘要用的一行；斜杠命令输出是文本节点，不能渲染表格或 Markdown。 */
export function announcementPlainLine(view: AnnouncementBudget): string {
  return `目录预算：${view.skills} 个技能 · ${view.chars} 字符 · 约 ${view.approxTokens} token`
    + `（参考值 ${view.referenceBudget}，未在 dsh 校准）`
}

/** 完整 Markdown 报告用的小节。 */
export function announcementMarkdownLines(view: AnnouncementBudget): string[] {
  return [
    '## 目录预算',
    '',
    `第一层渐进披露注入的技能清单：${view.skills} 个技能，`
      + `name + description + whenToUse 共 ${view.chars} 字符，约 ${view.approxTokens} token。`,
    '',
    `> 参考值 ${view.referenceBudget} 字符来自社区插件（称取自 Codex 初始技能清单上限），`
      + '**未在 dsh 上校准**，也不确认 dsh 是否按目录顺序截断尾部条目。'
      + '这里只给实测数字，不判定是否超限。',
    '',
  ]
}

/** JSON 输出用的形状；`referenceCalibrated: false` 是给机器侧的诚实标注。 */
export function announcementJson(view: AnnouncementBudget): Record<string, unknown> {
  return {
    skills: view.skills,
    chars: view.chars,
    approxTokens: view.approxTokens,
    referenceBudget: view.referenceBudget,
    referenceCalibrated: false,
  }
}
