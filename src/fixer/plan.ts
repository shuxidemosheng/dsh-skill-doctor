/**
 * 自动修复的“计划层”：只判断能不能修、修成什么样，不落盘。
 *
 * 设计原则：这里只收**改法唯一**的规则。任何需要读懂语义才能决定的
 * （简介怎么重写、同名留哪个、可疑指令要不要删）一律不进这个文件。
 */
import { readFile } from 'node:fs/promises'
import type { SkillLintResult } from '../types.js'

/**
 * 能被自动修复的规则。
 *
 * 只有两条：
 * - SD013 BOM：开头 3 个字节是固定标记，删掉就是删掉，没有第二种改法。
 * - SD014 CRLF：把 \r\n 换成 \n，字节到字节的确定映射。
 *
 * 刻意排除的两条（曾经以为能修，核对代码后否掉）：
 * - SD010 布尔值：只有**不宽松**的值才报这条（`"maybe"`、`2`），这种没法猜用户想写什么；
 *   而 `yes/no/on/off` 本来就被接受，压根不会产生 finding，改了也没意义。
 * - SD010 旧字段名：`modelInvocable` 要变成 `disable-model-invocation` 得**取反**，
 *   语义不是改名；在没验证 dsh 是否真不认 camelCase 之前，自动改等于破坏。
 */
export const FIXABLE_RULES = ['SD013', 'SD014'] as const

export type FixableRule = (typeof FIXABLE_RULES)[number]

/** 一个待修文件：同一文件的全部修复已经合并成一份 before/after。 */
export interface FixTarget {
  /** 绝对路径。 */
  readonly file: string
  /** 指向这个文件的技能名，用于报告里说明“改的是哪个技能”。 */
  readonly skillNames: readonly string[]
  /** 实际会执行的修复动作。 */
  readonly rules: readonly FixableRule[]
  /** 原始字节。 */
  readonly before: Buffer
  /** 修好后的字节。 */
  readonly after: Buffer
  /** 人话描述，逐条对应 rules。 */
  readonly notes: readonly string[]
}

/** 想修但修不了的，要如实说出来，不能静默跳过。 */
export interface FixSkip {
  readonly file: string
  readonly rule: string
  readonly reason: string
}

export interface FixPlan {
  readonly targets: readonly FixTarget[]
  readonly skips: readonly FixSkip[]
}

/** UTF-8 BOM 的三个字节。 */
const BOM = Buffer.from([0xef, 0xbb, 0xbf])

function isFixable(rule: string): rule is FixableRule {
  return (FIXABLE_RULES as readonly string[]).includes(rule)
}

function hasBom(buffer: Buffer): boolean {
  return buffer.length >= BOM.length && buffer.subarray(0, BOM.length).equals(BOM)
}

/**
 * 生成修复计划。
 * @param results - 已完成的 lint 结果（提供 findings 与文件路径）。
 * @param only - 只修这些规则；默认全部可修规则。
 */
export async function planFixes(
  results: readonly SkillLintResult[],
  only: readonly FixableRule[] = FIXABLE_RULES,
): Promise<FixPlan> {
  const wanted = new Set<FixableRule>(only)

  // 同一文件可能被多个技能条目指向（例如两个 root 装了同一份），按文件聚合，
  // 否则会写两次、生成两份备份。
  const byFile = new Map<string, { rules: Set<FixableRule>; skillNames: Set<string> }>()
  for (const result of results) {
    for (const finding of result.findings) {
      const file = finding.file
      if (file === undefined || !isFixable(finding.rule) || !wanted.has(finding.rule)) continue
      const entry = byFile.get(file) ?? { rules: new Set<FixableRule>(), skillNames: new Set<string>() }
      entry.rules.add(finding.rule)
      entry.skillNames.add(result.skill.name)
      byFile.set(file, entry)
    }
  }

  const targets: FixTarget[] = []
  const skips: FixSkip[] = []

  for (const [file, entry] of byFile) {
    let before: Buffer
    try {
      before = await readFile(file)
    } catch (error) {
      skips.push({
        file,
        rule: [...entry.rules].join('、'),
        reason: `读不出原始字节：${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }

    let current = before
    const notes: string[] = []
    const applied: FixableRule[] = []

    if (entry.rules.has('SD013') && hasBom(current)) {
      current = Buffer.from(current.subarray(BOM.length))
      notes.push('去掉文件开头的 BOM（3 个字节）')
      applied.push('SD013')
    }

    if (entry.rules.has('SD014')) {
      // 用 latin1 做替换：它是字节到字符的 1:1 映射，
      // 不会像 utf8 解码那样把非法字节替换成 U+FFFD 再写回去。
      const text = current.toString('latin1')
      const occurrences = text.split('\r\n').length - 1
      if (occurrences > 0) {
        current = Buffer.from(text.replace(/\r\n/g, '\n'), 'latin1')
        notes.push(`把 ${occurrences} 处 CRLF 换行统一成 LF`)
        applied.push('SD014')
      }
    }

    // 幂等：finding 说有问题，但字节层面已经没有可改的（例如规则被配置改过级别）。
    // 这种情况不写文件，否则会产生“改了 0 字节”的假记录。
    if (applied.length === 0 || current.equals(before)) continue

    targets.push({
      file,
      skillNames: [...entry.skillNames],
      rules: applied,
      before,
      after: current,
      notes,
    })
  }

  return { targets, skips }
}
