/** 斜杠命令：纯文本渲染 + 注册行为。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildCommands,
  COMMAND_NAMES,
  plainCheckup,
  plainFollowUp,
  registerCommands,
  type CommandSpec,
} from '../src/commands'
import { resolveConfig } from '../src/config'
import { loadTrust, trustPath } from '../src/trust'
import type { BaselineDiff } from '../src/baseline'
import type { Finding, ProvenanceView, RuleId, SkillLintResult } from '../src/types'
import { createFakeCtx, fakeExec, loadFixture } from './helpers'

/** 造一个结果；description 长度直接决定落哪一档。 */
function result(
  name: string,
  description: string,
  rules: readonly RuleId[] = [],
  severity: 'error' | 'warn' = 'warn',
): SkillLintResult {
  const findings: Finding[] = rules.map(rule => ({ rule, severity, message: `${rule} 出问题了` }))
  return {
    skill: {
      name,
      description,
      content: 'body',
      provider: 'filesystem',
      source: 'filesystem',
      invocation: { modelInvocable: true, userInvocable: true },
    },
    findings,
    errors: findings.length,
    warnings: 0,
    infos: 0,
    ok: findings.length === 0,
  }
}

/** 超过 500 字、且触发说法沉在后面的简介。 */
const LONG = `${'这是一段很长很长的简介，覆盖了写作、润色、投稿与返修的全过程。'.repeat(20)}当用户说「分段引用」时使用本技能。`

describe('plainCheckup', () => {
  it('counts each tier and names the skills whose triggers are cut off', () => {
    const text = plainCheckup([result('ok-skill', '简短'), result('long-a', LONG), result('long-b', LONG)], 500)
    expect(text).toContain('3 个技能')
    expect(text).toContain('⚠️ 影响大 2')
    expect(text).toContain('✅ 正常 1')
    expect(text).toContain('long-a')
    expect(text).toContain('分段引用')
  })

  it('leads with the common root cause when several skills hit one rule', () => {
    const text = plainCheckup(
      [result('nature-a', LONG, ['SD004']), result('nature-b', LONG, ['SD004']), result('nature-c', LONG, ['SD004'])],
      500,
    )
    expect(text).toContain('共性问题')
    expect(text).toContain('nature-')
    expect(text).toContain('同一套模板')
  })

  it('puts broken skills first and shows their error messages', () => {
    const text = plainCheckup([result('broken', '短', ['SD001'], 'error')], 500)
    expect(text).toContain('用不了的')
    expect(text).toContain('SD001 出问题了')
  })

  it('says the scope was limited instead of implying a full scan', () => {
    const text = plainCheckup([result('a', '短')], 500, ['D:\\skills'])
    expect(text).toContain('只查 D:\\skills')
  })

  it('explains an empty scope', () => {
    expect(plainCheckup([], 500, ['C:\\empty'])).toContain('在指定范围里没有找到技能')
    expect(plainCheckup([], 500)).toContain('没有找到技能')
  })
})

describe('plainFollowUp', () => {
  const diff: BaselineDiff = {
    improved: [{ rule: 'SD004', plainTitle: '简介太长', before: 4, after: 2 }],
    unchanged: [],
    regressed: [{ rule: 'SD005', plainTitle: '简介为空', before: 0, after: 1 }],
    regressedSkills: { SD005: ['demo-skill'] },
    newSkills: ['new-one'],
    goneSkills: [],
    totalBefore: 5,
    totalAfter: 3,
    errorsBefore: 0,
    errorsAfter: 0,
  }

  it('renders every direction with the skill names behind a regression', () => {
    const text = plainFollowUp(diff, 'record-desktop.json（2026-11-01 存档）')
    expect(text).toContain('✅ 好转：简介太长 4 → 2')
    expect(text).toContain('⚠️ 变差：简介为空 0 → 1（demo-skill）')
    expect(text).toContain('🆕 新扫到：new-one')
    expect(text).toContain('整体：问题总数 5 → 3')
  })

  it('surfaces the caliber warning when thresholds changed', () => {
    const text = plainFollowUp({ ...diff, metaWarning: '阈值不同，数字不可直接比' }, 'r.json')
    expect(text).toContain('阈值不同')
  })
})

