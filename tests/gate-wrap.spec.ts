/**
 * 插件页安装门禁：包装 plugin-manager 服务上的 installBundle。
 *
 * 这里验证的是「包装本身」的策略，不联网、不真的安装：
 * - 命中 GT 规则时拒绝，且**不调用原方法**；
 * - 未完成审查或包装自身出错时放行（fail open），并留 warn；
 * - 卸载时能把方法还原，不重复包装。
 *
 * 覆盖范围的实测依据：在真实 dsh 里包装 setBundleEnabled 后，插件页开关
 * 组合包会经过包装（remote 分发按实例属性取方法），installBundle 同类同机制。
 */
import { describe, expect, it, vi } from 'vitest'
import { registerInstallGate, type GateResult } from '../src/plugins/gate'

function gateResult(decision: 'pass' | 'block' | 'error'): GateResult {
  const base: GateResult = {
    spec: 'demo@1.0.0', name: 'demo', version: '1.0.0', installSpec: 'demo@1.0.0',
    tarball: 'https://registry.example/demo-1.0.0.tgz',
    decision, findings: [],
    review: { pkg: 'demo', dir: '<tarball>', hints: [], focus: [], notes: [] },
    notes: [],
  }
  if (decision === 'block') {
    return {
      ...base,
      findings: [{
        id: 'GT001', severity: 'error', title: '安装期脚本会执行远程内容',
        detail: 'postinstall 把下载内容管道进 shell。', where: 'package.json',
      }],
    }
  }
  if (decision === 'error') return { ...base, problem: 'download-failed：ETIMEDOUT' }
  return base
}

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

/** 造一个可替换的假服务；calls 记录原方法真实被调用的次数。 */
function fakeManager() {
  const calls: Array<[string, unknown]> = []
  const manager: Record<string, unknown> = {
    installBundle: async (spec: string, options?: unknown) => {
      calls.push([spec, options])
      return { changed: true, application: 'applied', stage: 'install', target: spec }
    },
  }
  return { manager, calls }
}

describe('registerInstallGate', () => {
  it('does nothing when installGate is off', () => {
    const { manager } = fakeManager()
    const original = manager.installBundle
    const { ctx, infos } = fakeCtx(manager)
    registerInstallGate(ctx as never, 'off')
    expect(manager.installBundle).toBe(original)
    expect(infos.some(message => message.includes('disabled by config'))).toBe(true)
  })

  it('degrades quietly when the service is missing', () => {
    const { ctx, infos } = fakeCtx(undefined)
    expect(() => registerInstallGate(ctx as never, 'block')).not.toThrow()
    expect(infos.some(message => message.includes('install gate unavailable'))).toBe(true)
  })

  it('refuses the install without calling the original method when a rule hits', async () => {
    const { manager, calls } = fakeManager()
    const { ctx } = fakeCtx(manager)
    registerInstallGate(ctx as never, 'block', async () => gateResult('block'))

    const result = await (manager.installBundle as (spec: string) => Promise<Record<string, unknown>>)('evil@1.0.0')
    expect(calls).toHaveLength(0)
    expect(result.changed).toBe(false)
    expect(result.application).toBe('failed')
    const error = result.error as { code: string; diagnostic: string }
    // ChangeResult 的 code 是固定枚举，只能借用 operation-error，原因写进 diagnostic。
    expect(error.code).toBe('operation-error')
    expect(error.diagnostic).toContain('GT001')
    expect(error.diagnostic).toContain('installGate: off')
  })

  it('passes through when the gate passes', async () => {
    const { manager, calls } = fakeManager()
    const { ctx } = fakeCtx(manager)
    registerInstallGate(ctx as never, 'block', async () => gateResult('pass'))

    const result = await (manager.installBundle as (spec: string) => Promise<Record<string, unknown>>)('ok@1.0.0')
    expect(calls).toHaveLength(1)
    expect(result.changed).toBe(true)
  })

  it('fails open when the inspection could not finish, and says so', async () => {
    const { manager, calls } = fakeManager()
    const { ctx, warns } = fakeCtx(manager)
    registerInstallGate(ctx as never, 'block', async () => gateResult('error'))

    await (manager.installBundle as (spec: string) => Promise<unknown>)('x@1.0.0')
    // 插件页是点一下就走的路：查不了不该让人什么都装不上。
    expect(calls).toHaveLength(1)
    expect(warns.some(message => message.includes('without inspection'))).toBe(true)
  })

  it('fails open when the inspection itself throws', async () => {
    const { manager, calls } = fakeManager()
    const { ctx, warns } = fakeCtx(manager)
    registerInstallGate(ctx as never, 'block', async () => {
      throw new Error('boom')
    })

    await (manager.installBundle as (spec: string) => Promise<unknown>)('x@1.0.0')
    expect(calls).toHaveLength(1)
    expect(warns.some(message => message.includes('skipped'))).toBe(true)
  })

  it('restores the original method when the effect is disposed', async () => {
    const { manager, calls } = fakeManager()
    const original = manager.installBundle
    const { ctx, dispose } = fakeCtx(manager)
    registerInstallGate(ctx as never, 'block', async () => gateResult('block'))
    expect(manager.installBundle).not.toBe(original)

    dispose()
    expect(manager.installBundle).toBe(original)
    // 还原之后调用能正常走到原方法。
    await (manager.installBundle as (spec: string) => Promise<unknown>)('ok@1.0.0')
    expect(calls).toHaveLength(1)
  })

  it('does not wrap twice when registered again', () => {
    const { manager } = fakeManager()
    const { ctx, infos } = fakeCtx(manager)
    registerInstallGate(ctx as never, 'block', async () => gateResult('pass'))
    const wrappedOnce = manager.installBundle
    registerInstallGate(ctx as never, 'block', async () => gateResult('pass'))
    expect(manager.installBundle).toBe(wrappedOnce)
    expect(infos.some(message => message.includes('already active'))).toBe(true)
  })

  it('keeps the wrapper alive when ctx.effect is unavailable', async () => {
    const { manager, calls } = fakeManager()
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn() },
      get: () => manager,
    }
    expect(() => registerInstallGate(ctx as never, 'block', async () => gateResult('block'))).not.toThrow()
    const result = await (manager.installBundle as (spec: string) => Promise<Record<string, unknown>>)('evil@1.0.0')
    expect(calls).toHaveLength(0)
    expect(result.changed).toBe(false)
  })
})
