/**
 * 工具侧写入（setDescription / fix）的集成测试。
 *
 * 这两条是客户端里"修复"的最后一步：用户确认草稿后不该被逼开终端。
 * 纪律没变——工具不生成文案、不碰语义，只执行用户给的那一行或字节级编码修复。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config'
import { buildDoctorTool } from '../src/tools/doctor'
import type { SkillInput } from '../src/types'
import { createFakeCtx, fakeExec } from './helpers'

const tmps: string[] = []

afterEach(() => {
  while (tmps.length > 0) {
    const dir = tmps.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 沙箱偶尔拒绝删除临时目录：不影响断言，忽略。
    }
  }
})

/** 造一个真实技能目录，返回技能输入与文件路径。 */
function skillAt(frontmatterDescription: string, body = '\n# 用法\n\n正文。\n'): { skill: SkillInput; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tool-write-'))
  tmps.push(dir)
  const file = join(dir, 'SKILL.md')
  writeFileSync(file, `---\nname: demo-skill\ndescription: ${frontmatterDescription}\n---\n${body}`, 'utf8')
  return {
    skill: {
      name: 'demo-skill',
      description: frontmatterDescription,
      content: '# 用法\n\n正文。\n',
      provider: 'filesystem',
      source: 'filesystem',
      path: file,
      invocation: { modelInvocable: true, userInvocable: true },
    },
    file,
  }
}

async function call(args: Record<string, unknown>, skill: SkillInput): Promise<string> {
  const env = createFakeCtx([{ skill }])
  const tool = buildDoctorTool(env.ctx as never, resolveConfig(undefined))
  return String(await tool.execute(args as never, fakeExec()))
}

describe('skill_doctor setDescription', () => {
  it('writes the confirmed draft, backs up, and reports the closed loop', async () => {
    const { skill, file } = skillAt('old short description')
    const draft = '当用户说「分段引用」时使用本技能：为手稿补引文。'
    const output = await call({ name: 'demo-skill', setDescription: draft }, skill)

    expect(output).toContain('已写入 description')
    expect(output).toContain('复诊对比')
    expect(readFileSync(file, 'utf8')).toContain(JSON.stringify(draft))
    expect(readFileSync(`${file}.bak`, 'utf8')).toContain('old short description')
  })

  it('refuses an over-limit draft and leaves the file untouched', async () => {
    const { skill, file } = skillAt('old')
    const before = readFileSync(file, 'utf8')
    const output = await call({ name: 'demo-skill', setDescription: 'x'.repeat(501) }, skill)

    expect(output).toContain('未写入')
    expect(output).toContain('超过上限')
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('refuses multiline text (frontmatter scalar cannot hold it)', async () => {
    const { skill, file } = skillAt('old')
    const output = await call({ name: 'demo-skill', setDescription: 'first line\nsecond line' }, skill)
    expect(output).toContain('未写入')
    expect(readFileSync(file, 'utf8')).toContain('description: old')
  })

  it('requires a name — batch writes are not allowed through the tool', async () => {
    const { skill } = skillAt('old')
    const output = await call({ setDescription: 'anything' }, skill)
    expect(output).toContain('写入需要指定技能')
    expect(output).toContain('--fix --apply')
  })
})

describe('skill_doctor fix', () => {
  it('strips a BOM and reports what was fixed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-write-bom-'))
    tmps.push(dir)
    const file = join(dir, 'SKILL.md')
    const text = '---\nname: demo-skill\ndescription: Use when the user asks to demo the fixer on a concrete file.\n---\n\n# 用法\n\n正文。\n'
    writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]))
    const skill: SkillInput = {
      name: 'demo-skill',
      description: 'Use when the user asks to demo the fixer on a concrete file.',
      content: '# 用法\n\n正文。\n',
      provider: 'filesystem',
      source: 'filesystem',
      path: file,
      invocation: { modelInvocable: true, userInvocable: true },
    }

    const output = await call({ name: 'demo-skill', fix: true }, skill)
    expect(output).toContain('自动修复')
    expect(output).toContain('SD013')
    const after = readFileSync(file)
    expect(after[0]).not.toBe(0xef)
  })

  it('says there is nothing to auto-fix instead of pretending', async () => {
    const { skill } = skillAt('Short and fine description for a demo skill used in tests.')
    const output = await call({ name: 'demo-skill', fix: true }, skill)
    expect(output).toContain('没有可自动修的内容')
    expect(output).toContain('语义问题只能人工改')
  })
})

describe('baseline defaults (0.10.0)', () => {
  it('enables the record by default — no config needed', async () => {
    const prev = process.env.DSH_HOME
    const home = mkdtempSync(join(tmpdir(), 'default-record-'))
    tmps.push(home)
    process.env.DSH_HOME = home
    try {
      const { skill } = skillAt('Use when the user asks to demo the default record behavior.')
      const env = createFakeCtx([{ skill }])
      // 不传任何配置：resolveConfig(undefined) 即默认 auto。
      const tool = buildDoctorTool(env.ctx as never, resolveConfig(undefined))
      const output = String(await tool.execute({} as never, fakeExec()))
      expect(output).toContain('第一次记录病历')
      const record = join(home, 'skill-doctor', 'record-default.json')
      expect(readFileSync(record, 'utf8')).toContain('demo-skill')
    } finally {
      process.env.DSH_HOME = prev
    }
  })

  it('writes nothing when the user opts out with baseline: off', async () => {
    const prev = process.env.DSH_HOME
    const home = mkdtempSync(join(tmpdir(), 'off-record-'))
    tmps.push(home)
    process.env.DSH_HOME = home
    try {
      const { skill } = skillAt('Use when the user asks to verify the opt-out path.')
      const env = createFakeCtx([{ skill }])
      const tool = buildDoctorTool(env.ctx as never, resolveConfig({ baseline: 'off' }))
      const output = String(await tool.execute({} as never, fakeExec()))
      expect(output).not.toContain('记录病历')
      expect(output).not.toContain('复诊对比')
    } finally {
      process.env.DSH_HOME = prev
    }
  })
})