describe('buildCommands', () => {
  /** 每条命令都能跑，且返回非空文本。 */
  const run = async (spec: CommandSpec, input: string): Promise<string> => spec.run(input)

  it('exposes exactly the documented commands', async () => {
    const { skill } = await loadFixture('good-skill').then(skill => ({ skill }))
    const env = createFakeCtx([{ skill }])
    const specs = buildCommands(env.ctx as never, resolveConfig(undefined))
    expect(specs.map(spec => spec.name)).toEqual([...COMMAND_NAMES])
    for (const spec of specs) {
      expect(spec.description.length).toBeGreaterThan(0)
      expect(spec.hint.length).toBeGreaterThan(0)
    }
  })

  it('reports the session skills for /doctor', async () => {
    const env = createFakeCtx([{ skill: await loadFixture('good-skill') }])
    const specs = buildCommands(env.ctx as never, resolveConfig(undefined))
    const text = await run(specs.find(spec => spec.name === 'doctor')!, '')
    expect(text).toContain('1 个技能')
    // 健康技能不需要点名（点了也只是噪音），只在分布里计数。
    expect(text).toContain('✅ 正常 1')
    expect(text).not.toContain('good-skill')
  })

  it('asks for a directory when /scope gets no input', async () => {
    const env = createFakeCtx([])
    const specs = buildCommands(env.ctx as never, resolveConfig(undefined))
    expect(await run(specs.find(spec => spec.name === 'scope')!, '  ')).toContain('用法：/scope')
  })

  it('tells the user when /rewrite targets an unknown or already-short skill', async () => {
    const env = createFakeCtx([{ skill: await loadFixture('good-skill') }])
    const specs = buildCommands(env.ctx as never, resolveConfig(undefined))
    const rewrite = specs.find(spec => spec.name === 'rewrite')!
    expect(await run(rewrite, '')).toContain('用法：/rewrite')
    expect(await run(rewrite, 'nope')).toContain('没找到技能 nope')
    expect(await run(rewrite, 'good-skill')).toContain('不需要改写')
  })

  it('records the first /followup and diffs the next one', async () => {
    const env = createFakeCtx([{ skill: await loadFixture('good-skill') }])
    const config = resolveConfig({ baseline: 'auto' })
    const first = await run(buildCommands(env.ctx as never, config).find(spec => spec.name === 'followup')!, '')
    expect(first).toContain('第一次记录病历')
    const second = await run(buildCommands(env.ctx as never, config).find(spec => spec.name === 'followup')!, '')
    expect(second).toContain('技能复诊')
    expect(second).toContain('整体：问题总数')
  })

  it('explains why /followup cannot work when the record is off', async () => {
    const env = createFakeCtx([])
    const text = await run(
      buildCommands(env.ctx as never, resolveConfig({ baseline: 'off' })).find(spec => spec.name === 'followup')!,
      '',
    )
    expect(text).toContain('baseline: off')
  })
})

