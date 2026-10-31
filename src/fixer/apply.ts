/**
 * 落盘层：备份 → 写入 → 复验 → 复验失败自动回滚。
 *
 * 单独抽出来是因为“写文件”必须带这三个保护，任何一个缺失都会让
 * 一个 bug 变成用户技能被改坏。
 */
import { existsSync } from 'node:fs'
import { copyFile, writeFile } from 'node:fs/promises'
import type { FixTarget } from './plan.js'

/** 复验回调：返回空数组表示这份改动是安全的，否则返回人话问题列表。 */
export type Verify = (target: FixTarget) => Promise<readonly string[]>

export interface FixOutcome {
  readonly target: FixTarget
  /** applied 成功；failed 没写成；rolled-back 写成了但复验不过，已还原。 */
  readonly status: 'applied' | 'failed' | 'rolled-back'
  readonly backup?: string
  readonly error?: string
  /** 复验发现的问题（rolled-back 时非空）。 */
  readonly problems: readonly string[]
}

/**
 * 选一个不会覆盖旧备份的备份路径。
 * @param file - 原始文件路径。
 */
function backupPathFor(file: string): string {
  const first = `${file}.bak`
  if (!existsSync(first)) return first
  for (let index = 1; index < 100; index++) {
    const candidate = `${file}.bak.${index}`
    if (!existsSync(candidate)) return candidate
  }
  throw new Error('备份文件太多了（.bak.1 ~ .bak.99 都已存在），请先清理')
}

/**
 * 依次应用修复。单个文件失败不影响其他文件。
 * @param targets - 修复计划里的目标。
 * @param verify - 写后复验；返回问题列表则回滚。
 */
export async function applyFixes(
  targets: readonly FixTarget[],
  verify: Verify,
): Promise<FixOutcome[]> {
  const outcomes: FixOutcome[] = []

  for (const target of targets) {
    let backup: string
    try {
      backup = backupPathFor(target.file)
      await copyFile(target.file, backup)
    } catch (error) {
      outcomes.push({
        target,
        status: 'failed',
        error: `备份失败，没有写入：${error instanceof Error ? error.message : String(error)}`,
        problems: [],
      })
      continue
    }

    try {
      await writeFile(target.file, target.after)
    } catch (error) {
      outcomes.push({
        target,
        status: 'failed',
        backup,
        error: `写入失败：${error instanceof Error ? error.message : String(error)}`,
        problems: [],
      })
      continue
    }

    let problems: readonly string[]
    try {
      problems = await verify(target)
    } catch (error) {
      problems = [`复验过程本身出错：${error instanceof Error ? error.message : String(error)}`]
    }

    if (problems.length > 0) {
      // 复验不过说明这次修改引入了新问题，立刻用备份还原，
      // 宁可什么都没改成，也不能把用户的技能留在更坏的状态。
      try {
        await copyFile(backup, target.file)
        outcomes.push({ target, status: 'rolled-back', backup, problems })
      } catch (error) {
        outcomes.push({
          target,
          status: 'failed',
          backup,
          error: `复验不过且还原失败，请手动用备份覆盖：${error instanceof Error ? error.message : String(error)}`,
          problems,
        })
      }
      continue
    }

    outcomes.push({ target, status: 'applied', backup, problems: [] })
  }

  return outcomes
}
