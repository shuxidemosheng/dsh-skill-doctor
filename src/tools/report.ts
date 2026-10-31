/**
 * 工具输出渲染。
 *
 * 有两种风格：
 * - `plain`（默认）：给人看的报告。第一屏只讲“能不能用、模型看到什么、要不要改”，
 *   规则 ID、provider、model-invocable 这些技术字段统一放到文末“技术细节（可跳过）”。
 * - `technical`：给 CI / 逐条规则排查用的紧凑报告，规则 ID 直接写在每条前面。
 *
 * JSON 输出始终是技术形态（`renderLintJson`），机器读它，不做人话改写。
 */
import { dirname } from 'node:path'
import type { BaselineDiff, RuleDelta } from '../baseline.js'
import { clusterFindings, clusterHint, type RuleCluster } from '../clusters.js'
import { RULES } from '../scanner/rules.js'
import type { Finding, ScanResult, Severity, SkillLintResult } from '../types.js'
import { calibrationNote, calibrationWarning, type DshVersionInfo } from '../version-check.js'
import { prescribeKind, prescriptionOf, prescriptionLine } from './prescriptions.js'

const SEVERITY_LABEL: Record<Severity, string> = { error: 'ERROR', warn: 'WARN', info: 'INFO' }

/** 每条 finding 前面的小标记：让读者一眼分辨“必须修 / 该看看 / 只是提示”。 */
const SEVERITY_MARK: Record<Severity, string> = { error: '⛔', warn: '⚠️', info: '💡' }

/** Markdown 报告选项。 */
export interface ReportOptions {
  /** 模型目录的 description 上限；默认 500。 */
  readonly maxDescriptionLength?: number
  /** 报告风格；默认 `plain`（给人看），`technical` 给 CI 用。 */
  readonly style?: 'plain' | 'technical'
  /** dsh 版本对照；没传就不显示校准信息（CLI 之外调用方可能拿不到）。 */
  readonly dshVersion?: DshVersionInfo
  /** 复诊对比结果；传了才渲染「复诊对比」章节。 */
  readonly baselineDiff?: BaselineDiff
  /** 病历的展示标签（文件名 + 存档日期）；和 baselineDiff 一起传。 */
  readonly baselineLabel?: string
  /** 配置了病历但读不到时的提示路径；放技术细节里，不打断正文。 */
  readonly baselineMissing?: string
}

function limitOf(options: ReportOptions): number {
  return options.maxDescriptionLength ?? 500
}

function findingLine(finding: Finding, detailed: boolean): string[] {
  const location = finding.line === undefined ? '' : ` (line ${finding.line})`
  const lines = [`- **${SEVERITY_LABEL[finding.severity]} ${finding.rule}** ${finding.message}${location}`]
  if (detailed && finding.suggestion !== undefined) lines.push(`  - ${finding.suggestion}`)
  return lines
}

/** 描述被截断时的影响评估。 */
interface TruncationInfo {
  readonly level: 'none' | 'low' | 'high'
  readonly cutLength: number
  readonly newTriggers: readonly string[]
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(value => value.length > 0))]
}

