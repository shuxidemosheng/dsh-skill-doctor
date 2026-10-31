import { describe, expect, it } from 'vitest'
import { apply } from '../src/index'
import type { SkillInput } from '../src/types'
import { callTool, createFakeCtx, FIXTURES, loadFixture } from './helpers'
import type { FakeEntry } from './helpers'

/** 第一屏 = 技术细节之前的部分；验收要求它不出现规则 ID 和技术字段。 */
function firstScreen(output: string): string {
  return output.split('## 技术细节')[0] ?? output
}

async function envWith(...dirs: string[]) {
  const entries: FakeEntry[] = []
  for (const dir of dirs) entries.push({ skill: await loadFixture(dir) })
  return createFakeCtx(entries)
}

describe('apply(): registration and yield discipline', () => {
  it('registers skill_doctor, skill_lint and skill_explain', async () => {
    const env = await envWith('good-skill')
    apply(env.ctx as never, undefined)
    expect([...env.tools.keys()].sort()).toEqual(['plugin_doctor', 'skill_doctor', 'skill_explain', 'skill_lint'])
  })

  it('yields when a tool name is already registered', async () => {
    const env = await envWith('good-skill')
    env.tools.set('skill_lint', { name: 'skill_lint', execute: async () => '' })
    apply(env.ctx as never, undefined)
    expect(env.tools.has('skill_explain')).toBe(true)
    expect(env.warnings.join('\n')).toMatch(/skill_lint.*already registered/)
  })

  it('an invalid config disables the plugin with a warn', async () => {
    const env = await envWith('good-skill')
    apply(env.ctx as never, { nope: true } as never)
    expect(env.tools.size).toBe(0)
    expect(env.warnings.join('\n')).toMatch(/skill-doctor disabled/)
  })
})

describe('skill_lint', () => {
  it('reports findings for a bad skill', async () => {
    const env = await envWith('good-skill', 'bad-name')
    apply(env.ctx as never, undefined)
    const output = String(await callTool(env, 'skill_lint', { name: 'Bad_Name' }))
    expect(output).toMatch(/SD002/)
    expect(output).toMatch(/SD005/)
  })

  it('returns parseable JSON', async () => {
    const env = await envWith('bad-name')
    apply(env.ctx as never, undefined)
    const output = String(await callTool(env, 'skill_lint', { name: 'Bad_Name', format: 'json' }))
    const parsed = JSON.parse(output) as { ok: boolean; summary: { errors: number } }
    expect(parsed.ok).toBe(false)
    expect(parsed.summary.errors).toBeGreaterThan(0)
  })

  it('detects duplicates through extraRoots', async () => {
    const env = await envWith('dup-a/dup')
    apply(env.ctx as never, undefined)
    const output = String(await callTool(env, 'skill_lint', {
      name: 'dup',
      extraRoots: [`${FIXTURES}dup-a`, `${FIXTURES}dup-b`],
    }))
    expect(output).toMatch(/SD009/)
  })

  it('rejects an unknown rule id', async () => {
    const env = await envWith('good-skill')
    apply(env.ctx as never, undefined)
    await expect(callTool(env, 'skill_lint', { rules: ['SD999'] })).rejects.toThrow(/unknown rule id/)
  })
})

describe('skill_explain', () => {
  it('explains a healthy skill', async () => {
    const env = await envWith('good-skill')
    apply(env.ctx as never, undefined)
    const output = String(await callTool(env, 'skill_explain', { name: 'good-skill' }))
    expect(output).toMatch(/来源：本地文件/)
    expect(output).toMatch(/provider: filesystem/)
    expect(output).toMatch(/model-invocable）：能 yes/)
    expect(output).toMatch(/ctx\.skills\.get）：能 yes/)
  })

  it('explains a missing skill', async () => {
    const env = await envWith('good-skill')
    apply(env.ctx as never, undefined)
    const output = String(await callTool(env, 'skill_explain', { name: 'nope' }))
    expect(output).toMatch(/未找到/)
  })
})

