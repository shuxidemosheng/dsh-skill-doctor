/**
 * description 写入器：把用户确认过的草稿写进 SKILL.md 的 frontmatter。
 *
 * 为什么存在：改写工单产出草稿后，“确认后写入”如果让模型手改 frontmatter，
 * YAML 转义（引号、冒号、#）是稳定的事故源。这条命令把写入变成确定性操作：
 * 内容由用户显式提供，命令只负责定位那一行、安全转义、备份、复验、回滚。
 *
 * 边界：
 *  - 只改 frontmatter 里的 description 一行；正文一个字节不碰。
 *  - 块标量（`description: >-` / `|`）的多行结构无法安全单行替换，明确拒绝
 *    并让用户手动改——宁可退回人工，也不产出一个解析不出来的文件。
 *  - 复验失败（写完读不出来 / 错误数变多）自动回滚，磁盘上不留半成品。
 */
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { scanSkillFile } from '../scanner/fs-scan.js'
import { lintSkill } from '../scanner/scan.js'
import type { ResolvedConfig } from '../config.js'

/** 一次写入的结果。 */
export interface DescriptionOutcome {
  readonly skillName: string
  readonly file: string
  readonly status: 'planned' | 'applied' | 'failed'
  readonly beforeLength: number
  readonly afterLength: number
  readonly error?: string
}

/** 单行草稿的预处理校验；错误文案直接面向用户。 */
export function validateDraft(draft: string, limit: number): string | undefined {
  const text = draft.replace(/\r\n/g, '\n')
  if (text.trim().length === 0) return '草稿是空的：确认过的简介不能为空（SD003 会直接报错）。'
  if (/[\n\r]/.test(text.trim())) {
    return '草稿必须是一行：frontmatter 的单行标量放不下多行文案；请把换行压成空格。'
  }
  const trimmed = text.trim()
  if (trimmed.length > limit) {
    return `草稿有 ${trimmed.length} 字，超过上限 ${limit} 字——先压缩再写入，命令不会静默截断。`
  }
  return undefined
}

/** 在 frontmatter 行数组里找 description 行；找不到或块标量都返回原因。 */
function locateDescriptionLine(lines: readonly string[]): { index: number; blockScalar: boolean } | { error: string } {
  if (lines[0]?.trim() !== '---') return { error: '文件第 1 行不是 ---，找不到文件头。' }
  let closing = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') { closing = i; break }
  }
  if (closing === -1) return { error: '文件头没有收尾的 ---，结构不完整。' }
  for (let i = 1; i < closing; i++) {
    // \r 要显式容忍：JS 正则的 . 不匹配 \r（它是行终止符），CRLF 文件会在这里漏配。
    const match = /^description:(?:[ \t]+(.*))?\r?$/.exec(lines[i] ?? '')
    if (match === null) continue
    const value = match[1] ?? ''
    // 块标量（| > 及其变体）的值在后续缩进行里，单行替换会撕碎结构。
    if (/^[|>]/.test(value.trim())) {
      return { index: i, blockScalar: true }
    }
    return { index: i, blockScalar: false }
  }
  return { error: 'frontmatter 里没有 description 键——dsh 找不到它，说明这个技能本就加载不了。' }
}

/**
 * 把草稿写入指定技能的 SKILL.md。
 * @param params.skillName - 目标技能名（按 name 精确匹配，区分大小写）。
 * @param params.draft - 用户确认过的新简介（单行）。
 * @param params.candidates - 已经扫描出来的技能（含 path），用来按名字定位文件。
 * @param params.config - 配置（上限、复验用的规则）。
 * @param params.apply - false 只出计划，true 才写盘。
 */
export async function setDescription(params: {
  skillName: string
  draft: string
  candidates: readonly { name: string; path?: string }[]
  config: ResolvedConfig
  apply: boolean
}): Promise<DescriptionOutcome> {
  const { skillName, draft, config, apply } = params
  const failed = (error: string, file = '', before = 0, after = 0): DescriptionOutcome => ({
    skillName, file, status: 'failed', beforeLength: before, afterLength: after, error,
  })

  const draftError = validateDraft(draft, config.maxDescriptionLength)
  if (draftError !== undefined) return failed(draftError)

  const matches = params.candidates.filter(candidate => candidate.name === skillName)
  if (matches.length === 0) {
    return failed(`当前视图里没有叫 \`${skillName}\` 的技能；确认名字，或用 extraRoots 把目录扫进来。`)
  }
  if (matches.length > 1) {
    return failed(`\`${skillName}\` 有 ${matches.length} 个副本（同名遮蔽）——先解决 SD009，再改简介，否则改的可能是被覆盖的那个。`)
  }
  const file = matches[0]!.path
  if (file === undefined) {
    return failed('这个技能没有本地文件（dsh 自带的虚拟技能），改不了。')
  }

  const raw = await readFile(file, 'utf8')
  const lines = raw.split('\n')
  const located = locateDescriptionLine(lines)
  if ('error' in located) return failed(located.error, file)

  // 写之前的基线：当前 description 长度 + 当前错误数（复验时错误不允许变多）。
  const beforeSkill = await scanSkillFile(file, config.maxFileBytes)
  if (beforeSkill === undefined) return failed('文件当前就读不出来（扫描失败），先手动排查。', file)
  const beforeLint = await lintSkill(beforeSkill, config)
  const beforeLength = beforeSkill.description.length
  if (located.blockScalar) {
    return failed(
      'description 是块标量（多行写法），单行替换会破坏结构——请手动编辑这一段；'
      + '或者先把它压成单行再跑本命令。',
      file, beforeLength, draft.trim().length,
    )
  }

  // JSON 字符串是合法的 YAML 双引号标量：引号、冒号、# 全部安全转义。
  // 行尾的 \r 要保留，否则 LF/CRLF 混排。
  const eol = (lines[located.index] ?? '').endsWith('\r') ? '\r' : ''
  const newLine = `description: ${JSON.stringify(draft.trim())}${eol}`
  const planned = [...lines.slice(0, located.index), newLine, ...lines.slice(located.index + 1)].join('\n')

  if (!apply) {
    return { skillName, file, status: 'planned', beforeLength, afterLength: draft.trim().length }
  }

  const backup = `${file}.bak`
  await copyFile(file, backup)
  await writeFile(file, planned, 'utf8')

  // 复验：磁盘上这份要能被重新解析，description 确实变成草稿，且错误没变多。
  const rescanned = await scanSkillFile(file, config.maxFileBytes)
  if (rescanned === undefined || rescanned.description !== draft.trim()) {
    await writeFile(file, raw, 'utf8')
    return failed('写入后复验失败（description 没有变成草稿），已回滚到原内容；备份在 .bak。', file, beforeLength, draft.trim().length)
  }
  const after = await lintSkill(rescanned, config)
  if (after.errors > beforeLint.errors) {
    await writeFile(file, raw, 'utf8')
    return failed(
      `写入后错误数变多（${beforeLint.errors} → ${after.errors}），已回滚；备份在 .bak。`,
      file, beforeLength, draft.trim().length,
    )
  }
  return { skillName, file, status: 'applied', beforeLength, afterLength: draft.trim().length }
}
