/**
 * gate 组件行的**集成**测试：验证加载时序，而不是声明字符串。
 *
 * 为什么必须有这一层：
 * 0.18.0 的门禁在真实环境里从未生效——代码、patch、组件行全对，只因为
 * 少了 `inject = ['pluginManager']`。`apply` 抢在 plugin-manager 注册之前
 * 跑完，`ctx.get` 拿到 undefined，门禁静默降级。而当时所有测试都是绿的，
 * 因为它们只断言「inject 数组里有没有那个字符串」，属于文字检查。
 *
 * 这里用真实的 cordis 容器复现启动时序：**先加载插件，后提供服务**。
 * 有 inject 时 cordis 会等服务就绪再 apply（包装建立）；没有 inject 时
 * apply 早已跑完（包装永不建立）。删掉 `export const inject` 这条测试会红。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply, inject, name } from '../src/gate-entry'

/** 造一个最小的 pluginManager：只提供 `installBundle`。 */
function fakeManager() {
  return {
    installBundle: async (_spec: string, _options?: unknown) => ({
      changed: true,
      application: 'applied',
      stage: 'install',
      target: _spec,
    }),
  }
}

/** 等 cordis 的 fiber 刷新。服务提供/卸载是异步传播的。 */
async function settle(ms = 120): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('gate row: load order', () => {
  it('installs the wrapper only after pluginManager is provided', async () => {
    const ctx = new Context()
    const manager = fakeManager()
    const original = manager.installBundle

    // 故意先加载 gate 行：真实启动时两行的先后顺序不确定。
    const fiber = await ctx.plugin({ name, inject, apply })

    // 服务还没出现 —— 此时不可能包装，也不该抛错。
    expect(manager.installBundle).toBe(original)

    // 服务就绪。有 inject 声明时 cordis 会重新 apply。
    ctx.provide('pluginManager', manager)
    await settle()

    // 关键断言：包装必须建立。删掉 inject 这一行就红。
    expect(manager.installBundle).not.toBe(original)

    await fiber.dispose()
    await settle()
  })

  it('restores the original method when the row is unloaded', async () => {
    const ctx = new Context()
    const manager = fakeManager()
    const original = manager.installBundle

    const fiber = await ctx.plugin({ name, inject, apply })
    ctx.provide('pluginManager', manager)
    await settle()
    expect(manager.installBundle).not.toBe(original)

    // 关掉这一行 = fiber 卸载 → effect 里的还原函数执行。
    await fiber.dispose()
    await settle()
    expect(manager.installBundle).toBe(original)
  })

  it('wraps immediately when the service is already present', async () => {
    const ctx = new Context()
    const manager = fakeManager()
    const original = manager.installBundle

    // 反过来的顺序：服务先就绪，插件后加载。
    ctx.provide('pluginManager', manager)
    const fiber = await ctx.plugin({ name, inject, apply })
    await settle()

    expect(manager.installBundle).not.toBe(original)
    await fiber.dispose()
    await settle()
  })

  it('never throws when the service is absent for the whole lifetime', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin({ name, inject, apply })
    await settle()
    // 服务一直不出现：apply 根本不会被调用，卸载也不该抛。
    await expect(fiber.dispose()).resolves.toBeUndefined()
  })
})
