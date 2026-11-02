/**
 * 客户端 bundle 的契约测试。
 *
 * 面板的 UI 只能在真机上看，但“宿主能不能把这个 bundle 装起来”必须能在 CI 里验：
 * 外壳格式、只 require 平台模块表里的包、导出 apply/inject 而不是 default、
 * apply 之后真的往槽位里注册了东西。这几条任何一条错了，桌面端就是白屏或静默不显示。
 */
import { runInNewContext } from 'node:vm'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildClientCode, EXTERNAL } from '../scripts/build-client.mjs'

/** 宿主模块表里有的包；bundle 只能 require 这些。 */
const PLATFORM_MODULES = new Set(EXTERNAL)

let bundle: string
const required = new Set<string>()

beforeAll(async () => {
  bundle = await buildClientCode()
}, 60_000)

/** 最小 React 替身：只保证命名导出存在，组件在测试里不会被渲染。 */
function fakeReact(): Record<string, unknown> {
  const noop = (): undefined => undefined
  return {
    useEffect: noop,
    useMemo: (fn: () => unknown) => fn(),
    useState: (initial: unknown) => [initial, noop],
    useRef: (value: unknown) => ({ current: value }),
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    createElement: noop,
  }
}

/** 把 bundle 装进一个假宿主，返回它导出的模块。 */
function loadBundle(): Record<string, unknown> {
  let loaded: { id?: string; factory?: (req: (name: string) => unknown) => unknown } | undefined
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (definition: { id?: string; factory?: (req: (name: string) => unknown) => unknown }) => {
          loaded = definition
        },
      },
    },
    document: {
      createElement: () => ({ style: {}, id: '' }),
      body: { appendChild: () => undefined },
      getElementById: () => null,
    },
    performance: { now: () => 0 },
    console,
  }
  runInNewContext(bundle, sandbox)

  expect(loaded, 'bundle 必须调用 window.__ModuleLoader__.load').toBeDefined()
  expect(loaded!.id).toBe('dsh-skill-doctor')
  expect(typeof loaded!.factory).toBe('function')

  const require = (name: string): unknown => {
    required.add(name)
    if (!PLATFORM_MODULES.has(name)) throw new Error(`bundle 请求了不在平台表里的模块：${name}`)
    if (name === 'react') return fakeReact()
    if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: null }
    return { createRoot: () => ({ render: () => undefined }) }
  }

  return loaded!.factory!(require) as Record<string, unknown>
}

describe('client bundle', () => {
  it('wraps itself in the ModuleLoader shell with the package id', () => {
    expect(bundle.startsWith('window.__ModuleLoader__.load({ id: "dsh-skill-doctor"')).toBe(true)
    expect(bundle.trimEnd().endsWith('return module.exports; } });')).toBe(true)
  })

  it('exports apply and inject, and no default', () => {
    const exported = loadBundle()
    expect(typeof exported.apply).toBe('function')
    // 只有 slots。曾加过 conversation / sessions（想做蓝色命令 token），
    // 实测面板直接消失——cordis 里注入列表任一服务缺失就整体不 apply，
    // 而这些服务对第三方客户端插件不可见。这条断言是防回归的护栏：
    // 想再加名字，先用真实客户端确认服务确实会被提供。
    expect(exported.inject).toEqual(['slots'])
    // Loader 会 unwrapExports，出现 default 会把 inject 丢掉。
    expect('default' in exported).toBe(false)
  })

  it('only requires modules the host module table provides', () => {
    required.clear()
    loadBundle()
    expect(required.size).toBeGreaterThan(0)
    for (const name of required) expect(PLATFORM_MODULES.has(name), name).toBe(true)
  })

  it('registers the activity bar in the conversation input dock', () => {
    const exported = loadBundle()
    const injected: string[] = []
    const registered: { name?: string; id?: string }[] = []
    const ctx = {
      slots: {
        inject: (name: string, run: () => void) => {
          injected.push(name)
          // 宿主会等到对应槽位可用时才回调，这里立即执行以验证注册内容。
          run()
        },
        register: (options: { name?: string; id?: string }) => {
          registered.push(options)
        },
      },
    }

    ;(exported.apply as (context: unknown) => void)(ctx)

    expect(injected).toContain('conversation.input.dock')
    expect(registered).toHaveLength(1)
    expect(registered[0]!.name).toBe('conversation.input.dock')
    // 固定 id 才能让宿主去重，避免热更新时叠加两根条。
    expect(registered[0]!.id).toBe('skill-doctor-activity-bar')
  })
})
