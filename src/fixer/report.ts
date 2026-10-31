/** 修复报告的渲染：试运行与已应用两种形态。 */
import { sep } from 'node:path'
import type { FixOutcome } from './apply.js'
import type { FixPlan } from './plan.js'

/** 报告里“修不了但确实命中”的规则汇总。 */
export interface UnfixableHit {
  readonly rule: string
  readonly plainTitle: string
  readonly count: number
}

export interface FixReportInput {
  readonly plan: FixPlan
  /** undefined = 试运行，没有落盘。 */
  readonly outcomes?: readonly FixOutcome[]
  /** 本次命中但不在可修范围内的规则。 */
  readonly unfixable: readonly UnfixableHit[]
}

/** 路径太长会把表格撑坏，能相对当前目录就用相对路径。 */
function shortPath(file: string): string {
  const cwd = process.cwd()
  const prefix = cwd.endsWith(sep) ? cwd : `${cwd}${sep}`
  return file.startsWith(prefix) ? file.slice(prefix.length) : file
}

function skillCell(names: readonly string[]): string {
  // 一般情况下只有一个技能指向这个文件；多于一个时全部列出，避免误导。
  return names.map(name => `\`${name}\``).join('、')
}

/** 一条 outcome 的人话结果。 */
function outcomeCell(outcome: FixOutcome): string {
  if (outcome.status === 'applied') return '已修复'
  if (outcome.status === 'rolled-back') return '**已回滚**（复验不过）'
  return '**失败**'
}

/** 结尾的“为什么会还剩下问题”。 */
function unfixableSection(unfixable: readonly UnfixableHit[]): string[] {
  if (unfixable.length === 0) return []
  return [
    '## 这些没动，因为改法不唯一',
    '',
    ...unfixable.map(item => `- ${item.rule}（${item.count} 处）：${item.plainTitle}`),
    '',
    '需要人判断的几类：简介怎么重写、同名技能留哪一个、可疑指令是不是真有问题。',
    '自动改这些等于替你猜意图，猜错比不修更麻烦。',
  ]
}

/** 保证两段之间恰好一个空行，否则标题会被上一段“粘”住，Markdown 里不渲染成标题。 */
function pushSection(lines: string[], block: readonly string[]): void {
  if (block.length === 0) return
  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('')
  lines.push(...block)
}

/**
 * 渲染修复报告。
 * @param input - 计划、落盘结果（试运行时为 undefined）与不可修规则。
 */
export function renderFixMarkdown(input: FixReportInput): string {
  const { plan, outcomes, unfixable } = input
  const lines: string[] = []
  const dryRun = outcomes === undefined

  if (dryRun) {
    lines.push('# 技能修复（试运行，没有写入任何文件）', '')
    if (plan.targets.length === 0) {
      lines.push('**结论：没有可以自动修的项。**', '')
    } else {
      lines.push(
        `**结论：${plan.targets.length} 个文件可以自动修好；加 \`--apply\` 才会真正写入。**`,
        '',
        '| 文件 | 技能 | 改什么 |',
        '|---|---|---|',
        ...plan.targets.map(target =>
          `| \`${shortPath(target.file)}\` | ${skillCell(target.skillNames)} | ${target.notes.join('；')} |`),
        '',
        '这是试运行：文件一个字节都没动。确认无误后加 `--apply`。',
      )
    }
  } else {
    const applied = outcomes.filter(item => item.status === 'applied').length
    const failed = outcomes.filter(item => item.status !== 'applied').length
    lines.push('# 技能修复（已应用）', '')
    lines.push(
      `**结论：${applied} 个文件修好了`
        + (failed === 0 ? '，没有失败。' : `，${failed} 个失败或已回滚。`)
        + '**',
      '',
    )
    if (outcomes.length > 0) {
      lines.push(
        '| 文件 | 技能 | 改什么 | 结果 | 备份 |',
        '|---|---|---|---|---|',
        ...outcomes.map(outcome =>
          `| \`${shortPath(outcome.target.file)}\` | ${skillCell(outcome.target.skillNames)} `
          + `| ${outcome.target.notes.join('；')} | ${outcomeCell(outcome)} `
          + `| ${outcome.backup === undefined ? '（无）' : `\`${shortPath(outcome.backup)}\``} |`),
        '',
      )
    }
  }

  // 逐条展开异常：失败原因与回滚原因必须写清楚，不然用户只知道“没修成”。
  const problems = (outcomes ?? []).filter(item => item.status !== 'applied')
  if (problems.length > 0) {
    const block = ['## 没修成的，原因在这', '']
    for (const outcome of problems) {
      block.push(`- \`${shortPath(outcome.target.file)}\``)
      if (outcome.error !== undefined) block.push(`  错误：${outcome.error}`)
      for (const problem of outcome.problems) block.push(`  复验问题：${problem}`)
      if (outcome.backup !== undefined) {
        block.push(`  原文件已备份在 \`${shortPath(outcome.backup)}\``)
      }
    }
    pushSection(lines, block)
  }

  if (plan.skips.length > 0) {
    const block = ['## 跳过的文件', '']
    for (const skip of plan.skips) {
      block.push(`- \`${shortPath(skip.file)}\`（${skip.rule}）：${skip.reason}`)
    }
    pushSection(lines, block)
  }

  pushSection(lines, unfixableSection(unfixable))

  if (plan.targets.length > 0 || (outcomes ?? []).length > 0) {
    pushSection(lines, [
      '## 下一步',
      '',
      ...dryRun ? ['- 确认上面列出的改动没问题，然后加 `--apply`。'] : [],
      '- 重跑一次 `dsh-skill-lint`，确认 SD013 / SD014 不再出现。',
      '- 要撤销：把 `<文件>.bak` 覆盖回原文件即可，备份没有自动删除。',
    ])
  }

  return lines.join('\n').replace(/\n+$/, '')
}

/** JSON 形态：给 CI 用，字段与 Markdown 一一对应。 */
export function renderFixJson(input: FixReportInput): string {
  const { plan, outcomes, unfixable } = input
  return JSON.stringify({
    dryRun: outcomes === undefined,
    targets: plan.targets.map(target => ({
      file: target.file,
      skills: target.skillNames,
      rules: target.rules,
      notes: target.notes,
      bytesBefore: target.before.length,
      bytesAfter: target.after.length,
    })),
    skips: plan.skips,
    outcomes: outcomes?.map(outcome => ({
      file: outcome.target.file,
      status: outcome.status,
      ...outcome.backup === undefined ? {} : { backup: outcome.backup },
      ...outcome.error === undefined ? {} : { error: outcome.error },
      problems: outcome.problems,
    })),
    unfixable,
  }, null, 2)
}
