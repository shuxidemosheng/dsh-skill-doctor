/**
 * `/install` 的安装分支：只有门禁通过才允许调用官方安装服务。
 *
 * 同模块内部函数互相调用不会经过 ESM 导出表，vitest 的模块 mock 在这里无效，
 * 所以 `installAfterGate` 接受一个可选的预计算门禁结果（生产不传）。
 * 测试据此覆盖 pass / block / error 三条路径，不联网、不真的安装任何东西。
 */
import { describe, expect, it, vi } from 'vitest'
import { installAfterGate, type GateResult } from '../src/plugins/gate'

function gate(decision: 'pass' | 'block' | 'error'): GateResult {
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
        detail: '检查 postinstall。', where: 'package.json',
      }],
    }
  }
  if (decision === 'error') return { ...base, problem: 'download-failed：ETIMEDOUT' }
  return base
}

/** 造一个只带 `get` 的最小 ctx；`installAfterGate` 只用它软探测服务。 */
function fakeCtx(manager?: unknown): never {
  return { get: () => manager } as never
}

describe('installAfterGate only installs after a pass', () => {
  it('does not touch the install service when a high-risk rule hits', async () => {
    const installBundle = vi.fn()
    const lines = await installAfterGate(fakeCtx({ installBundle }), 'demo@1.0.0', gate('block'))
    expect(installBundle).not.toHaveBeenCalled()
    expect(lines.join('\n')).toContain('GT001')
    expect(lines.join('\n')).toContain('拒绝安装')
  })

  it('does not install when the gate could not finish (fail closed)', async () => {
    const installBundle = vi.fn()
    const lines = await installAfterGate(fakeCtx({ installBundle }), 'demo@1.0.0', gate('error'))
    expect(installBundle).not.toHaveBeenCalled()
    expect(lines.join('\n')).toContain('未能完成审查')
  })

  it('reports a missing pluginManager service instead of throwing', async () => {
    const lines = await installAfterGate(fakeCtx(undefined), 'demo@1.0.0', gate('pass'))
    expect(lines.join('\n')).toContain('没有 pluginManager 服务')
    expect(lines.join('\n')).toContain('未执行安装')
  })

  it('calls installBundle with the exact locked spec on a pass', async () => {
    const installBundle = vi.fn(async () => ({ application: 'applied', changed: true }))
    const lines = await installAfterGate(fakeCtx({ installBundle }), 'demo', gate('pass'))
    expect(installBundle).toHaveBeenCalledTimes(1)
    // 关键：用门禁解析出的精确版本，而不是用户输入的原始 spec。
    expect(installBundle).toHaveBeenCalledWith('demo@1.0.0', { saveExact: true })
    expect(lines.join('\n')).toContain('application=applied')
  })

  it('surfaces an install error without throwing', async () => {
    const installBundle = vi.fn(async () => {
      throw new Error('boom')
    })
    const lines = await installAfterGate(fakeCtx({ installBundle }), 'demo@1.0.0', gate('pass'))
    expect(lines.join('\n')).toContain('安装调用失败')
  })
})