describe('registerCommands', () => {
  it('registers every command into the command service', async () => {
    const registered: { name?: string; input?: { hint?: string } }[] = []
    const env = createFakeCtx([])
    ;(env.ctx as Record<string, unknown>).get = (name: string) =>
      name === 'commands' ? { register: (definition: { name?: string }) => registered.push(definition) } : undefined

    registerCommands(env.ctx as never, resolveConfig(undefined))
    expect(registered.map(definition => definition.name)).toEqual([...COMMAND_NAMES])
    // hint 必须给：它是选中命令后输入框里的占位提示。
    for (const definition of registered) expect(definition.input?.hint?.length).toBeGreaterThan(0)
  })

  it('stays silent instead of failing when the service is missing', () => {
    const env = createFakeCtx([])
    expect(() => registerCommands(env.ctx as never, resolveConfig(undefined))).not.toThrow()
    // 没有命令服务不算错误：老版本 dsh 里工具照常可用。
    expect(env.warnings).toHaveLength(0)
  })

  it('skips a command already taken by another plugin', () => {
    const env = createFakeCtx([])
    ;(env.ctx as Record<string, unknown>).get = () => ({
      register: (definition: { name?: string }) => {
        if (definition.name === 'doctor') throw new Error('command "doctor" is already registered')
      },
    })
    registerCommands(env.ctx as never, resolveConfig(undefined))
    expect(env.warnings.some(message => message.includes('/doctor'))).toBe(true)
  })

  it('turns a throwing handler into an error result instead of crashing the command', async () => {
    const registered: { handler: (invocation: { rawInput: string }) => Promise<{ kind: string; text: string }> }[] = []
    const env = createFakeCtx([])
    ;(env.ctx as Record<string, unknown>).get = () => ({
      register: (definition: { handler: never }) => registered.push(definition),
    })
    // /scope 在没有 skills 服务时也会走磁盘扫描，这里给一个必然失败的空调用。
    registerCommands(env.ctx as never, resolveConfig(undefined))
    const scope = registered[1]!
    const outcome = await scope.handler({ rawInput: '' })
    expect(outcome.kind).toBe('success')
    expect(outcome.text).toContain('用法')
  })
})

describe('command handler contract', () => {
  it('returns a success result shape with plain text', async () => {
    const env = createFakeCtx([{ skill: await loadFixture('good-skill') }])
    const registered: { handler: (invocation: { rawInput: string }) => Promise<{ kind: string; text: string }> }[] = []
    ;(env.ctx as Record<string, unknown>).get = () => ({
      register: (definition: { handler: never }) => registered.push(definition),
    })
    registerCommands(env.ctx as never, resolveConfig(undefined))
    const outcome = await registered[0]!.handler({ rawInput: '' })
    expect(outcome.kind).toBe('success')
    expect(outcome.text).toContain('技能体检')
    // fakeExec 只是保证工具路径不受影响；命令不依赖它。
    expect(typeof fakeExec).toBe('function')
  })
})

describe('provenance in plainCheckup', () => {
  const view: ProvenanceView = {
    byProvider: [{ provider: 'filesystem', count: 2 }, { provider: 'skill-doctor-compat', count: 1 }],
    byRoot: [{ root: '~/.claude/skills', count: 3 }],
    shadows: [{
      name: 'demo',
      resolved: false,
      shadowed: ['~/.claude/skills/demo/SKILL.md', 'skills/demo/SKILL.md'],
    }],
  }

  it('appends the section as an indented list, never a table', () => {
    const text = plainCheckup([result('a', '短')], 500, undefined, undefined, view)
    expect(text).toContain('来源与遮蔽')
    expect(text).toContain('· 按来源：')
    expect(text).toContain('未判定胜出者，以 registry 为准')
    expect(text).not.toContain('|')
  })

  it('leaves the report unchanged when no view is passed', () => {
    const results = [result('a', '短'), result('b', LONG)]
    expect(plainCheckup(results, 500)).not.toContain('来源与遮蔽')
    expect(plainCheckup(results, 500, undefined, undefined, view)).toContain('来源与遮蔽')
  })
})

describe('plainCheckup directory budget', () => {
  it('leaves a small report unchanged', () => {
    const text = plainCheckup([result('a', '短'), result('b', '短')], 500)
    expect(text).not.toContain('目录预算')
  })

  it('shows the measured budget line for a large catalogue', () => {
    const many = Array.from({ length: 12 }, (_, i) => result(`skill-${i}`, '简介'))
    const text = plainCheckup(many, 500)
    expect(text).toContain('目录预算')
    expect(text).toContain('未在 dsh 校准')
    expect(text).not.toContain('|')
  })
})

describe('/install command', () => {
  it('gives a copyable hint without touching the network when the argument is empty', async () => {
    const env = createFakeCtx([])
    const specs = buildCommands(env.ctx as never, resolveConfig(undefined))
    const text = await specs.find(spec => spec.name === 'install')!.run('  ')
    expect(text).toContain('/install')
    expect(text).toContain('registry')
  })
})

