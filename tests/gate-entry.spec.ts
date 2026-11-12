/**
 * 独立组件行 `skill-doctor-gate` 的行为。
 *
 * 这一行存在的意义是「可以单独关掉」：关掉后 fiber 卸载，effect 里的还原函数
 * 把 installBundle 换回去。所以除了「装上会包装」，这里也钉住「包装不上时
 * 绝不抛错」——一行组件挂掉不该连累另外两行。
 */
import { describe, expect, it } from 'vitest'
import { apply, name } from '../src/gate-entry'

/** 造一个只带 logger / get / effect 的最小 ctx。 */
function fakeCtx(manager?: unknown) {
  const infos: string[] = []
  const warns: string[] = []
  let disposer: (() => void) | undefined
  const ctx = {
    logger: {
      info: (message: string) => infos.push(message),
      warn: (message: string) => warns.push(message),
    },
    get: () => manager,
    effect: (callback: () => () => void) => { disposer = callback() },
  }
  return { ctx, infos, warns, dispose: () => disposer?.() }
}

describe('gate entry row', () => {
  it('keeps the patch id stable so the component row stays toggleable', () => {
    // patch 里的 id 与这里的 name 必须一致，否则插件页那一行的开关会作用在空处。
    expect(name).toBe('skill-doctor-gate')
  })

  it('wraps installBundle when the service is present', () => {
    const manager: Record<string, unknown> = { installBundle: async () => ({ changed: true }) }
    const original = manager.installBundle
    const { ctx } = fakeCtx(manager)
    apply(ctx as never)
    expect(manager.installBundle).not.toBe(original)
    expect(manager.__skillDoctorInstallGate).toBe(true)
  })

  it('restores the original method when the row is unloaded', () => {
    const manager: Record<string, unknown> = { installBundle: async () => ({ changed: true }) }
    const original = manager.installBundle
    const { ctx, dispose } = fakeCtx(manager)
    apply(ctx as never)
    expect(manager.installBundle).not.toBe(original)
    // 关掉这一行 = fiber 卸载 = effect 执行，包装必须当场解除。
    dispose()
    expect(manager.installBundle).toBe(original)
  })

  it('degrades with a log line when the service is missing', () => {
    const { ctx, infos } = fakeCtx(undefined)
    expect(() => apply(ctx as never)).not.toThrow()
    expect(infos.some(message => message.includes('install gate unavailable'))).toBe(true)
  })

  it('never throws even when probing the service throws', () => {
    const ctx = {
      logger: { info: () => {}, warn: () => {} },
      get: () => { throw new Error('boom') },
      effect: () => {},
    }
    expect(() => apply(ctx as never)).not.toThrow()
  })
})
