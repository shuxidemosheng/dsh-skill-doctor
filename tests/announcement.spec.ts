/** 目录预算：纯展示数据，不产生 Finding、不判定超限。 */
import { describe, expect, it } from 'vitest'
import {
  REFERENCE_CHAR_BUDGET,
  announcementJson,
  announcementMarkdownLines,
  announcementPlainLine,
  buildAnnouncement,
  shouldShowAnnouncement,
} from '../src/tools/announcement'
import { renderLintMarkdown } from '../src/tools/report'
import type { ScanResult, SkillLintResult } from '../src/types'
import { makeSkill } from './helpers'

/** 把一组 SkillInput 包成 ScanResult，供渲染函数使用；findings 一律为空。 */
function scanResult(skills: readonly ReturnType<typeof makeSkill>[]): ScanResult {
  const results: SkillLintResult[] = skills.map(skill => ({
    skill,
    findings: [],
    errors: 0,
    warnings: 0,
    infos: 0,
    ok: true,
  }))
  return { results, errors: 0, warnings: 0, infos: 0, ok: true }
}

describe('buildAnnouncement', () => {
  it('adds up name + description + whenToUse for every model-invocable skill', () => {
    const view = buildAnnouncement([
      makeSkill({ name: 'abc', description: '12345', whenToUse: 'xyz' }),
      makeSkill({ name: 'de', description: '6789' }),
    ])
    expect(view.skills).toBe(2)
    expect(view.chars).toBe(3 + 5 + 3 + 2 + 4)
    expect(view.referenceBudget).toBe(REFERENCE_CHAR_BUDGET)
  })

  it('excludes skills the model cannot invoke on its own', () => {
    const view = buildAnnouncement([
      makeSkill({ name: 'auto', description: '短' }),
      makeSkill({
        name: 'manual-only',
        description: '很长很长很长',
        invocation: { modelInvocable: false, userInvocable: true },
      }),
    ])
    expect(view.skills).toBe(1)
    expect(view.chars).toBe('auto'.length + '短'.length)
  })

  it('treats a missing whenToUse as zero rather than NaN', () => {
    const view = buildAnnouncement([makeSkill({ name: 'a', description: 'bb' })])
    expect(view.chars).toBe(3)
    expect(Number.isFinite(view.approxTokens)).toBe(true)
  })

  it('estimates tokens with ceil(chars / 3)', () => {
    const view = buildAnnouncement([makeSkill({ name: 'abcd', description: 'ef' })])
    expect(view.approxTokens).toBe(2)
  })

  it('counts an empty catalogue as zero', () => {
    const view = buildAnnouncement([])
    expect(view).toMatchObject({ skills: 0, chars: 0, approxTokens: 0 })
  })
})

describe('shouldShowAnnouncement', () => {
  it('stays hidden for a small catalogue so existing reports do not change', () => {
    const view = buildAnnouncement([makeSkill()])
    expect(shouldShowAnnouncement(view)).toBe(false)
  })

  it('appears once the catalogue reaches ten skills', () => {
    const many = Array.from({ length: 10 }, (_, i) => makeSkill({ name: `skill-${i}` }))
    expect(shouldShowAnnouncement(buildAnnouncement(many))).toBe(true)
  })

  it('appears when characters reach half the reference budget even with few skills', () => {
    const half = Math.ceil(REFERENCE_CHAR_BUDGET / 2)
    const view = buildAnnouncement([makeSkill({ name: 'a', description: 'x'.repeat(half) })])
    expect(shouldShowAnnouncement(view)).toBe(true)
  })
})

describe('rendered text', () => {
  const view = buildAnnouncement([makeSkill({ name: 'demo', description: '简介', whenToUse: '用于校对' })])

  it('puts measured numbers and the uncalibrated note in the plain line', () => {
    const line = announcementPlainLine(view)
    expect(line).toContain('目录预算')
    expect(line).toContain(`${view.chars} 字符`)
    expect(line).toContain('未在 dsh 校准')
    expect(line).not.toContain('|')
  })

  it('never turns the reference into an exceeded-budget verdict', () => {
    const all = [
      ...announcementMarkdownLines(view),
      announcementPlainLine(view),
      JSON.stringify(announcementJson(view)),
    ].join('\n')
    // 文案里会写「不判定是否超限」，所以不能按字面词断言；
    // 要检查的是没有「已超限 / 超出预算」这类结论，也没有布尔判定字段。
    expect(all).not.toContain('已超限')
    expect(all).not.toContain('超出预算')
    expect(all).not.toContain('overBudget')
    expect(all).toContain('未在 dsh 上校准')
    expect(announcementJson(view)).not.toHaveProperty('overBudget')
  })

  it('marks the reference as uncalibrated for machine readers', () => {
    expect(announcementJson(view)).toMatchObject({
      chars: view.chars,
      referenceCalibrated: false,
    })
  })

  it('keeps small Markdown reports free of the section', () => {
    const text = renderLintMarkdown(scanResult([makeSkill(), makeSkill({ name: 'other' })]))
    expect(text).not.toContain('目录预算')
  })

  it('adds the section to a large Markdown report without creating findings', () => {
    const many = Array.from({ length: 12 }, (_, i) => makeSkill({ name: `skill-${i}` }))
    const result = scanResult(many)
    const text = renderLintMarkdown(result)
    expect(text).toContain('## 目录预算')
    // 展示层不能反过来改动扫描结果：findings 与 ok 必须原样。
    expect(result.results.every(item => item.findings.length === 0)).toBe(true)
    expect(result.ok).toBe(true)
  })

  it('does the same for the technical style', () => {
    const many = Array.from({ length: 12 }, (_, i) => makeSkill({ name: `skill-${i}` }))
    expect(renderLintMarkdown(scanResult(many), { style: 'technical' })).toContain('## 目录预算')
  })
})
