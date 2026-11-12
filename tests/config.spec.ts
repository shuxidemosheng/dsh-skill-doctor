import { describe, expect, it } from 'vitest'
import { resolveConfig, withRuleFilter } from '../src/config'

describe('resolveConfig', () => {
  it('fills defaults', () => {
    const config = resolveConfig(undefined)
    expect(config.maxDescriptionLength).toBe(500)
    expect(config.maxBodyTokens).toBe(8000)
    expect(config.maxFileBytes).toBe(1024 * 1024)
    expect(config.extraRoots).toEqual([])
    expect(config.severityThreshold).toBe('info')
  })

  it('rejects unknown keys and bad types', () => {
    expect(() => resolveConfig({ nope: true } as never)).toThrow(/unknown config key/)
    expect(() => resolveConfig({ maxDescriptionLength: 0 })).toThrow(/positive integer/)
    expect(() => resolveConfig({ maxBodyTokens: 1.5 })).toThrow(/positive integer/)
    expect(() => resolveConfig({ extraRoots: [1] } as never)).toThrow(/array of non-empty strings/)
    expect(() => resolveConfig({ severityThreshold: 'fatal' } as never)).toThrow(/info, warn, error/)
  })

  it('treats installGate as deprecated: only reported when set explicitly', () => {
    // 门禁已拆成独立组件行。配置里的 installGate 只为兼容保留，
    // 不再有默认值——「没设置」和「设成 block」必须能区分开，
    // 主入口据此才决定要不要打迁移提示。
    expect(resolveConfig(undefined).installGate).toBeUndefined()
    expect(resolveConfig({ installGate: 'off' }).installGate).toBe('off')
    expect(resolveConfig({ installGate: 'block' }).installGate).toBe('block')
  })

  it('still rejects an invalid installGate value', () => {
    expect(() => resolveConfig({ installGate: 'nope' } as never)).toThrow(/installGate/)
  })

  it('validates rule ids and values', () => {
    expect(() => resolveConfig({ rules: { SD999: 'off' } } as never)).toThrow(/unknown rule id/)
    expect(() => resolveConfig({ rules: { SD001: 'fatal' } } as never)).toThrow(/info, warn, error/)
    expect(resolveConfig({ rules: { SD001: 'off' } }).rules.SD001).toBe('off')
  })
})

describe('withRuleFilter', () => {
  it('turns unlisted rules off and keeps listed defaults', () => {
    const base = resolveConfig(undefined)
    const filtered = withRuleFilter(base, ['SD003', 'SD004'], undefined)
    expect(filtered.rules.SD003).toBeUndefined()
    expect(filtered.rules.SD004).toBeUndefined()
    expect(filtered.rules.SD001).toBe('off')
  })

  it('rejects unknown rule ids and can override the threshold', () => {
    const base = resolveConfig(undefined)
    expect(() => withRuleFilter(base, ['SD999'], undefined)).toThrow(/unknown rule id/)
    expect(withRuleFilter(base, undefined, 'error').severityThreshold).toBe('error')
  })
})