function shortTrigger(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/**
 * 触发说法的短标签。
 *
 * 抽取出来的是整句（"Use when ..." / "Trigger on ..."），直接展示会很啰嗦，
 * 这里去掉开头的引导词、截到第一个逗号或句号，只留用户真正会说的那半句。
 */
function triggerLabel(trigger: string, max = 40): string {
  const stripped = trigger
    .replace(/^(?:use when|use for|use this skill|triggers?(?:\s+on)?|when the user|used?\s+for|用于|当用户|适用于|适用|触发)\s*[:：]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  const head = stripped.split(/[,;，；。、]/)[0] ?? stripped
  return shortTrigger(head.length >= 2 ? head : stripped, max)
}

/** 把多行文本压成一行，便于放在引用块里显示。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 简介预览：太长就截断，避免第一屏被一大段文字淹掉。 */
function preview(text: string, max = 300): string {
  const flat = oneLine(text)
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * 截断位置的预览。
 *
 * 直接 slice(limit) 常常从半个单词开始（例如 "e text-to-reference"），
 * 这里把落点推到下一个空白，读起来才像正常文字。
 */
function cutPreview(description: string, limit: number, max = 220): string {
  const cut = description.slice(limit)
  const firstSpace = cut.search(/\s/)
  const boundary = description.slice(limit - 1, limit + 1)
  const startsMidWord = firstSpace > 0 && firstSpace <= 24 && /^[A-Za-z0-9]{2}$/.test(boundary)
  return preview(startsMidWord ? cut.slice(firstSpace + 1) : cut, max)
}

/** 从一段描述里提取“触发词/触发句”：引号短语 + Use when/用于 等标记句。 */
function extractTriggers(text: string): string[] {
  const quoted = [...text.matchAll(/["“「']([^"”」']{2,60})["”」']/g)]
    .map(match => match[1] ?? '')
  const markers: string[] = []
  for (const match of text.matchAll(/(?:use when|use for|use this skill|trigger|when the user|用于|当用户|适用|触发)[^.\n]{0,180}/gi)) {
    const index = match.index ?? 0
    const before = text.slice(Math.max(0, index - 24), index)
    // "Do not use for ..." / "不要用于 ..." 是排除条件，不是触发词。
    if (/(?:do\s+not|don't|doesn't|not|不要|不适用|不用于)\s*$/i.test(before)) continue
    markers.push(match[0])
  }
  return unique([...quoted, ...markers]).slice(0, 8)
}

function analyzeTruncation(description: string, limit: number): TruncationInfo {
  if (description.length <= limit) return { level: 'none', cutLength: 0, newTriggers: [] }
  const visible = description.slice(0, limit)
  const cut = description.slice(limit)
  const visibleTriggers = extractTriggers(visible)
  const cutTriggers = extractTriggers(cut)
  const newTriggers = cutTriggers.filter(trigger =>
    !visibleTriggers.some(existing => existing.includes(trigger) || trigger.includes(existing)))
  return {
    level: newTriggers.length > 0 ? 'high' : 'low',
    cutLength: cut.length,
    newTriggers: newTriggers.slice(0, 6),
  }
}

/**
 * 把英文/技术型的 finding 原文翻成人话。
 *
 * 只有 SD001 需要翻译：它的 message 直接来自 YAML 解析器（英文）。
 * 其余规则在 check 里已经写成中文人话，直接用。
 */
function plainMessage(finding: Finding): string {
  if (finding.rule !== 'SD001') return finding.message
  const message = finding.message
  if (/must be ---|missing frontmatter/i.test(message)) {
    return '文件第一行不是 ---，dsh 找不到“文件头”从哪里开始。'
  }
  if (/unterminated/i.test(message)) {
    return '文件头只有开头没有结尾，缺少一条单独的 --- 收尾。'
  }
  if (/invalid YAML/i.test(message)) {
    return '文件头里的写法不合法，解析不出“键: 值”。'
  }
  if (/mapping/i.test(message)) {
    return '文件头里应该是一组“键: 值”，现在不是这种形式。'
  }
  return '文件头读不出来。'
}

/** 技能文件所在目录；dsh 自带的虚拟技能没有本地文件，返回 undefined。 */
function skillDir(skill: { readonly path?: string }): string | undefined {
  return skill.path === undefined ? undefined : dirname(skill.path)
}

/** 第一屏的 finding 写法：小标题 + 现在什么情况 + 处方（能不能一键解决）。 */
function plainFindingLines(finding: Finding, bullet: string, directory?: string): string[] {
  const meta = RULES[finding.rule]
  const where = finding.line === undefined ? '' : `（第 ${finding.line} 行）`
  return [
    `${bullet} ${SEVERITY_MARK[finding.severity]} **${meta.plainTitle}**${where}`,
    `   现在：${plainMessage(finding)}`,
    `   处方：${prescriptionLine(finding.rule, finding.suggestion, directory)}`,
  ]
}

/**
 * 报告摘要表。
 *
 * 用户真正要的是“像一份报告”，而不是一段散文：先给一张能一眼扫完的表，
 * 再展开细节。表在聊天里渲染成表格，在纯文本环境里也仍然对齐可读。
 */
function summaryTable(result: SkillLintResult, truncation: TruncationInfo, limit: number): string[] {
  const description = result.skill.description
  const impact = truncation.level === 'high'
    ? `大（${truncation.newTriggers.length} 个触发说法看不到）`
    : truncation.level === 'low' ? '不大（被切掉的多是细节）' : '无'
  const action = result.errors > 0
    ? '先修上面的错误，否则技能可能加载不了'
    : truncation.level === 'high'
      ? `把触发词移到简介前 ${limit} 字以内`
      : truncation.level === 'low' ? '可以不动，想更稳就压短简介' : '不用改'
  return [
    '| 项目 | 情况 |',
    '|---|---|',
    `| 技能 | \`${result.skill.name}\` |`,
    `| 简介 | ${description.length} 字，模型可见前 ${Math.min(description.length, limit)} 字 |`,
    `| 截断影响 | ${impact} |`,
    `| 建议动作 | ${action} |`,
    '',
  ]
}

/** 单技能结论：一句话回答“能不能用、模型看不看得见”。 */
function verdictOf(result: SkillLintResult, truncation: TruncationInfo, limit: number): string {
  if (result.errors > 0) return '有错误，这个技能很可能根本用不了。'
  if (!result.skill.invocation.modelInvocable) {
    return '模型不会自己用它——这个技能被设成了“只允许手动调用”。'
  }
  if (truncation.level === 'high') {
    return `能用，但模型只能看到简介的前 ${limit} 字；被切掉的正好是你平时叫它用的那些说法。`
  }
  if (truncation.level === 'low') return `能用，但简介太长，模型只能看到前 ${limit} 字。`
  if (result.warnings > 0) return '大概率能用，但有几处小问题值得改一下。'
  return '没问题：模型能看到它，也能正常使用。'
}

/** 规则摘要：同一规则命中多次时只报一次，避免技术附录里重复。 */
function ruleSummary(findings: readonly Finding[]): string {
  const seen = new Map<string, Severity>()
  for (const finding of findings) {
    if (!seen.has(finding.rule)) seen.set(finding.rule, finding.severity)
  }
  return [...seen].map(([rule, severity]) => `${rule}（${severity}）`).join('、')
}

/** 单技能的“技术细节”附录：字段名带英文，方便对照文档和原始文件。 */
function technicalFooter(result: SkillLintResult, limit: number, dsh?: DshVersionInfo, baselineMissing?: string): string[] {
  const description = result.skill.description
  const lines = [
    '---',
    '',
    '## 技术细节（可跳过）',
    '',
    `- 来源：${result.skill.provider === 'filesystem' ? '本地文件' : `${result.skill.provider} 插件`}`
      + `（provider: ${result.skill.provider}`
      + (result.skill.source === result.skill.provider ? '）' : ` / source: ${result.skill.source}）`),
    `- 位置：${result.skill.path ?? '（虚拟技能，没有本地文件）'}`,
    `- 模型能不能自动用（model-invocable）：${result.skill.invocation.modelInvocable ? '能' : '不能'}`,
    `- 能不能用 \`/${result.skill.name}\` 手动调用（user-invocable）：${result.skill.invocation.userInvocable ? '能' : '不能'}`,
    `- 简介长度（description）：${description.length} 字 / 上限 ${limit}`,
  ]
  // 这把尺子是按哪个 dsh 版本校准的；版本漂了，“超长”就未必还是问题。
  const note = calibrationNote(dsh)
  if (note !== undefined) lines.push(`- ${note}`)
  if (baselineMissing !== undefined) {
    lines.push(`- 复诊：病历 \`${baselineMissing}\` 读不到（不存在或格式不对），跳过对比`)
  }
  if (result.findings.length > 0) {
    lines.push(`- 命中规则：${ruleSummary(result.findings)}`)
  } else {
    lines.push('- 命中规则：无')
  }
  return lines
}

/**
 * 单技能报告：先给结论，再给“模型实际看到什么”，最后才给规则细节。
 */
export function renderDoctorMarkdown(result: SkillLintResult, options: ReportOptions = {}): string {
  const limit = limitOf(options)
  const description = result.skill.description
  const truncation = analyzeTruncation(description, limit)
  const cut = description.length > limit ? description.slice(limit) : ''
  const lines: string[] = [
    `# 技能体检：\`${result.skill.name}\``,
    '',
    `**结论：${verdictOf(result, truncation, limit)}**`,
    '',
    ...summaryTable(result, truncation, limit),
    '## 模型看到的信息',
    '',
  ]

  if (description.length === 0) {
    lines.push('- 简介：**空的**。模型完全不知道这个技能是干什么的，也就不会用它。')
  } else {
    // 引用块放在顶层，不要嵌在列表项里。
    // “列表项 + 缩进引用块 + 缩进续行”这套写法在不同 Markdown 渲染器里表现不一，
    // 有的会把引用块挤出列表、把下一行拆成单独段落，读起来像断掉了。
    // 这里给的是**模型实际读到的完整原文**（截到上限为止），不是二次摘要：
    // 用户要判断的是“我的触发词在不在里面”，摘要会让这个判断失去依据。
    lines.push(
      '**简介**（模型靠它决定“要不要用这个技能”）：',
      '',
      `> ${oneLine(description.slice(0, limit)) || '（只有空白字符）'}`,
      '',
    )
    if (description.length > limit) {
      lines.push(`共 ${description.length} 字；模型只能看到前 ${limit} 字，剩下 ${description.length - limit} 字它看不到。`, '')
    } else {
      lines.push(`共 ${description.length} 字，没有超过 ${limit} 字上限，模型能完整看到。`, '')
    }
  }
  lines.push(
    `- 模型能自己想到用它：${result.skill.invocation.modelInvocable ? '能' : '**不能**（被设成只允许手动调用）'}`,
    `- 你能用 \`/${result.skill.name}\` 手动调用：${result.skill.invocation.userInvocable ? '能' : '不能'}`,
    `- 正文：${result.skill.content.length} 字（模型决定用它之后会读全文）`,
  )
  if (isBundled(result.skill)) {
    lines.push('- 来源：dsh 自带的虚拟技能，没有本地文件，不在你的技能目录里。')
  }
  lines.push('')

  if (cut.length > 0) {
    lines.push(
      '## 被切掉的部分（模型看不到）',
      '',
      `> ${cutPreview(description, limit)}`,
      '',
    )
    if (truncation.level === 'high') {
      lines.push(
        '里面有几处“什么时候该用它”的说法，模型完全收不到：',
        '',
        ...truncation.newTriggers.map(item => `- “${triggerLabel(item, 80)}”`),
        '',
        '**影响：大。** 你平时大概就是这么说的话；模型看不到这些词，就不会主动用这个技能。',
        '',
        '### 怎么改',
        '',
        `把这些说法提到简介开头（前 ${limit} 字以内）。例如在开头加一句：`,
        '',
        `> 当用户说「${truncation.newTriggers.slice(0, 3).map(item => triggerLabel(item, 20)).join('」「')}」时使用本技能。`,
        '',
        '改完再跑一次 `skill_doctor`：这里变成“影响不大”，就说明模型能看到了。',
        '',
      )
    } else {
      lines.push(
        '**影响：不大。** 被切掉的部分里没有发现新的“什么时候该用它”的说法，',
        `前 ${limit} 字已经够模型判断；想更稳可以再压短一点。`,
        '',
      )
    }
  }

  // 简介截断已经在上面单独讲过，这里不再重复同一条 SD004。
  const remaining = cut.length > 0
    ? result.findings.filter(finding => finding.rule !== 'SD004')
    : result.findings

  lines.push('## 需要处理的问题', '')
  if (remaining.length === 0) {
    if (cut.length === 0) {
      lines.push('没有。结构、简介长度、正文体积、引用文件都没发现问题。')
    } else if (truncation.level === 'high') {
      lines.push('没有别的问题。按上面的方法把触发词提到开头就行。')
    } else {
      lines.push('没有别的问题。简介虽然被截断，但影响不大，可以不动。')
    }
  } else {
    lines.push('按严重程度排序；带 ⛔ 的最要紧。', '')
    remaining.forEach((finding, index) => {
      lines.push(...plainFindingLines(finding, `${index + 1}.`, skillDir(result.skill)), '')
    })
  }

  while (lines.at(-1) === '') lines.pop()
  lines.push('', ...technicalFooter(result, limit, options.dshVersion, options.baselineMissing))
  return lines.join('\n')
}

/**
 * 是否是 dsh 自带的虚拟技能。
 *
 * 这类技能没有本地文件（path 为空），provider 来自宿主 bundle，
 * 用户既找不到也改不了；把它和用户自己的技能混在一起统计会让人困惑。
 */
function isBundled(skill: { readonly path?: string }): boolean {
  return skill.path === undefined
}

/** 名字后面的来源标注；只有 dsh 自带的技能才加。 */
function sourceTag(skill: { readonly path?: string }): string {
  return isBundled(skill) ? '（dsh 自带）' : ''
}

/** 多技能报告里，单个技能的一句话概括。 */
function compactSkillLine(result: SkillLintResult, limit: number): string {
  const problems = result.findings
    .filter(finding => finding.rule !== 'SD004')
    .map(finding => RULES[finding.rule].plainTitle)
  const description = result.skill.description
  const cut = description.length > limit ? `，只能显示前 ${limit} 字` : ''
  const suffix = problems.length === 0 ? '' : `；另有：${unique(problems).join('、')}`
  return `- \`${result.skill.name}\`：简介 ${description.length} 字${cut}${suffix}`
}

/** 多技能报告（技术风格）：逐条规则、规则 ID 前置，供 CI 与规则排查使用。 */
function renderTechnicalMarkdown(result: ScanResult, limit: number, options: ReportOptions): string {
  const blocking = result.results.filter(item => item.errors > 0)
  const truncated = result.results.filter(item =>
    item.errors === 0 && item.findings.some(finding => finding.rule === 'SD004'))
  const other = result.results.filter(item =>
    item.errors === 0
    && !truncated.includes(item)
    && item.warnings > 0)
  const ok = result.results.filter(item => item.findings.length === 0)

  const lines: string[] = [
    '# Skill Doctor',
    '',
    `检查了 ${result.results.length} 个技能：`
      + `**${blocking.length} 需要修复** / **${truncated.length} 描述会被截断** / `
      + `**${other.length} 其他提示** / **${ok.length} 正常**。`,
    '',
  ]

  const note = calibrationNote(options.dshVersion)
  if (note !== undefined) lines.push(`> ${note}`, '')

  if (result.results.length === 0) {
    lines.push('没有找到技能。确认 cwd、`extraRoots` 或技能根目录。')
    return lines.join('\n')
  }

  if (blocking.length > 0) {
    lines.push('## 需要修复', '')
    for (const item of blocking) {
      lines.push(`### \`${item.skill.name}\` — ${item.skill.provider} — ${item.skill.path ?? '(virtual)'}`, '')
      for (const finding of item.findings) lines.push(...findingLine(finding, true))
      lines.push('')
    }
  }

  if (truncated.length > 0) {
    lines.push(`## 描述会被截断（模型只看前 ${limit} 字符）`, '')
    const sorted = [...truncated].sort((a, b) => b.skill.description.length - a.skill.description.length)
    const high = sorted.filter(item => analyzeTruncation(item.skill.description, limit).level === 'high')
    const low = sorted.filter(item => analyzeTruncation(item.skill.description, limit).level === 'low')

    if (high.length > 0) {
      lines.push(`**影响高（${high.length}）— 被截断部分含新的触发短语**`, '')
      for (const item of high) {
        const total = item.skill.description.length
        lines.push(`- \`${item.skill.name}\` — ${total} 字符，被截断 ${total - limit}`)
      }
      lines.push('')
    }

    if (low.length > 0) {
      lines.push(`**影响低（${low.length}）— 被截断部分未发现新的触发短语**`, '')
      for (const item of low) {
        const total = item.skill.description.length
        lines.push(`- \`${item.skill.name}\` — ${total} 字符，被截断 ${total - limit}`)
      }
      lines.push('')
    }
  }

  if (other.length > 0) {
    lines.push('## 其他提示', '')
    for (const item of other) {
      lines.push(`### \`${item.skill.name}\` — ${item.skill.provider} — ${item.skill.path ?? '(virtual)'}`)
      for (const finding of item.findings) lines.push(...findingLine(finding, false))
      lines.push('')
    }
  }

  if (ok.length > 0) {
    lines.push('## 正常', '')
    lines.push(ok.map(item => `\`${item.skill.name}\``).join(', '))
  }

  return lines.join('\n').trimEnd()
}

/**
 * 一组共性问题的建议动作。
 *
 * 只有 SD004 有明确的量化动作（压到前 N 字）；其余规则给的是流程性建议，
 * 因为不同技能的具体修法不一样，不该由报告替用户编一句。
 */
function clusterAction(cluster: RuleCluster, limit: number): string {
  // 能自动修的（BOM / CRLF）不该让人逐个点开：一条命令扫一遍就完了。
  if (prescribeKind(cluster.rule) === 'autofix') {
    return `这类能自动修：在技能目录的上一层跑 \`dsh-skill-lint . --fix --only ${cluster.rule} --apply\`，`
      + `一次改完 ${cluster.count} 个（会先备份成 .bak，复验失败会自动回滚）。`
  }
  if (cluster.rule === 'SD004') {
    return cluster.commonPrefix === undefined
      ? `把简介压到前 ${limit} 字以内，${cluster.count} 个技能得逐个改。`
      : `把 \`${cluster.commonPrefix}-\` 这套模板里的简介改短（前 ${limit} 字说完“什么时候用”），改一次顶 ${cluster.count} 次。`
  }
  return cluster.commonPrefix === undefined
    ? `${cluster.count} 个技能各自看一遍；改完重跑体检，确认这个数字下降。`
    : `先改 \`${cluster.commonPrefix}-\` 这套模板或生成脚本，再重跑体检确认数量下降；落下的再单独补。`
}

/**
 * 共性问题章节。
 *
 * 29 个技能里 13 个都“简介超长”，逐条列就是 13 行噪音，而真实根因常常只有一个：
 * 它们出自同一套模板。这里按规则把命中聚成组，并给出“是否同源”的推测。
 * 注意措辞是“大概率/多半”——共同前缀只能说明命名相似，不能证明同一模板。
 */
function clusterSection(clusters: readonly RuleCluster[], limit: number): string[] {
  if (clusters.length === 0) return []
  const lines: string[] = [
    `## 共性问题（${clusters.length} 组，先改这里最划算）`,
    '',
    '同一条规则命中很多技能，通常只有一个根因。按根因看，比按技能逐个看省事：',
    '',
  ]
  for (const cluster of clusters) {
    const percent = Math.round(cluster.share * 100)
    lines.push(`- **${cluster.plainTitle}**（${cluster.rule}）—— ${cluster.count} 个技能，占 ${percent}%`)
    lines.push(`  - 命中：${cluster.skills.map(name => `\`${name}\``).join('、')}`)
    lines.push(`  - 根因推测：${clusterHint(cluster)}`)
    lines.push(`  - 怎么改：${clusterAction(cluster, limit)}`)
  }
  lines.push('')
  return lines
}

/**
 * 复诊对比章节。
 *
 * 医生看复诊单看的是差值：哪些好了、哪些没动、哪些新冒出来。
 * 按规则聚合（与聚类同一哲学），只有"变差"才点名具体技能——那是要立刻看的新问题。
 */
function followUpSection(diff: BaselineDiff, label: string): string[] {
  const lines: string[] = ['## 复诊对比', '', `对照上次的病历 ${label}，按规则看差值：`, '']
  if (diff.metaWarning !== undefined) lines.push(`> ⚠️ ${diff.metaWarning}`, '')

  const delta = (item: RuleDelta): string => `${item.plainTitle} ${item.before} → ${item.after}`
  if (diff.improved.length > 0) {
    lines.push(`- ✅ 好转：${diff.improved.map(delta).join('；')}`)
  }
  if (diff.unchanged.length > 0) {
    lines.push(`- 😐 还没动：${diff.unchanged.map(delta).join('；')}`)
  }
  if (diff.regressed.length > 0) {
    const parts = diff.regressed.map(item => {
      const names = diff.regressedSkills[item.rule]
      const who = names === undefined || names.length === 0 ? '' : `（${names.map(name => `\`${name}\``).join('、')}）`
      return `${delta(item)}${who}`
    })
    lines.push(`- ⚠️ 变差：${parts.join('；')}`)
  }
  if (diff.newSkills.length > 0) {
    lines.push(`- 🆕 这次新扫到：${diff.newSkills.map(name => `\`${name}\``).join('、')}`)
  }
  if (diff.goneSkills.length > 0) {
    lines.push(`- 🗑 上次有、这次不在：${diff.goneSkills.map(name => `\`${name}\``).join('、')}（改名或删了？）`)
  }

  const nothingChanged = diff.improved.length === 0 && diff.regressed.length === 0
    && diff.newSkills.length === 0 && diff.goneSkills.length === 0
  if (diff.totalBefore === 0 && diff.totalAfter === 0) {
    lines.push('', '上次和这次都是 0 处问题，保持健康。')
  } else if (nothingChanged && diff.totalAfter === diff.totalBefore) {
    lines.push('', `和上次完全一样：${diff.totalAfter} 处问题，一条没变。`)
  } else {
    const errorPart = diff.errorsBefore !== diff.errorsAfter
      ? `；错误 ${diff.errorsBefore} → ${diff.errorsAfter}`
      : ''
    lines.push('', `整体：问题总数 ${diff.totalBefore} → ${diff.totalAfter}${errorPart}。`)
  }
  lines.push('')
  return lines
}

/**
 * 多技能报告（通俗风格）。
 *
 * 30 个技能不能变成 30 段规则文本，所以这里只做三件事：
 * 1. 用一句话说明整体的“健康分布”；
 * 2. 只展开真正需要动手的技能，每条都带“现在/怎么改”；
 * 3. 其余技能压成一行，规则 ID 统一放文末。
 */
function renderPlainMarkdown(result: ScanResult, limit: number, options: ReportOptions): string {
  const total = result.results.length
  if (total === 0) {
    return [
      '# Skill Doctor：技能体检报告',
      '',
      '没有找到技能。确认一下工作目录，或者把技能目录加到 `extraRoots`。',
    ].join('\n')
  }

  const blocking = result.results.filter(item => item.errors > 0)
  const truncated = result.results.filter(item =>
    item.errors === 0 && item.findings.some(finding => finding.rule === 'SD004'))
  const sortedTruncated = [...truncated].sort((a, b) => b.skill.description.length - a.skill.description.length)
  const high = sortedTruncated.filter(item => analyzeTruncation(item.skill.description, limit).level === 'high')
  const low = sortedTruncated.filter(item => analyzeTruncation(item.skill.description, limit).level === 'low')
  // 用 findings.length 而不是 warnings > 0：否则 info 级（BOM、CRLF、名字过长）
  // 会掉进裂缝——既不在任何分组里，也不在“没问题”里，正文完全看不到。
  const other = result.results.filter(item =>
    item.errors === 0 && !truncated.includes(item) && item.findings.length > 0)
  const ok = result.results.filter(item => item.findings.length === 0)
  const bundled = result.results.filter(item => isBundled(item.skill)).length

  const lines: string[] = [
    '# Skill Doctor：技能体检报告',
    '',
  ]
  // 版本漂移提示放最上面：它会影响下面每一条“超长”判断的可信度。
  const warning = calibrationWarning(options.dshVersion)
  if (warning !== undefined) lines.push(`> ⚠️ ${warning}`, '')
  lines.push(
    `一共检查了 ${total} 个技能`
      + (bundled > 0
        ? `（其中 ${bundled} 个是 dsh 自带的虚拟技能，不在你的技能目录里，改不了也不用管）：`
        : '：'),
    '',
    `- ⛔ 用不了（有错误）：${blocking.length}`,
    `- ⚠️ 模型看不到部分“触发说法”（简介被截断、影响大）：${high.length}`,
    `- 💡 简介被截断，但影响不大：${low.length}`,
    `- 💡 其他小问题：${other.length}`,
    `- ✅ 没问题：${ok.length}`,
    '',
  )

  // 复诊对比紧跟体检分布：刚修完的人第一眼想看的是“好了多少”。
  if (options.baselineDiff !== undefined && options.baselineLabel !== undefined) {
    lines.push(...followUpSection(options.baselineDiff, options.baselineLabel))
  }

  // 共性问题放在逐个展开之前：先让人知道“13 个超长其实是一个模板问题”，
  // 再看下面的细节，才知道该改模板还是改单个文件。
  lines.push(...clusterSection(clusterFindings(result.results), limit))

  if (blocking.length > 0) {
    lines.push('## 先修这些：有错误，可能根本用不了', '')
    for (const item of blocking) {
      lines.push(`### \`${item.skill.name}\``, '')
      item.findings.forEach((finding, index) => {
        lines.push(...plainFindingLines(finding, `${index + 1}.`, skillDir(item.skill)))
      })
      lines.push('')
    }
  }

  if (high.length > 0) {
    lines.push(
      `## 模型看不到你说的触发说法（${high.length} 个，最该先看）`,
      '',
    )
    for (const item of high) {
      const info = analyzeTruncation(item.skill.description, limit)
      const triggers = info.newTriggers.slice(0, 3).map(trigger => `“${triggerLabel(trigger)}”`)
      lines.push(
        `- \`${item.skill.name}\`：简介 ${item.skill.description.length} 字，`
        + `模型只看到前 ${limit} 字；被切掉的说法有 ${triggers.join('、') || '（未能自动识别，建议手动读一遍被切掉的部分）'}`,
      )
    }
    lines.push(
      '',
      '怎么改：把这些说法挪到简介开头。检验方法很简单——只读前 ' + limit + ' 字，',
      '看能不能看出“什么时候该用这个技能”。改完用 `skill_doctor name=<名字>` 复查。',
      '',
    )
  }

  if (low.length > 0) {
    lines.push(`## 简介被截断了，但影响不大（${low.length} 个）`, '')
    lines.push('前 ' + limit + ' 字里已经包含主要触发说法，暂时可以不动。', '')
    for (const item of low) lines.push(compactSkillLine(item, limit))
    lines.push('')
  }

  if (other.length > 0) {
    lines.push(`## 其他小问题（${other.length} 个）`, '')
    for (const item of other) {
      lines.push(`### \`${item.skill.name}\``, '')
      for (const finding of item.findings) lines.push(...plainFindingLines(finding, '-', skillDir(item.skill)))
      lines.push('')
    }
  }

  if (ok.length > 0) {
    lines.push(`## 没问题（${ok.length} 个）`, '')
    lines.push(ok.map(item => `\`${item.skill.name}\`${sourceTag(item.skill)}`).join('、'))
    lines.push('')
  }

  // 只列“有命中”的技能，避免 30 行“无”把附录撑成第二份正文。
  const hit = result.results.filter(item => item.findings.length > 0)
  lines.push('---', '', '## 技术细节（可跳过）', '')
  const note = calibrationNote(options.dshVersion)
  if (note !== undefined) lines.push(`- ${note}`, '')
  if (options.baselineMissing !== undefined) {
    lines.push(`- 复诊：病历 \`${options.baselineMissing}\` 读不到（不存在或格式不对），跳过对比`, '')
  }
  if (hit.length === 0) {
    lines.push('所有技能都没有命中任何规则。')
  } else {
    for (const item of hit) {
      const rules = ruleSummary(item.findings)
      lines.push(`- \`${item.skill.name}\`：${rules}`)
    }
    lines.push('', `其余 ${result.results.length - hit.length} 个技能没有命中任何规则。`)
  }

  return lines.join('\n').trimEnd()
}

/** 多技能报告入口：默认通俗风格，`technical` 时为逐条规则风格。 */
export function renderLintMarkdown(result: ScanResult, options: ReportOptions = {}): string {
  const limit = limitOf(options)
  return options.style === 'technical'
    ? renderTechnicalMarkdown(result, limit, options)
    : renderPlainMarkdown(result, limit, options)
}

/** 扫描结果的稳定 JSON。 */
export function renderLintJson(result: ScanResult, options: ReportOptions = {}): string {
  const limit = limitOf(options)
  return JSON.stringify({
    ok: result.ok,
    summary: {
      skills: result.results.length,
      errors: result.errors,
      warnings: result.warnings,
      infos: result.infos,
    },
    // 机器侧也要拿到聚类：CI 想“这次修了 13 个还是 1 个根因”，只能靠这个字段。
    clusters: clusterFindings(result.results).map(cluster => ({
      rule: cluster.rule,
      plainTitle: cluster.plainTitle,
      count: cluster.count,
      share: Number(cluster.share.toFixed(3)),
      skills: [...cluster.skills],
      commonPrefix: cluster.commonPrefix ?? null,
      hint: clusterHint(cluster),
    })),
    // 复诊对比给 CI 用：回归门禁可以直接读 regressed 数组。
    ...options.baselineDiff === undefined ? {} : {
      comparison: {
        totalBefore: options.baselineDiff.totalBefore,
        totalAfter: options.baselineDiff.totalAfter,
        improved: options.baselineDiff.improved,
        unchanged: options.baselineDiff.unchanged,
        regressed: options.baselineDiff.regressed,
        regressedSkills: options.baselineDiff.regressedSkills,
        newSkills: options.baselineDiff.newSkills,
        goneSkills: options.baselineDiff.goneSkills,
        ...options.baselineDiff.metaWarning === undefined ? {} : { metaWarning: options.baselineDiff.metaWarning },
      },
    },
    ...options.dshVersion === undefined ? {} : { calibration: options.dshVersion },
    results: result.results.map(skill => ({
      name: skill.skill.name,
      provider: skill.skill.provider,
      source: skill.skill.source,
      path: skill.skill.path ?? null,
      ok: skill.ok,
      catalog: {
        descriptionLength: skill.skill.description.length,
        visible: skill.skill.description.slice(0, limit),
        cut: skill.skill.description.length > limit ? skill.skill.description.slice(limit) : null,
        truncation: analyzeTruncation(skill.skill.description, limit),
      },
      findings: skill.findings.map(finding => ({
        rule: finding.rule,
        severity: finding.severity,
        message: finding.message,
        file: finding.file ?? null,
        line: finding.line ?? null,
        suggestion: finding.suggestion ?? null,
        // 处方类别单独给出来，CI 可以据此区分“能自动修”和“必须人工”。
        prescription: prescriptionOf(finding.rule),
      })),
    })),
  }, null, 2)
}

/** explain 的结果形状。 */
export interface ExplainInfo {
  readonly name: string
  readonly found: boolean
  readonly provider?: string
  readonly source?: string
  readonly path?: string
  readonly modelInvocable?: boolean
  readonly userInvocable?: boolean
  readonly descriptionLength?: number
  readonly descriptionPreview?: string
  readonly whenToUse?: string
  readonly bodyChars?: number
  readonly bodyTokens?: number
  readonly loaded?: boolean
  readonly resourceBaseKind?: string
  readonly metadataKeys?: readonly string[]
  readonly notes: readonly string[]
  readonly sameNameCandidates?: readonly string[]
}

/** explain 的 Markdown 输出：人话在前，技术字段放括号里以便对照。 */
export function renderExplainMarkdown(info: ExplainInfo): string {
  if (!info.found) {
    const lines = [`# \`${info.name}\` — 未找到`, '', '当前视图里没有这个技能。']
    if (info.sameNameCandidates !== undefined && info.sameNameCandidates.length > 0) {
      lines.push('', '同名候选：', ...info.sameNameCandidates.map(path => `- ${path}`))
    }
    lines.push('', ...info.notes.map(note => `- ${note}`))
    return lines.join('\n')
  }

  const lines: string[] = [
    `# \`${info.name}\``,
    '',
    `- 来源：${info.provider === 'filesystem' ? '本地文件' : info.provider ?? '?'}`
      + `（provider: ${info.provider ?? '?'} / source: ${info.source ?? '?'}）`,
    `- 位置：${info.path ?? '（虚拟技能，没有本地文件）'}`,
    `- 模型能自己想到用它（model-invocable）：${info.modelInvocable === true ? '能 yes' : '不能 no'}`,
    `- 你能用 /名字 手动调用（user-invocable）：${info.userInvocable === true ? '能 yes' : '不能 no'}`,
    `- 简介长度（description）：${info.descriptionLength ?? 0} 字`,
    `- 正文：${info.bodyChars ?? 0} 字 / 约 ${info.bodyTokens ?? 0} tokens`,
    `- 真的能加载（ctx.skills.get）：${info.loaded === true ? '能 yes' : '不能 no'}`,
  ]
  if (info.descriptionPreview !== undefined && info.descriptionPreview.length > 0) {
    lines.push(`- 简介开头（description preview）：${info.descriptionPreview}`)
  }
  if (info.whenToUse !== undefined) lines.push(`- 适用场景（whenToUse）：${info.whenToUse}`)
  if (info.resourceBaseKind !== undefined) lines.push(`- 资源基址类型（resourceBase）：${info.resourceBaseKind}`)
  if (info.metadataKeys !== undefined && info.metadataKeys.length > 0) {
    lines.push(`- 文件头里的其他字段：${info.metadataKeys.join(', ')}`)
  }
  if (info.notes.length > 0) {
    lines.push('', '## 可能没生效的原因', '', ...info.notes.map(note => `- ${note}`))
  }
  if (info.sameNameCandidates !== undefined && info.sameNameCandidates.length > 0) {
    lines.push('', '## 同名候选（只扫了配置的根目录，最终以 registry 为准）', '',
      ...info.sameNameCandidates.map(path => `- ${path}`))
  }
  return lines.join('\n')
}

/** explain 的 JSON 输出。 */
export function renderExplainJson(info: ExplainInfo): string {
  return JSON.stringify(info, null, 2)
}
