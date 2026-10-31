import { describe, expect, it } from 'vitest'
import { FIXABLE_RULES } from '../src/fixer/plan'
import { RULE_IDS } from '../src/scanner/rules'
import { prescribeKind, prescriptionLine, prescriptionOf } from '../src/tools/prescriptions'

/** 插件侧的规则 ID（不在 RuleId 联合类型里）。 */
const PLUGIN_RULES = ['PL001', 'PL002', 'PL003', 'PL004', 'PL005', 'PL006'] as const

describe('prescriptions', () => {
  it('classifies every skill rule and every plugin rule', () => {
    for (const rule of [...RULE_IDS, ...PLUGIN_RULES]) {
      expect(prescribeKind(rule), rule).toMatch(/^(autofix|command|manual)$/)
    }
  })

  it('keeps autofix exactly in sync with what the CLI can actually fix', () => {
    // 这张表和 fixer/plan.ts 的 FIXABLE_RULES 是两份数据，必须锁死：
    // 一旦有人改了其中一份，测试就会失败，而不是让报告承诺一个不存在的修复。
    const autofix = [...RULE_IDS, ...PLUGIN_RULES].filter(rule => prescribeKind(rule) === 'autofix')
    expect(new Set(autofix)).toEqual(new Set(FIXABLE_RULES))
  })

  it('treats an unknown rule as manual instead of guessing', () => {
    expect(prescribeKind('SD999')).toBe('manual')
    expect(prescribeKind('')).toBe('manual')
  })

  it('labels the three kinds distinctly', () => {
    expect(prescriptionOf('SD013').label).toContain('自动修')
    expect(prescriptionOf('PL004').label).toContain('命令')
    expect(prescriptionOf('SD012').label).toContain('人工')
  })

  it('gives the autofix line a runnable command with the skill directory', () => {
    const line = prescriptionLine('SD013', undefined, 'C:/skills/demo')
    expect(line).toContain('--fix')
    expect(line).toContain('--apply')
    expect(line).toContain('C:/skills/demo')
  })

  it('falls back to a placeholder when the skill has no local directory', () => {
    // dsh 自带的虚拟技能没有本地文件，命令里不能出现 undefined 或空字符串。
    const line = prescriptionLine('SD014', undefined, undefined)
    expect(line).toContain('<技能目录>')
    expect(line).not.toContain('undefined')
  })

  it('reuses the rule suggestion for command and manual kinds', () => {
    expect(prescriptionLine('PL004', 'dsh plugin --profile desktop enable x')).toContain('enable x')
    expect(prescriptionLine('SD009', '把多余的副本改名或删掉')).toContain('副本改名或删掉')
  })
})
