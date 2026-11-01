import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config'
import { scanSkillFile } from '../src/scanner/fs-scan.js'
import { setDescription, validateDraft } from '../src/fixer/description'

/** 一个临时技能目录；SKILL.md 内容由调用方给。 */
function skillDir(body: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'set-desc-'))
  const file = join(dir, 'SKILL.md')
  writeRaw(file, body)
  return { dir, file }
}

function writeRaw(file: string, body: string): void {
  writeFileSync(file, body, 'utf8')
}

const config = resolveConfig(undefined)
const draft = '当用户说「分段引用」时使用本技能：为手稿补 Nature/CNS 引文。'

afterEach(() => {
  // 每个用例自建自删；这里兜底清 temp（失败也静默）。
})

describe('validateDraft', () => {
  it('rejects empty, multiline and over-limit drafts with actionable messages', () => {
    expect(validateDraft('   \n  ', 500)).toContain('空的')
    expect(validateDraft('a\nb', 500)).toContain('一行')
    expect(validateDraft('x'.repeat(501), 500)).toContain('超过上限 500 字')
    expect(validateDraft('x'.repeat(500), 500)).toBeUndefined()
  })
})

describe('setDescription', () => {
  const simple = '---\nname: demo\ndescription: old description here\n---\n\n# 用法\n\n正文。'

  it('plans without touching the file until apply', async () => {
    const { dir, file } = skillDir(simple)
    const candidates = [{ name: 'demo', path: file }]
    const planned = await setDescription({ skillName: 'demo', draft, candidates, config, apply: false })
    expect(planned.status).toBe('planned')
    expect(planned.beforeLength).toBe('old description here'.length)
    // 计划模式一个字节都不改。
    expect(readFileSync(file, 'utf8')).toBe(simple)
    expect(dir).toBeDefined()
  })

  it('applies with YAML-safe escaping, backup, and a re-scan that matches', async () => {
    const { file } = skillDir(simple)
    const tricky = '处理 "quoted" 与 key: value 以及 #tag 的场景'
    const outcome = await setDescription({
      skillName: 'demo', draft: tricky,
      candidates: [{ name: 'demo', path: file }], config, apply: true,
    })
    expect(outcome.status).toBe('applied')
    expect(outcome.afterLength).toBe(tricky.length)
    // 备份存在，且内容是旧的。
    expect(readFileSync(`${file}.bak`, 'utf8')).toContain('old description here')
    // 重新解析：description 精确等于草稿（转义没有破坏值），错误没有变多。
    const rescanned = await scanSkillFile(file, config.maxFileBytes)
    expect(rescanned?.description).toBe(tricky)
  })

  it('keeps the rest of the file byte-identical', async () => {
    const { file } = skillDir(simple)
    await setDescription({ skillName: 'demo', draft, candidates: [{ name: 'demo', path: file }], config, apply: true })
    const after = readFileSync(file, 'utf8')
    expect(after).toContain('# 用法\n\n正文。')
    expect(after).toContain('name: demo')
    expect(after).not.toContain('old description here')
  })

  it('refuses block scalars instead of producing a broken file', async () => {
    const { file } = skillDir('---\nname: demo\ndescription: >-\n  multi line\n  old text\n---\n\n正文。')
    const outcome = await setDescription({
      skillName: 'demo', draft,
      candidates: [{ name: 'demo', path: file }], config, apply: true,
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('块标量')
    // 文件原样保留。
    expect(readFileSync(file, 'utf8')).toContain('multi line')
  })

  it('refuses over-limit and multiline drafts', async () => {
    const { file } = skillDir(simple)
    const over = await setDescription({
      skillName: 'demo', draft: 'x'.repeat(501),
      candidates: [{ name: 'demo', path: file }], config, apply: true,
    })
    expect(over.status).toBe('failed')
    expect(over.error).toContain('超过上限')
    const multiline = await setDescription({
      skillName: 'demo', draft: '第一行\n第二行',
      candidates: [{ name: 'demo', path: file }], config, apply: true,
    })
    expect(multiline.status).toBe('failed')
    expect(readFileSync(file, 'utf8')).toBe(simple)
  })

  it('reports a missing skill instead of guessing', async () => {
    const { file } = skillDir(simple)
    const outcome = await setDescription({
      skillName: 'nope', draft, candidates: [{ name: 'demo', path: file }], config, apply: true,
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('没有叫')
  })

  it('refuses ambiguous duplicates (SD009 territory)', async () => {
    const { file } = skillDir(simple)
    const outcome = await setDescription({
      skillName: 'demo',
      draft,
      candidates: [{ name: 'demo', path: file }, { name: 'demo', path: join(tmpdir(), 'other', 'SKILL.md') }],
      config,
      apply: true,
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('副本')
  })

  it('preserves CRLF line endings outside the replaced line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'set-desc-crlf-'))
    const file = join(dir, 'SKILL.md')
    const crlf = ['---', 'name: demo', 'description: old', '---', '', '正文。', ''].join('\r\n')
    writeFileSync(file, crlf, 'utf8')
    const outcome = await setDescription({
      skillName: 'demo', draft,
      candidates: [{ name: 'demo', path: file }], config, apply: true,
    })
    expect(outcome.status).toBe('applied')
    const after = readFileSync(file, 'utf8')
    expect(after).toContain('description: "')
    expect(after).toContain('\r\n')
    rmSync(dir, { recursive: true, force: true })
  })
})
