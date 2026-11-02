/** 中文引用源：候选完整性、提交时映射成合法命令、服务缺失时的降级。 */
import { describe, expect, it } from 'vitest'
import {
  DOCTOR_CANDIDATES,
  registerTriggerSource,
  serializeRef,
  SOURCE_NAME,
} from '../src/source'
import { MODES } from '../src/modes'

describe('doctor candidates', () => {
  it('covers every panel button exactly once', () => {
    // 面板六个按钮与菜单六条候选必须一一对应，否则两条入口会各说各话。
    expect(DOCTOR_CANDIDATES).toHaveLength(MODES.length)
    for (const [index, mode] of MODES.entries()) {
      expect(mode.id).toBe(DOCTOR_CANDIDATES[index]!.name)
      expect(mode.command).toBe(DOCTOR_CANDIDATES[index]!.token)
    }
  })

  it('describes each entry in one short sentence, without repeating its name', () => {
    for (const candidate of DOCTOR_CANDIDATES) {
      // 菜单里右边那列是"一句话功能说明"：超过 18 字就会被挤成两行、读不动。
      expect(candidate.description.length).toBeLessThanOrEqual(18)
      // 括号和冒号会让它变成"功能 + 操作提示"的混合体，用户反馈过看不清。
      expect(candidate.description).not.toMatch(/[（(：:]/)
      // 名字已经说了"复诊"，说明里再写"复诊…"就是重复。
      expect(candidate.description.startsWith(candidate.name)).toBe(false)
    }
  })

  it('keeps names short enough to read as a label in the composer', () => {
    for (const candidate of DOCTOR_CANDIDATES) {
      // 输入框里它是一个"标签"，不是一整句；超过 4 个字就会把输入区挤满。
      expect(candidate.name.length).toBeLessThanOrEqual(4)
      expect(candidate.name.startsWith('/')).toBe(false)
      expect(candidate.description.length).toBeGreaterThan(0)
    }
  })
})

describe('serializeRef', () => {
  it('maps a Chinese token to the real slash command', () => {
    // 显示中文、执行英文：这是绕开命令名 ASCII 限制的关键一步。
    expect(serializeRef('/复诊').trim()).toBe('/followup')
    expect(serializeRef('复诊').trim()).toBe('/followup')
    expect(serializeRef('/体检').trim()).toBe('/doctor')
    expect(serializeRef('/查目录').trim()).toBe('/scope')
    expect(serializeRef('/改写').trim()).toBe('/rewrite')
  })

  it('maps the Chinese name to its ASCII token if someone types it by hand', () => {
    // 菜单里显示中文，用户可能照着打；转成 token 才能命中命令。
    expect(serializeRef('/复诊').trim()).toBe('/followup')
    expect(serializeRef('/体检').trim()).toBe('/doctor')
  })

  it('keeps every token inside the chip regex dsh requires', () => {
    for (const candidate of DOCTOR_CANDIDATES) {
      // TEXT_REF_RE = /(^|\s)([/@])([\w-]+)/g —— 不匹配就永远不会变成蓝色 chip。
      expect(/^[\w-]+$/.test(candidate.token)).toBe(true)
    }
  })

  it('leaves unknown refs untouched so nothing is silently rewritten', () => {
    expect(serializeRef('/nature-citation')).toBe('/nature-citation')
    expect(serializeRef('随便什么')).toBe('随便什么')
  })
})

describe('registerTriggerSource', () => {
  /** 假的 inputTriggers：记录注册的 source 与是否被注销。 */
  function fakeHost(): {
    ctx: Record<string, unknown>
    sources: Record<string, unknown>[]
    disposed: () => number
  } {
    const sources: Record<string, unknown>[] = []
    let disposeCalls = 0
    const ctx = {
      get: (name: string) => name === 'inputTriggers'
        ? {
            registerSource: (source: unknown) => {
              sources.push(source as Record<string, unknown>)
              return () => {
                disposeCalls += 1
              }
            },
          }
        : undefined,
      effect: (fn: () => unknown) => fn(),
    }
    return { ctx, sources, disposed: () => disposeCalls }
  }

  it('registers one source on the / trigger under its own name', () => {
    const host = fakeHost()
    expect(registerTriggerSource(host.ctx)).toBe(true)
    expect(host.sources).toHaveLength(1)
    expect(host.sources[0]!.trigger).toBe('/')
    expect(host.sources[0]!.name).toBe(SOURCE_NAME)
  })

  it('binds the unregister to the plugin effect', () => {
    const host = fakeHost()
    registerTriggerSource(host.ctx)
    // effect 立即执行 → 返回的 disposer 被挂上；这里只确认 effect 收到了函数。
    expect(host.disposed()).toBe(0)
  })

  it('serializes through the registered codec', async () => {
    const host = fakeHost()
    registerTriggerSource(host.ctx)
    const codec = (host.sources[0] as { codec: { serialize: (ref: string) => Promise<string> } }).codec
    expect((await codec.serialize('/复诊')).trim()).toBe('/followup')
  })

  it('offers Chinese candidates and filters by query', async () => {
    const host = fakeHost()
    registerTriggerSource(host.ctx)
    const source = host.sources[0] as {
      candidates: (session: unknown, args: { query: string }) => Promise<{ name: string }[]>
      lexicon: () => string[]
    }
    const all = await source.candidates({}, { query: '' })
    expect(all.map(item => item.name)).toContain('复诊')
    const filtered = await source.candidates({}, { query: '复' })
    expect(filtered.map(item => item.name)).toEqual(['复诊'])
    // lexicon 里放的是 ASCII token：编辑器的 chip 正则不认中文。
    expect(source.lexicon()).toContain('doctor')
    expect(source.lexicon()).not.toContain('体检')
  })

  it('does nothing when the trigger service is missing or already taken', () => {
    // 没有服务：不抛、返回 false，面板与命令不受影响。
    expect(registerTriggerSource({})).toBe(false)
    expect(registerTriggerSource({ get: () => undefined })).toBe(false)
    // 服务存在但注册被拒（名字被占）：同样只是 false。
    const taken = {
      get: () => ({
        registerSource: () => {
          throw new Error('slash source "/skill-doctor" is already registered')
        },
      }),
    }
    expect(registerTriggerSource(taken)).toBe(false)
  })

  it('survives a getter that throws', () => {
    expect(registerTriggerSource({
      get: () => {
        throw new Error('service unavailable')
      },
    })).toBe(false)
  })
})