describe('skill_doctor', () => {
  it('gives a plain-language verdict and what the model actually sees', async () => {
    const env = await envWith('good-skill')
    apply(env.ctx as never, undefined)
    const output = String(await callTool(env, 'skill_doctor', { name: 'good-skill' }))
    const screen = firstScreen(output)
    expect(screen).toMatch(/结论：没问题/)
    expect(screen).toMatch(/模型看到的信息/)
    // 第一屏不能出现规则 ID 或 provider / model-invocable 这类字段名。
    expect(screen).not.toMatch(/SD0\d\d/)
    expect(screen).not.toMatch(/model-invocable/)
    expect(screen).not.toMatch(/provider:/)
  })

  it('shows the description exactly as the model sees it, not a summary', async () => {
    // 模型读到的就是 slice(0, limit)；给摘要会让“我的触发词在不在里面”这个判断失去依据。
    const description = `${'A'.repeat(300)}${'B'.repeat(300)}`
    const skill: SkillInput = {
      name: 'long-desc',
      description,
      content: 'Steps.',
      provider: 'filesystem',
      source: 'filesystem',
      invocation: { modelInvocable: true, userInvocable: true },
      path: `${FIXTURES}long-desc/SKILL.md`,
    }
    const env = createFakeCtx([{ skill }])
    apply(env.ctx as never, undefined)
    const output = String(await callTool(env, 'skill_doctor', { name: 'long-desc' }))
    const quote = output.split('\n').find(line => line.startsWith('> '))

    expect(quote).toBe(`> ${description.slice(0, 500)}`)
    // 仍是顶层引用块（列表项里嵌引用块在部分渲染器里会被拆散）。
    expect(output.split('\n').some(line => line.startsWith('  > '))).toBe(false)
  })

  it('does not pretend to see byte-level problems inside a runtime session', async () => {
    // 运行时的 skills.get 不返回文件原文，"BOM / CRLF"这两条只有 CLI 扫磁盘时才可能命中。
    // 这条测试锁的是"不谎报"：不能因为看不见就当成没问题，也不能凭空报出 SD013。
    const env = await envWith('good-skill')
    apply(env.ctx as never, undefined)
    const output = String(await callTool(env, 'skill_doctor', { name: 'good-skill' }))

    expect(output).not.toMatch(/SD013|SD014/)
  })

  it('labels a semantic problem as something only a human can fix', async () => {
    // 改名会打断已有引用、简介要人写，这类问题不给一键修复的错觉。
    const env = await envWith('bad-name')
    apply(env.ctx as never, undefined)
    const output = String(await callTool(env, 'skill_doctor', { name: 'Bad_Name' }))

    expect(output).toMatch(/处方：✍️ 只能人工改/)
    expect(firstScreen(output)).not.toMatch(/SD002/)
  })

  it('keeps the description quote at top level, not nested in a list item', async () => {
    // 回归：列表项里嵌引用块 + 缩进续行，在部分 Markdown 渲染器里会被拆散。
    const env = await envWith('good-skill')
    apply(env.ctx as never, undefined)
    const output = String(await callTool(env, 'skill_doctor', { name: 'good-skill' }))
    const lines = output.split('\n')
    const quoteAt = lines.findIndex(line => line.startsWith('> '))
    expect(quoteAt).toBeGreaterThan(0)
    expect(lines[quoteAt - 2]).toBe('**简介**（模型靠它决定“要不要用这个技能”）：')
    expect(lines.some(line => line.startsWith('  > '))).toBe(false)
  })

  it('says a broken skill probably will not work, in plain words', async () => {
    const env = await envWith('bad-name')
    apply(env.ctx as never, undefined)
    const output = String(await callTool(env, 'skill_doctor', { name: 'Bad_Name' }))
    expect(output).toMatch(/结论：有错误/)
    // 规则 ID 只在文末技术细节里出现，第一屏说人话。
    expect(firstScreen(output)).not.toMatch(/SD002/)
    expect(output).toMatch(/SD002/)
    expect(output).toMatch(/处方：/)
  })

  it('returns a grouped report when no name is given', async () => {
    const env = await envWith('good-skill', 'bad-name')
    apply(env.ctx as never, undefined)
    const output = String(await callTool(env, 'skill_doctor', {}))
    expect(output).toMatch(/一共检查了 2 个技能/)
    expect(output).toMatch(/先修这些/)
    expect(output).toMatch(/没问题（1 个）/)
  })

  it('points to the plugin layer when zero skills are visible', async () => {
    // 会诊的反方向：技能全没了时，别只盯着技能文件——插件 patch 改目录是同症状的常见根因。
    const env = createFakeCtx([])
    apply(env.ctx as never, undefined)
    const output = String(await callTool(env, 'skill_doctor', {}))
    expect(output).toMatch(/没有找到技能/)
    expect(output).toContain('插件层')
    expect(output).toContain('plugin_doctor')
  })

  it('reports duplicate names in single-skill mode when extraRoots is given', async () => {
    // 回归 D1：单技能分支曾经直接 lintSkill(skill)，导致 extraRoots 里的同名副本被忽略。
    const env = await envWith('dup-a/dup')
    apply(env.ctx as never, undefined)
    const output = String(await callTool(env, 'skill_doctor', {
      name: 'dup',
      extraRoots: [`${FIXTURES}dup-a`, `${FIXTURES}dup-b`],
    }))
    expect(output).toMatch(/同名/)
  })

  it('marks host-bundled virtual skills so they are not mistaken for user skills', async () => {
    // 回归 D2：bundled 虚拟技能没有本地路径，报告要说明它不属于用户目录。
    const bundled: SkillInput = {
      name: 'host-diag',
      description: 'Use on Windows when the sandbox denies a write and you need to diagnose the ACL.',
      content: 'Steps.',
      provider: 'dsh-windows-acl',
      source: 'bundled',
      invocation: { modelInvocable: true, userInvocable: true },
    }
    const env = createFakeCtx([{ skill: bundled }])
    apply(env.ctx as never, undefined)
    const output = String(await callTool(env, 'skill_doctor', {}))
    expect(output).toMatch(/dsh 自带/)
  })

  it('explains which trigger words the model cannot see', async () => {
    // 简介超过上限，而且被切掉的部分正好是中文触发词 —— 最典型的“技能没反应”场景。
    const skill: SkillInput = {
      name: 'trunc-demo',
      description: 'Handle general research writing tasks for manuscripts. '
        + '当用户说「分段引用」「自动给出引用」时使用本技能。',
      content: 'Do the work.',
      provider: 'filesystem',
      source: 'filesystem',
      invocation: { modelInvocable: true, userInvocable: true },
    }
    const env = createFakeCtx([{ skill }])
    apply(env.ctx as never, { maxDescriptionLength: 60 })
    const output = String(await callTool(env, 'skill_doctor', { name: 'trunc-demo' }))
    expect(output).toMatch(/被切掉的部分/)
    expect(output).toMatch(/影响：大/)
    expect(output).toMatch(/分段引用/)
    expect(firstScreen(output)).toMatch(/只能看到简介的前 60 字|模型只能看到前 60 字/)
  })
})
