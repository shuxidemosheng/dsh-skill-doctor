import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config'
import { applyFixes } from '../src/fixer/apply'
import { planFixes, type FixTarget } from '../src/fixer/plan'
import { renderFixMarkdown } from '../src/fixer/report'
import { scanSkillFile } from '../src/scanner/fs-scan'
import { lintSkills } from '../src/scanner/scan'
import type { ScanResult } from '../src/types'

/** UTF-8 BOM。 */
const BOM = Buffer.from([0xef, 0xbb, 0xbf])

/** 一份干净、能通过结构检查的技能。 */
const CLEAN = [
  '---',
  'name: demo-skill',
  'description: Use when the user asks to demo the fixer on a concrete skill file and needs a deterministic result.',
  '---',
  '',
  '# Demo',
  '',
  'Step one.',
  '',
].join('\n')

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-fixer-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 写一个技能文件，按需加上 BOM 与 CRLF。 */
async function writeSkill(options: { bom?: boolean; crlf?: boolean } = {}): Promise<string> {
  const dir = join(root, 'demo-skill')
  await mkdir(dir, { recursive: true })
  const text = options.crlf === true ? CLEAN.replace(/\n/g, '\r\n') : CLEAN
  const bytes = options.bom === true
    ? Buffer.concat([BOM, Buffer.from(text, 'utf8')])
    : Buffer.from(text, 'utf8')
  const file = join(dir, 'SKILL.md')
  await writeFile(file, bytes)
  return file
}

/** 扫描 + lint，和 CLI 走同一条路径。 */
async function lint(files: readonly string[]): Promise<ScanResult> {
  const config = resolveConfig(undefined)
  const skills = []
  for (const file of files) {
    const skill = await scanSkillFile(file, config.maxFileBytes)
    if (skill === undefined) throw new Error(`scanSkillFile 返回 undefined: ${file}`)
    skills.push(skill)
  }
  return lintSkills(skills, config)
}

describe('planFixes', () => {
  it('plans BOM removal and CRLF normalisation for the same file', async () => {
    const file = await writeSkill({ bom: true, crlf: true })
    const plan = await planFixes((await lint([file])).results)

    expect(plan.targets).toHaveLength(1)
    expect(plan.targets[0]!.rules).toEqual(['SD013', 'SD014'])
    // 两种修复必须合并成一次写入，否则同一文件会被写两次、留两份备份。
    expect(plan.targets[0]!.after.equals(Buffer.from(CLEAN, 'utf8'))).toBe(true)
  })

  it('leaves a clean file alone', async () => {
    const file = await writeSkill()
    const plan = await planFixes((await lint([file])).results)
    expect(plan.targets).toHaveLength(0)
  })

  it('honours the only filter', async () => {
    const file = await writeSkill({ bom: true, crlf: true })
    const plan = await planFixes((await lint([file])).results, ['SD013'])

    expect(plan.targets).toHaveLength(1)
    expect(plan.targets[0]!.rules).toEqual(['SD013'])
    // 只修 BOM 时，CRLF 必须原样保留 —— 证明过滤是真的生效，而不是先修后筛。
    expect(plan.targets[0]!.after.includes(Buffer.from('\r\n'))).toBe(true)
  })
})

describe('applyFixes', () => {
  it('writes the fixed bytes and keeps a backup of the original', async () => {
    const file = await writeSkill({ bom: true, crlf: true })
    const original = await readFile(file)
    const plan = await planFixes((await lint([file])).results)

    const outcomes = await applyFixes(plan.targets, async () => [])

    expect(outcomes[0]!.status).toBe('applied')
    expect(await readFile(file)).toEqual(Buffer.from(CLEAN, 'utf8'))
    expect(outcomes[0]!.backup).toBeDefined()
    expect(await readFile(outcomes[0]!.backup!)).toEqual(original)
  })

  it('rolls back when verification reports a regression', async () => {
    const file = await writeSkill({ bom: true })
    const original = await readFile(file)
    const plan = await planFixes((await lint([file])).results)

    const outcomes = await applyFixes(plan.targets, async () => ['故意制造一个复验失败'])

    expect(outcomes[0]!.status).toBe('rolled-back')
    expect(outcomes[0]!.problems).toHaveLength(1)
    // 回滚的关键断言：磁盘内容和动手之前逐字节一致。
    expect(await readFile(file)).toEqual(original)
  })

  it('is idempotent: the second run has nothing to do', async () => {
    const file = await writeSkill({ bom: true, crlf: true })
    await applyFixes((await planFixes((await lint([file])).results)).targets, async () => [])

    const second = await planFixes((await lint([file])).results)
    expect(second.targets).toHaveLength(0)
  })

  it('reports a failure instead of throwing when the file is gone', async () => {
    const missing = join(root, 'gone', 'SKILL.md')
    const target: FixTarget = {
      file: missing,
      skillNames: ['demo-skill'],
      rules: ['SD013'],
      before: Buffer.from('x'),
      after: Buffer.from('y'),
      notes: ['假的改动'],
    }

    const outcomes = await applyFixes([target], async () => [])

    expect(outcomes[0]!.status).toBe('failed')
    expect(outcomes[0]!.error).toMatch(/备份失败/)
    // 失败时不能凭空造出备份文件。
    await expect(stat(`${missing}.bak`)).rejects.toThrow()
  })
})

describe('renderFixMarkdown', () => {
  it('produces well-formed markdown: closed bold markers, blank line before headings', async () => {
    const file = await writeSkill({ bom: true, crlf: true })
    const plan = await planFixes((await lint([file])).results)
    const outcomes = await applyFixes(plan.targets, async () => [])
    const markdown = renderFixMarkdown({
      plan,
      outcomes,
      unfixable: [{ rule: 'SD004', plainTitle: '简介太长', count: 1 }],
    })
    const lines = markdown.split('\n')

    // 结论行必须是成对的 **...**，否则整段粗体会一直延伸到下一个星号。
    for (const line of lines) {
      if (line.startsWith('**结论：')) expect(line.endsWith('**')).toBe(true)
    }
    // 标题缺前导空行时，部分渲染器会把它当成上一段的续行。
    for (let index = 1; index < lines.length; index++) {
      if (lines[index]!.startsWith('#')) expect(lines[index - 1]).toBe('')
    }
    expect(markdown).toContain('## 这些没动，因为改法不唯一')
  })
})
