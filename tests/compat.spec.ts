/**
 * 外部技能来源挂载（B 方案最小移植 + 双组件行）的回归测试。
 *
 * 为什么测试要用临时目录：resolveRoots() 默认指向真实的 ~/.claude/skills
 * 等目录，直接跑会让用例依赖开发者机器上的技能数量。这里统一用 extraDirs
 * 把路径指到 mkdtemp 建出来的目录，三家来源全部显式关掉。
 *
 * 覆盖五层：两行结构的独立开关 → 配置严格校验 → frontmatter 映射 →
 * 目录扫描 → provider.list/get 全链路。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import * as compatEntry from '../src/compat-entry.js'
import * as doctorEntry from '../src/index.js'
import { resolveCompatConfig } from '../src/compat/config.js'
import {
  mapForeignSkill,
  slugifySkillName,
  splitFrontmatter,
  synthesizeDescription,
} from '../src/compat/frontmatter.js'
import { CompatSkillProvider } from '../src/compat/provider.js'
import { resolveRoots } from '../src/compat/roots.js'

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'doctor-compat-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  const pending = tempDirs.splice(0)
  await Promise.all(pending.map((dir) => rm(dir, { recursive: true, force: true })))
})

/**
 * 最小 Cordis context mock：只提供两个入口实际会碰到的服务。
 * provider 工厂不需要 control（B 方案删了 watch / invalidate）。
 */
function makeCtx() {
  const providers: unknown[] = []
  const registeredTools: unknown[] = []
  const warns: string[] = []
  return {
    providers,
    registeredTools,
    warns,
    logger: {
      warn: (message: string) => { warns.push(message) },
      info: () => {},
      error: () => {},
    },
    tools: {
      get: () => undefined,
      register: (tool: unknown) => { registeredTools.push(tool) },
    },
    skills: {
      registerProvider: (factory: () => unknown) => { providers.push(factory()) },
      snapshot: async () => ({ skills: [] }),
      get: async () => undefined,
    },
    workingDirectory: { ensure: async () => process.cwd() },
  }
}

/** mock 不是真正的 Context，测试里做一次显式断言绕过结构类型检查。 */
function asCtx(ctx: ReturnType<typeof makeCtx>) {
  return ctx as unknown as Parameters<typeof compatEntry.apply>[0]
}

/** 关掉三家默认来源，只保留 extraDirs，保证测试不碰真实 home 目录。 */
function configFor(root: string) {
  return resolveCompatConfig({
    sources: { claude: false, codex: false, zcode: false },
    extraDirs: [{ path: root, label: 'test' }],
  })
}

describe('两个组件行：独立加载、互不牵连', () => {
  it('主入口只注册四个体检工具，完全不注册 provider', () => {
    const ctx = makeCtx()
    doctorEntry.apply(asCtx(ctx), {})
    expect(ctx.registeredTools).toHaveLength(4)
    expect(ctx.providers).toHaveLength(0)
  })

  it('compat 入口注册一个独立 provider，默认名不与 compat-plus 撞车', () => {
    const ctx = makeCtx()
    compatEntry.apply(asCtx(ctx), { sources: { claude: true } })
    expect(ctx.providers).toHaveLength(1)
    expect((ctx.providers[0] as { name: string }).name).toBe('skill-doctor-compat')
    expect(compatEntry.name).toBe('skill-doctor-compat')
    expect(compatEntry.inject).toEqual(['skills'])
  })

  it('全部来源关闭时不注册 provider，只 warn 降级', () => {
    const ctx = makeCtx()
    compatEntry.apply(asCtx(ctx), { sources: { claude: false, codex: false, zcode: false } })
    expect(ctx.providers).toHaveLength(0)
    expect(ctx.warns.join(' ')).toContain('disabled')
  })

  it('配置非法时 warn + return，不抛错也不阻断其它行', () => {
    const ctx = makeCtx()
    expect(() => compatEntry.apply(asCtx(ctx), { nope: 1 } as never)).not.toThrow()
    expect(ctx.providers).toHaveLength(0)
    expect(ctx.warns.join(' ')).toContain('invalid config')
  })
})

describe('compat 配置严格校验', () => {
  it('缺省配置解析出三家默认开启与独立 providerName', () => {
    const resolved = resolveCompatConfig({})
    expect(resolved.providerName).toBe('skill-doctor-compat')
    expect(resolved.sources.claude.enabled).toBe(true)
    expect(resolved.sources.codex.enabled).toBe(true)
    expect(resolved.anySourceEnabled).toBe(true)
  })

  it('未知键 fail-fast', () => {
    expect(() => resolveCompatConfig({ nope: 1 } as never)).toThrow(/unknown plugin config key/)
  })

  it('B 方案已移除 watch 配置，写进来应报错', () => {
    expect(() => resolveCompatConfig({ watch: true } as never)).toThrow(/unknown plugin config key/)
  })

  it('providerName 保留字 runtime 被拒绝', () => {
    expect(() => resolveCompatConfig({ providerName: 'runtime' })).toThrow(/reserved/)
  })
})

