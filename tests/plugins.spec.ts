import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderPluginJson, renderPluginMarkdown } from '../src/plugins/report'
import type { RuntimeSummary } from '../src/plugins/runtime'
import { parsePatchIds, scanProfile } from '../src/plugins/scan'

/** 每个用例一个临时 DSH_HOME，避免读真实 profile。 */
let home: string
let previous: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-plugin-home-'))
  previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
})

afterEach(async () => {
  if (previous === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previous
  await rm(home, { recursive: true, force: true })
})

/** 写一个 bundle 的 package.json 与 patch。 */
async function writeBundle(profileDir: string, name: string, patch: string | undefined, version = '1.0.0') {
  const dir = join(profileDir, 'node_modules', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name, version, dsh: { manifestVersion: 1, bundle: { patch: './cordis.patch.yml' } } }),
    'utf8',
  )
  if (patch !== undefined) await writeFile(join(dir, 'cordis.patch.yml'), patch, 'utf8')
}

/** 写 profile 的 package.json。 */
async function writeProfile(bundles: string[], dependencies: Record<string, string>) {
  const profileDir = join(home, 'profiles', 'demo')
  await mkdir(profileDir, { recursive: true })
  await writeFile(
    join(profileDir, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-demo', dependencies, dsh: { profile: { bundles } } }),
    'utf8',
  )
  return profileDir
}

describe('parsePatchIds', () => {
  it('separates inserted entries from patched entries', () => {
    const ids = parsePatchIds([
      '- insert:',
      '    - id: tool-a',
      '      name: pkg-a',
      '- id: llm-pi-ai',
      '  config: {}',
      '- id: skill-doctor',
      '  disabled: true',
    ].join('\n'))
    expect(ids.inserts).toEqual(['tool-a'])
    expect(ids.patches).toEqual(['llm-pi-ai', 'skill-doctor'])
  })

  it('returns empty lists for broken yaml instead of throwing', () => {
    expect(parsePatchIds('- insert: [unclosed')).toEqual({ inserts: [], patches: [] })
  })
})

describe('scanProfile', () => {
  it('reports duplicate bundles, id collisions, and missing packages', async () => {
    const profileDir = await writeProfile(
      // a 出现两次；ghost 在 bundles 里但没有包；@deepseek-ai/dsh-base 是自带
      ['a', 'b', 'a', 'ghost', '@deepseek-ai/dsh-base', 'c'],
      { a: '1.0.0', b: '1.0.0', c: '1.0.0', d: '1.0.0' },
    )
    await writeBundle(profileDir, 'a', '- insert:\n    - id: shared-entry\n      name: a\n')
    await writeBundle(profileDir, 'b', '- insert:\n    - id: shared-entry\n      name: b\n- id: core-row\n  config: {}\n')
    await writeBundle(profileDir, 'c', '- id: core-row\n  config: {}\n')

    const report = await scanProfile('demo')
    const rules = report.conflicts.map(item => item.rule)

    expect(rules).toContain('PL001')
    expect(rules).toContain('PL002')
    expect(rules).toContain('PL003')
    expect(rules).toContain('PL004')

    // 自带包不该被当成“包缺失”
    expect(report.conflicts.some(item => item.involved.includes('@deepseek-ai/dsh-base'))).toBe(false)

    const duplicate = report.conflicts.find(item => item.rule === 'PL002')
    expect(duplicate?.involved.sort()).toEqual(['a', 'b'])

    // d 装了但没进 bundles
    const notEnabled = report.conflicts.filter(item => item.rule === 'PL004' && item.involved.includes('d'))
    expect(notEnabled).toHaveLength(1)
    expect(notEnabled[0]?.severity).toBe('info')

    // ghost 进了 bundles 但没包
    const missing = report.conflicts.filter(item => item.rule === 'PL004' && item.involved.includes('ghost'))
    expect(missing[0]?.severity).toBe('error')
  })

  it('says so when two plugins patch the same core row', async () => {
    const profileDir = await writeProfile(['x', 'y'], { x: '1.0.0', y: '1.0.0' })
    await writeBundle(profileDir, 'x', '- id: agent-default-model\n  config: {}\n')
    await writeBundle(profileDir, 'y', '- id: agent-default-model\n  config: {}\n')

    const report = await scanProfile('demo')
    const conflict = report.conflicts.find(item => item.rule === 'PL003')
    expect(conflict?.involved.sort()).toEqual(['x', 'y'])
    expect(conflict?.detail).toContain('agent-default-model')
  })

  it('keeps quiet for a clean profile', async () => {
    const profileDir = await writeProfile(['x'], { x: '1.0.0' })
    await writeBundle(profileDir, 'x', '- insert:\n    - id: only-me\n      name: x\n')
    const report = await scanProfile('demo')
    expect(report.conflicts).toEqual([])
  })

  it('explains a missing profile instead of throwing', async () => {
    const report = await scanProfile('nope')
    expect(report.bundles).toEqual([])
    expect(report.notes[0]).toMatch(/读不到/)
  })
})

describe('renderPluginMarkdown', () => {
  it('says the runtime was not checked when the CLI renders it', async () => {
    const profileDir = await writeProfile(['a'], { a: '1.0.0' })
    await writeBundle(profileDir, 'a', '- insert://n    - id: only-me\n      name: a\n')
    const markdown = renderPluginMarkdown(await scanProfile('demo'))

    expect(markdown).toContain('## 运行时状态')
    expect(markdown).toContain('命令行模式')
    // 核心要求：不能让人把“没查”读成“没问题”。
    expect(markdown).toContain('不等于')
  })

  it('names failed plugins and puts them first in the verdict', async () => {
    const profileDir = await writeProfile(['a'], { a: '1.0.0' })
    await writeBundle(profileDir, 'a', '- insert://n    - id: only-me\n      name: a\n')
    const runtime: RuntimeSummary = {
      status: 'ok',
      enabled: 1,
      failed: ['dsh-broken'],
      phases: { failed: 1 },
      matched: 1,
      declared: 1,
      missingOwnTools: [],
      toolCount: 12,
    }
    const markdown = renderPluginMarkdown(await scanProfile('demo'), runtime)

    expect(markdown).toContain('`dsh-broken`')
    expect(markdown).toContain('启动了但失败')
    expect(markdown).toMatch(/\*\*结论：有 1 个插件启动了但失败/)
  })

  it('qualifies a clean verdict when the runtime was unavailable', async () => {
    const profileDir = await writeProfile(['a'], { a: '1.0.0' })
    await writeBundle(profileDir, 'a', '- insert://n    - id: only-me\n      name: a\n')
    const runtime: RuntimeSummary = {
      status: 'unavailable',
      note: '当前 dsh 没有暴露 pluginInventory 服务',
      enabled: 0,
      failed: [],
      phases: {},
      matched: 0,
      declared: 1,
      missingOwnTools: [],
      toolCount: 12,
    }
    const markdown = renderPluginMarkdown(await scanProfile('demo'), runtime)

    expect(markdown).toContain('运行时状态这次没查到')
    expect(markdown).toContain('没有暴露 pluginInventory')
  })

  it('adds a prescription to every conflict in JSON', async () => {
    const profileDir = await writeProfile(['a', 'a'], { a: '1.0.0' })
    await writeBundle(profileDir, 'a', '- insert://n    - id: only-me\n      name: a\n')
    const parsed = JSON.parse(renderPluginJson(await scanProfile('demo'))) as {
      conflicts: { rule: string; prescription: { kind: string } }[]
    }

    expect(parsed.conflicts.length).toBeGreaterThan(0)
    for (const conflict of parsed.conflicts) {
      expect(conflict.prescription.kind).toMatch(/^(autofix|command|manual)$/)
    }
  })
})
