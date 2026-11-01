import { describe, expect, it } from 'vitest'
import { renderRewriteBatch, renderRewriteWorksheet } from '../src/tools/rewrite'
import type { Finding, RuleId, SkillLintResult } from '../src/types'

/** 造一个合成技能：description 由调用方给，findings 只用于计数。 */
function result(name: string, description: string, rules: readonly RuleId[] = []): SkillLintResult {
  const findings: Finding[] = rules.map(rule => ({ rule, severity: 'warn', message: `${rule} in ${name}` }))
  return {
    skill: {
      name,
      description,
      content: 'body',
      provider: 'filesystem',
      source: 'filesystem',
      invocation: { modelInvocable: true, userInvocable: true },
    },
    findings,
    errors: findings.filter(item => item.severity === 'error').length,
    warnings: findings.length,
    infos: 0,
    ok: findings.length === 0,
  }
}

/** 600 字超长简介：触发词在后半段（模拟真实 nature-* 的病）。 */
const LONG = '这是一个用于学术写作场景的长简介。'.padEnd(320, ' filler。')
  + '支持「分段引用」与「自动给出引用」，以及 Nature 系列期刊的引文核验。'.padEnd(280, ' detail。')

describe('renderRewriteWorksheet (single)', () => {
  const worksheet = renderRewriteWorksheet(result('nature-citation', LONG), 500).join('\n')

  it('states the hard constraints with the real budget', () => {
    expect(worksheet).toContain('硬约束')
    expect(worksheet).toContain('不超过 **500 字**')
    expect(worksheet).toContain('超限 100 字')
    expect(worksheet).toContain('前 80 字内')
  })

  it('shows the verbatim visible and cut parts, not a paraphrase', () => {
    // 工单的价值在于"模型可见原文"，摘了就失去判断依据。
    expect(worksheet).toContain(LONG.slice(0, 500).slice(0, 40))
    expect(worksheet).toContain('被切掉的 100 字')
    expect(worksheet).toContain(oneLineSafe(LONG.slice(500)).slice(0, 30))
  })

  it('extracts trigger phrases as priority material', () => {
    expect(worksheet).toContain('触发说法')
    expect(worksheet).toContain('分段引用')
    expect(worksheet).toContain('自动给出引用')
  })

  it('provides a deterministic skeleton with quoted triggers, marked as not-final', () => {
    expect(worksheet).toContain('不是最终文案')
    expect(worksheet).toContain('当用户说「分段引用」')
    expect(worksheet).toContain('在此基础上润色')
  })

  it('demands user confirmation and re-check, never auto-writing', () => {
    expect(worksheet).toContain('先给用户确认')
    expect(worksheet).toContain('复诊对比')
    expect(worksheet).toContain('验收标准')
    expect(worksheet).not.toContain('已自动写入')
  })

  it('handles an empty description by asking the user first', () => {
    const empty = renderRewriteWorksheet(result('blank', ''), 500).join('\n')
    expect(empty).toContain('是**空的**')
    expect(empty).toContain('先向用户确认技能用途')
    expect(empty).not.toContain('被切掉的')
  })

  it('tells the truth about the current truncation impact in the acceptance criteria', () => {
    expect(worksheet).toContain('截断影响从“')
  })
})

function oneLineSafe(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

describe('renderRewriteBatch', () => {
  const results = [
    result('nature-pdf', LONG, ['SD004']),
    result('nature-doc', LONG, ['SD004']),
    result('nature-xlsx', LONG, ['SD004']),
    result('solo-tool', LONG, ['SD004']),
    result('healthy', 'short', []),
  ]

  it('groups shared-prefix skills into one template and names the variable part', () => {
    const batch = renderRewriteBatch(results, 500).join('\n')
    expect(batch).toContain('模板组 `nature-*`')
    expect(batch).toContain('先写一份模板简介')
    expect(batch).toContain('模板变量段')
    // solo-tool 没有前缀团伙，不该被塞进模板组。
    expect(batch).toContain('### `solo-tool`')
  })

  it('covers every truncated skill with its own budget line', () => {
    const batch = renderRewriteBatch(results, 500).join('\n')
    for (const name of ['nature-pdf', 'nature-doc', 'nature-xlsx', 'solo-tool']) {
      expect(batch).toContain(`### \`${name}\``)
    }
    expect(batch).not.toContain('### `healthy`')
  })

  it('closes the loop: acceptance criteria reference the cluster going to zero', () => {
    const batch = renderRewriteBatch(results, 500).join('\n')
    expect(batch).toContain('全部先给用户确认')
    expect(batch).toContain('命中数应归零')
  })

  it('says so when nothing needs rewriting', () => {
    const batch = renderRewriteBatch([result('healthy', 'short')], 500).join('\n')
    expect(batch).toContain('当前没有简介被截断的技能')
  })
})