describe('frontmatter 映射', () => {
  it('解析块标量 description，并把外来名 slug 化成 dsh kebab-case', () => {
    const parsed = splitFrontmatter(
      ['---', 'name: My_Skill', 'description: >-', '  first line', '  second line', 'allowed-tools: Bash(*)', '---', '', '# Body'].join('\n'),
    )
    expect(parsed).toBeDefined()
    const mapped = mapForeignSkill({
      filePath: '/tmp/My_Skill/SKILL.md',
      directory: '/tmp/My_Skill',
      entryName: 'My_Skill',
      parsed: parsed!,
      slugify: true,
      synthesize: true,
    })
    expect(mapped.ok).toBe(true)
    if (!mapped.ok) return
    expect(mapped.skill.name).toBe('my-skill')
    expect(mapped.skill.description).toBe('first line second line')
    expect(mapped.skill.metadata['allowed-tools']).toBe('Bash(*)')
  })

  it('Claude 允许缺省 description，开启 synthesize 时取正文首个非空行', () => {
    const parsed = splitFrontmatter('---\nname: demo\n---\n\n# 标题\n\n真正的第一句说明。')
    expect(parsed).toBeDefined()
    const mapped = mapForeignSkill({
      filePath: '/tmp/demo/SKILL.md',
      directory: '/tmp/demo',
      entryName: 'demo',
      parsed: parsed!,
      slugify: true,
      synthesize: true,
    })
    expect(mapped.ok).toBe(true)
    if (!mapped.ok) return
    expect(mapped.skill.description).toBe('标题')
  })

  it('slugify 与 synthesize 被关掉时明确拒绝，而不是悄悄改数据', () => {
    const parsed = splitFrontmatter('---\nname: Bad_Name\n---\n\nbody')
    expect(parsed).toBeDefined()
    const mapped = mapForeignSkill({
      filePath: '/tmp/Bad_Name/SKILL.md',
      directory: '/tmp/Bad_Name',
      entryName: 'Bad_Name',
      parsed: parsed!,
      slugify: false,
      synthesize: false,
    })
    expect(mapped.ok).toBe(false)
  })

  it('辅助函数行为稳定', () => {
    expect(slugifySkillName('1start_mathmodel')).toBe('1start-mathmodel')
    expect(synthesizeDescription('  \n # 标题 \n  说明文字')).toBe('标题')
  })
})

describe('roots 展开', () => {
  it('三家关闭时只留下 extraDirs，且按 rank 升序', async () => {
    const root = await tempDir()
    const roots = await resolveRoots(configFor(root), undefined)
    expect(roots).toHaveLength(1)
    expect(roots[0]?.path).toBe(root)
    expect(roots[0]?.source).toBe('test')
    expect(roots[0]?.rank).toBe(300)
  })
})

describe('provider 端到端', () => {
  it('list() 发现技能、get() 读回正文，locator 能原样往返', async () => {
    const root = await tempDir()
    await mkdir(join(root, 'My_Skill'), { recursive: true })
    await writeFile(
      join(root, 'My_Skill', 'SKILL.md'),
      '---\nname: My_Skill\ndescription: 这是一个测试技能\n---\n\n正文内容 A。',
      'utf8',
    )

    const provider = new CompatSkillProvider(configFor(root), { warn: () => {} })
    const candidates = await provider.list({})
    expect(candidates).toHaveLength(1)
    const candidate = candidates[0]!
    expect(candidate.name).toBe('my-skill')
    expect(candidate.source).toBe('test')
    expect(candidate.provider).toBe('skill-doctor-compat')

    const definition = await provider.get(candidate, {})
    expect(definition?.content).toBe('正文内容 A。')
    expect(definition?.name).toBe('my-skill')
  })

  it('目录不存在时静默跳过，不抛错也不产生候选', async () => {
    const root = await tempDir()
    const config = resolveCompatConfig({
      sources: { claude: false, codex: false, zcode: false },
      extraDirs: [{ path: join(root, 'not-created-yet') }],
    })
    const provider = new CompatSkillProvider(config, { warn: () => {} })
    expect(await provider.list({})).toEqual([])
  })

  it('dispose() 之后不再返回候选（保留的行为开关）', async () => {
    const root = await tempDir()
    await mkdir(join(root, 'demo'), { recursive: true })
    await writeFile(join(root, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n\nbody', 'utf8')
    const provider = new CompatSkillProvider(configFor(root), { warn: () => {} })
    expect(await provider.list({})).toHaveLength(1)
    provider.dispose()
    expect(await provider.list({})).toEqual([])
  })
})
