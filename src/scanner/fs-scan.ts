/** CLI/本地文件扫描：把 SKILL.md 或平铺 .md 归一化成 SkillInput。 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { SkillInput } from '../types.js'
import { parseFrontmatter } from './frontmatter.js'
import { stem } from './text.js'

/** 扫描结果 + 非致命读取问题。 */
export interface FsScanResult {
  readonly skills: SkillInput[]
  readonly issues: string[]
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'lib', '.system'])

/** 展开 ~ 与环境无关的绝对化。 */
export function expandPath(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homedir(), input.slice(2))
  return resolve(input)
}

function lenientBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  if (value === 1 || value === 0) return value === 1
  if (typeof value !== 'string') return fallback
  if (/^(true|yes|on)$/i.test(value)) return true
  if (/^(false|no|off)$/i.test(value)) return false
  return fallback
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * 读取一个技能文件。读取失败/超过上限时返回 undefined。
 * @param filePath - SKILL.md 或平铺 .md 的路径。
 * @param maxFileBytes - 单文件上限。
 */
export async function scanSkillFile(filePath: string, maxFileBytes: number): Promise<SkillInput | undefined> {
  const absolute = resolve(filePath)
  let size: number
  try {
    size = (await stat(absolute)).size
  } catch {
    return undefined
  }
  if (size > maxFileBytes) return undefined

  let raw: string
  try {
    raw = await readFile(absolute, 'utf8')
  } catch {
    return undefined
  }

  const parsed = parseFrontmatter(raw)
  const base = basename(absolute).toLowerCase() === 'skill.md' ? basename(dirname(absolute)) : stem(absolute)
  const name = asString(parsed.data.name) ?? base
  const description = asString(parsed.data.description) ?? ''
  const whenToUse = asString(parsed.data.when_to_use) ?? asString(parsed.data.whenToUse)
  const modelInvocable = !lenientBoolean(parsed.data['disable-model-invocation'], false)
  const userInvocable = lenientBoolean(parsed.data['user-invocable'], true)

  return {
    name,
    description,
    ...whenToUse === undefined ? {} : { whenToUse },
    content: parsed.body,
    metadata: parsed.data,
    path: absolute,
    provider: 'filesystem',
    source: 'filesystem',
    invocation: { modelInvocable, userInvocable },
    resourceBase: { kind: 'directory', path: dirname(absolute) },
    raw,
    directoryName: base,
  }
}

/**
 * 扫描一个根：单文件、单个技能目录（含 SKILL.md），或一层技能根。
 * 只扫描一层，避免误把任意 Markdown 文档当技能。
 * @param rootInput - 文件或目录路径，支持 ~。
 * @param maxFileBytes - 单文件上限。
 */
export async function scanRoot(rootInput: string, maxFileBytes: number): Promise<FsScanResult> {
  const root = expandPath(rootInput)
  const skills: SkillInput[] = []
  const issues: string[] = []

  let info
  try {
    info = await stat(root)
  } catch {
    issues.push(`${rootInput}: not found`)
    return { skills, issues }
  }

  if (info.isFile()) {
    if (!root.toLowerCase().endsWith('.md')) {
      issues.push(`${rootInput}: not a markdown file`)
      return { skills, issues }
    }
    const skill = await scanSkillFile(root, maxFileBytes)
    if (skill === undefined) issues.push(`${rootInput}: unreadable or too large`)
    else skills.push(skill)
    return { skills, issues }
  }

  if (!info.isDirectory()) {
    issues.push(`${rootInput}: not a file or directory`)
    return { skills, issues }
  }

  const bundle = join(root, 'SKILL.md')
  try {
    if ((await stat(bundle)).isFile()) {
      const skill = await scanSkillFile(bundle, maxFileBytes)
      if (skill === undefined) issues.push(`${bundle}: unreadable or too large`)
      else skills.push(skill)
      return { skills, issues }
    }
  } catch {
    // 不是单技能目录，继续按技能根扫描。
  }

  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    issues.push(`${rootInput}: ${error instanceof Error ? error.message : String(error)}`)
    return { skills, issues }
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    // `_references` 等共享资源目录不是技能；默认跳过，避免把它当成坏技能。
    if (entry.name.startsWith('_')) continue
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      try {
        if (!(await stat(join(full, 'SKILL.md'))).isFile()) continue
      } catch {
        continue
      }
      const skill = await scanSkillFile(join(full, 'SKILL.md'), maxFileBytes)
      if (skill === undefined) issues.push(`${full}: unreadable or too large`)
      else skills.push(skill)
      continue
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      const skill = await scanSkillFile(full, maxFileBytes)
      if (skill !== undefined) skills.push(skill)
    }
  }

  return { skills, issues }
}

/** 扫描多个根，合并结果。 */
export async function scanRoots(rootInputs: readonly string[], maxFileBytes: number): Promise<FsScanResult> {
  const skills: SkillInput[] = []
  const issues: string[] = []
  for (const root of rootInputs) {
    const result = await scanRoot(root, maxFileBytes)
    skills.push(...result.skills)
    issues.push(...result.issues)
  }
  return { skills, issues }
}
