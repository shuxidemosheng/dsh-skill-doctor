import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { probeRuntime, summarizeRuntime, type RuntimeSnapshot } from '../src/plugins/runtime'
import { TOOL_NAMES } from '../src/tool-names'

/** 造一个只有 `get` 的 ctx；Cordis 的服务查找就是这一个方法。 */
function fakeCtx(services: Record<string, unknown>, options: { throws?: boolean } = {}): Context {
  return {
    get(name: string) {
      if (options.throws === true) throw new Error('reflect exploded')
      return services[name]
    },
  } as unknown as Context
}

/** 造一个能返回固定 schemas 的 tools 服务，并记录收到的 scope。 */
function fakeTools(names: readonly string[]): { service: unknown; scopes: unknown[] } {
  const scopes: unknown[] = []
  return {
    scopes,
    service: {
      schemas(scope?: unknown) {
        scopes.push(scope)
        return names.map(name => ({ name, description: '', parameters: {} }))
      },
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('probeRuntime', () => {
  it('degrades to unavailable when the service is missing', async () => {
    const snapshot = await probeRuntime(fakeCtx({}))
    expect(snapshot.status).toBe('unavailable')
    expect(snapshot.entries).toHaveLength(0)
    // 降级必须带一句人话，不能只是 status 变化。
    expect(snapshot.note).toMatch(/没有暴露/)
  })

  it('survives a ctx.get that throws', async () => {
    const snapshot = await probeRuntime(fakeCtx({}, { throws: true }))
    expect(snapshot.status).toBe('unavailable')
  })

  it('passes exec.agent to schemas() so preset-layer tools are not missed', async () => {
    const tools = fakeTools(['skill_doctor'])
    const agent = { id: 'agent-1' }
    await probeRuntime(fakeCtx({ tools: tools.service }), { agent })
    expect(tools.scopes).toEqual([agent])
  })

  it('returns tool names even when the inventory is unavailable', async () => {
    const tools = fakeTools(['a', 'b'])
    const snapshot = await probeRuntime(fakeCtx({ tools: tools.service }))
    expect(snapshot.status).toBe('unavailable')
    expect(snapshot.toolNames).toEqual(['a', 'b'])
  })

  it('parses entries and drops rows without a module name', async () => {
    const inventory = {
      list: async () => ({
        entries: [
          { entryId: 'e1', moduleName: 'dsh-a', enabled: true, fiberPhase: 'active' },
          { entryId: 'e2', moduleName: 'dsh-b', enabled: false, fiberPhase: null },
          { entryId: 'e3', enabled: true },
        ],
      }),
    }
    const snapshot = await probeRuntime(fakeCtx({ pluginInventory: inventory }))
    expect(snapshot.status).toBe('ok')
    expect(snapshot.entries.map(entry => entry.moduleName)).toEqual(['dsh-a', 'dsh-b'])
    expect(snapshot.entries[1]!.enabled).toBe(false)
  })

  it('times out instead of hanging when list() never resolves', async () => {
    vi.useFakeTimers()
    const inventory = { list: () => new Promise<unknown>(() => {}) }
    const pending = probeRuntime(fakeCtx({ pluginInventory: inventory }))
    await vi.advanceTimersByTimeAsync(1000)
    const snapshot = await pending
    expect(snapshot.status).toBe('timeout')
    expect(snapshot.note).toMatch(/ms/)
  })

  it('turns a rejected list() into an error status rather than throwing', async () => {
    const inventory = { list: async () => { throw new Error('remote down') } }
    const snapshot = await probeRuntime(fakeCtx({ pluginInventory: inventory }))
    expect(snapshot.status).toBe('error')
    expect(snapshot.note).toContain('remote down')
  })
})

describe('summarizeRuntime', () => {
  /** 一份现成的快照。 */
  function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
    return { status: 'ok', entries: [], toolNames: null, ...overrides }
  }

  it('names only plugins that are enabled AND failed', () => {
    const summary = summarizeRuntime(snapshot({
      entries: [
        { moduleName: 'dsh-broken', enabled: true, fiberPhase: 'failed' },
        { moduleName: 'dsh-disabled', enabled: false, fiberPhase: 'failed' },
        { moduleName: 'dsh-ok', enabled: true, fiberPhase: 'active' },
      ],
    }), [])
    // 被禁用的插件失败是预期的，不能算问题。
    expect(summary.failed).toEqual(['dsh-broken'])
  })

  it('counts phases and matches declared bundles by module name', () => {
    const summary = summarizeRuntime(snapshot({
      entries: [
        { moduleName: 'dsh-a', enabled: true, fiberPhase: 'active' },
        { moduleName: 'dsh-b', enabled: true, fiberPhase: 'active' },
        { moduleName: 'renamed-module', enabled: true, fiberPhase: 'pending' },
      ],
    }), [{ name: 'dsh-a' }, { name: 'dsh-b' }, { name: 'dsh-c' }])
    expect(summary.enabled).toBe(3)
    expect(summary.phases).toEqual({ active: 2, pending: 1 })
    expect(summary.matched).toBe(2)
    expect(summary.declared).toBe(3)
  })

  it('lists our own tools that are missing from the session', () => {
    const summary = summarizeRuntime(snapshot({
      toolNames: ['skill_doctor', 'something_else'],
    }), [])
    expect(summary.missingOwnTools).toEqual(['skill_lint', 'skill_explain', 'plugin_doctor'])
    expect(TOOL_NAMES).toContain('skill_doctor')
  })

  it('reports nothing missing when tool names are unavailable', () => {
    const summary = summarizeRuntime(snapshot({ toolNames: null }), [])
    // 拿不到工具列表时不能报「全都缺失」，那会是最大的误报源。
    expect(summary.missingOwnTools).toEqual([])
    expect(summary.toolCount).toBeNull()
  })
})