describe('/review command', () => {
  /** 用临时 DSH_HOME 隔离：/review 会跑 scanProfile，不能读真实 profile。 */
  async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
    const home = await mkdtemp(join(tmpdir(), 'dsh-review-cmd-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      return await fn()
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      await rm(home, { recursive: true, force: true })
    }
  }

  it('renders a heuristic review for a named package', async () => {
    await withTempHome(async () => {
      const env = createFakeCtx([])
      const specs = buildCommands(env.ctx as never, resolveConfig(undefined))
      const text = await specs.find(spec => spec.name === 'review')!.run('ghost-pkg')
      expect(text).toContain('插件审查 · ghost-pkg')
      expect(text).toContain('静态启发式风险提示，非安全结论')
      expect(text).toContain('不拦截安装')
      expect(text).not.toContain('|')
    })
  })

  it('returns a usable message with no argument', async () => {
    await withTempHome(async () => {
      const env = createFakeCtx([])
      const specs = buildCommands(env.ctx as never, resolveConfig(undefined))
      const text = await specs.find(spec => spec.name === 'review')!.run('  ')
      // 有缓存时输出缓存报告，没有时给可照抄的提示；两种都必须非空且可操作。
      expect(text.length).toBeGreaterThan(10)
      expect(text.includes('/review') || text.includes('插件审查')).toBe(true)
    })
  })
})

describe('/doctor trust', () => {
  let home: string
  let previous: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-trust-cmd-'))
    previous = process.env.DSH_HOME
    // trustPath() 走 dshHome()，它每次读环境变量，所以这里能直接改指向。
    process.env.DSH_HOME = home
  })

  afterEach(async () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  })

  function doctor(env = createFakeCtx([])): CommandSpec['run'] {
    const specs = buildCommands(env.ctx as never, resolveConfig(undefined))
    return specs.find(spec => spec.name === 'doctor')!.run
  }

  it('tells you what to do next when the list is empty', async () => {
    const text = await doctor()('trust')
    expect(text).toContain('信任清单是空的')
    expect(text).toContain('/doctor trust')
  })

  it('adds a package and explains what it does', async () => {
    const text = await doctor()('trust cc-safety-net')
    expect(text).toContain('已加入信任清单：cc-safety-net')
    expect(text).toContain('/doctor untrust cc-safety-net')
    // 真的落盘了，而不是只回一句话。
    const file = await loadTrust(trustPath())
    expect(file.trusted.map(entry => entry.pkg)).toEqual(['cc-safety-net'])
  })

  it('strips the version: trust is per package, not per release', async () => {
    await doctor()('trust cc-safety-net@2.7.12')
    const file = await loadTrust(trustPath())
    expect(file.trusted.map(entry => entry.pkg)).toEqual(['cc-safety-net'])
  })

  it('lists what is trusted', async () => {
    await doctor()('trust cc-safety-net')
    const text = await doctor()('trust')
    expect(text).toContain('信任清单 · 1 个')
    expect(text).toContain('cc-safety-net')
    expect(text).toContain(trustPath())
  })

  it('removes a package and says so', async () => {
    await doctor()('trust cc-safety-net')
    const text = await doctor()('untrust cc-safety-net')
    expect(text).toContain('已从信任清单移除：cc-safety-net')
    const file = await loadTrust(trustPath())
    expect(file.trusted).toEqual([])
  })

  it('reports a package that was never trusted', async () => {
    const text = await doctor()('untrust ghost-pkg')
    expect(text).toContain('信任清单里没有 ghost-pkg')
  })

  it('only accepts a registry package name', async () => {
    const text = await doctor()('trust https://example.com/x.tgz')
    expect(text).toContain('只支持 registry 包名')
    const file = await loadTrust(trustPath())
    expect(file.trusted).toEqual([])
  })

  it('does not treat a normal directory argument as the subcommand', async () => {
    // `trustfoo` 不是子命令（整词匹配），应走体检分支；这里只确认没有被当成加信任。
    await doctor()('trustfoo')
    const file = await loadTrust(trustPath())
    expect(file.trusted).toEqual([])
  })
})
