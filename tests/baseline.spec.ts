import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  autoRecordPath,
  buildBaseline,
  currentMetaOf,
  diffBaseline,
  expandHome,
  loadBaseline,
  saveBaseline,
  type BaselineFile,
} from '../src/baseline'
import { resolveConfig } from '../src/config'
import { renderLintJson, renderLintMarkdown } from '../src/tools/report'
import type { Finding, RuleId, ScanResult, SkillLintResult } from '../src/types'

/** 造一个最小 lint 结果。 */
function result(name: string, rules: readonly RuleId[], severity: 'info' | 'warn' | 'error' = 'warn'): SkillLintResult {
  const findings: Finding[] = rules.map(rule => ({ rule, severity, message: `${rule} in ${name}` }))
  return {
    skill: {
      name,
      description: 'demo',
      content: 'body',
      provider: 'filesystem',
      source: 'filesystem',
      invocation: { modelInvocable: true, userInvocable: true },
    },
    findings,
    errors: findings.filter(item => item.severity === 'error').length,
    warnings: findings.filter(item => item.severity === 'warn').length,
    infos: findings.filter(item => item.severity === 'info').length,
    ok: findings.length === 0,
  }
}

function scan(results: readonly SkillLintResult[]): ScanResult {
  return {
    results,
    errors: results.reduce((total, item) => total + item.errors, 0),
    warnings: results.reduce((total, item) => total + item.warnings, 0),
    infos: results.reduce((total, item) => total + item.infos, 0),
    ok: results.every(item => item.ok),
  }
}

const META = { severity: 'info' as const, rules: ['*'] as const }

const tmpDirs: string[] = []
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('expandHome', () => {
  it('expands a leading ~ but leaves other paths alone', () => {
    expect(expandHome('~/records/baseline.json')).not.toContain('~')
    expect(expandHome('D:/skills/baseline.json')).toBe('D:/skills/baseline.json')
    expect(expandHome('~another')).toBe('~another')
  })
})

describe('autoRecordPath', () => {
  it('is per-profile inside $DSH_HOME so desktop and headless records never mix', () => {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = 'D:/fake-dsh-home'
    try {
      const desktop = autoRecordPath('desktop')
      expect(desktop).toContain('skill-doctor')
      expect(desktop).toContain('record-desktop.json')
      expect(autoRecordPath('headless')).not.toBe(desktop)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

describe('buildBaseline / saveBaseline / loadBaseline', () => {
  it('round-trips through disk with stable JSON', async () => {
    const path = join(tmp(), 'record.json')
    const baseline = buildBaseline(scan([result('a', ['SD004']), result('b', [])]), META, '2026-10-31T00:00:00.000Z')
    await saveBaseline(path, baseline)
    const loaded = await loadBaseline(path)
    expect(loaded).toEqual(baseline)
    // 落盘的是人可读的 JSON，用户可以 diff、可以提交进仓库。
    expect(readFileSync(path, 'utf8')).toContain('"version": 1')
  })

  it('returns undefined for missing, broken or unknown-version records', async () => {
    const dir = tmp()
    expect(await loadBaseline(join(dir, 'nope.json'))).toBeUndefined()
    writeFileSync(join(dir, 'broken.json'), '{ not json')
    expect(await loadBaseline(join(dir, 'broken.json'))).toBeUndefined()
    writeFileSync(join(dir, 'future.json'), JSON.stringify({ version: 99, savedAt: 'x', meta: META, skills: {} }))
    expect(await loadBaseline(join(dir, 'future.json'))).toBeUndefined()
  })

  it('survives a record with unexpected field types inside', async () => {
    // 手改坏的病历不该让体检挂掉：跳过坏字段，其余照读。
    const path = join(tmp(), 'weird.json')
    writeFileSync(path, JSON.stringify({
      version: 1,
      savedAt: '2026-10-31T00:00:00.000Z',
      meta: { severity: 'info', rules: '*' },
      skills: { a: { errors: 'two', warnings: 1, infos: null, rules: { SD004: 'many', SD014: 2 } } },
    }))
    const loaded = await loadBaseline(path)
    expect(loaded?.skills.a).toEqual({ errors: 0, warnings: 1, infos: 0, rules: { SD014: 2 } })
  })
})

describe('currentMetaOf', () => {
  it('reports * when every rule is enabled, else the enabled list', () => {
    expect(currentMetaOf(resolveConfig(undefined))).toEqual({ severity: 'info', rules: ['*'] })
    const filtered = resolveConfig({ rules: { SD013: 'off', SD014: 'off' }, severityThreshold: 'warn' })
    expect(currentMetaOf(filtered)).toEqual({ severity: 'warn', rules: expect.arrayContaining(['SD001', 'SD012']) })
    expect(currentMetaOf(filtered).rules).not.toContain('SD013')
  })
})

describe('diffBaseline', () => {
  it('shows what improved, grouped by rule', () => {
    const before = buildBaseline(scan([
      result('a', ['SD004']),
      result('b', ['SD004']),
      result('c', ['SD004']),
    ]), META)
    const after = scan([result('a', ['SD004']), result('b', []), result('c', [])])
    const diff = diffBaseline(before, after, META)
    expect(diff.improved).toEqual([
      { rule: 'SD004', plainTitle: '简介太长，后半段模型看不到', before: 3, after: 1 },
    ])
    expect(diff.regressed).toEqual([])
    expect(diff.totalBefore).toBe(3)
    expect(diff.totalAfter).toBe(1)
  })

  it('names the skills behind a regression, capped at three', () => {
    const before = buildBaseline(scan([result('a', []), result('b', []), result('c', []), result('d', [])]), META)
    const after = scan([
      result('a', ['SD008']),
      result('b', ['SD008']),
      result('c', ['SD008']),
      result('d', []),
      result('e', []),
    ])
    const diff = diffBaseline(before, after, META)
    expect(diff.regressed[0]!.rule).toBe('SD008')
    expect(diff.regressedSkills.SD008).toEqual(['a', 'b', 'c'])
    expect(diff.newSkills).toEqual(['e'])
  })

  it('tracks untouched rules, new and gone skills', () => {
    const before = buildBaseline(scan([result('a', ['SD014']), result('gone', ['SD013'])]), META)
    const after = scan([result('a', ['SD014']), result('fresh', [])])
    const diff = diffBaseline(before, after, META)
    expect(diff.unchanged.map(item => item.rule)).toEqual(['SD014'])
    expect(diff.goneSkills).toEqual(['gone'])
    expect(diff.newSkills).toEqual(['fresh'])
    expect(diff.improved.map(item => item.rule)).toEqual(['SD013'])
  })

  it('warns when the record was saved with a different measuring stick', () => {
    const before = buildBaseline(scan([result('a', ['SD004'])]), { severity: 'warn', rules: ['*'] })
    const after = scan([result('a', [])])
    const diff = diffBaseline(before, after, { severity: 'info', rules: ['*'] })
    expect(diff.metaWarning).toContain('severity=warn')
    expect(diff.metaWarning).toContain('不可直接比')

    const filteredBefore = buildBaseline(scan([result('a', ['SD004'])]), { severity: 'info', rules: ['SD004'] })
    const filteredDiff = diffBaseline(filteredBefore, after, META)
    expect(filteredDiff.metaWarning).toContain('规则集不同')
  })

  it('stays quiet when everything is identical', () => {
    const results = scan([result('a', ['SD014'])])
    const before = buildBaseline(results, META)
    const diff = diffBaseline(before, results, META)
    expect(diff.improved).toEqual([])
    expect(diff.regressed).toEqual([])
    expect(diff.unchanged.map(item => item.rule)).toEqual(['SD014'])
    expect(diff.newSkills).toEqual([])
    expect(diff.goneSkills).toEqual([])
    expect(diff.metaWarning).toBeUndefined()
  })
})

describe('report: follow-up section', () => {
  const before: BaselineFile = buildBaseline(scan([
    result('a', ['SD004', 'SD014']),
    result('b', ['SD004']),
    result('c', ['SD004']),
    result('gone', []),
  ]), META)
  const after = scan([
    result('a', ['SD014']),
    result('b', ['SD004']),
    result('c', []),
    result('new', ['SD008']),
  ])
  const diff = diffBaseline(before, after, META)

  it('renders a follow-up comparison in the plain report', () => {
    const markdown = renderLintMarkdown(after, {
      baselineDiff: diff,
      baselineLabel: '`record.json`（2026-10-31 存档）',
    })
    expect(markdown).toContain('复诊对比')
    expect(markdown).toContain('record.json')
    expect(markdown).toContain('✅ 好转：简介太长，后半段模型看不到 3 → 1')
    expect(markdown).toContain('😐 还没动：换行符是 Windows 格式 1 → 1')
    expect(markdown).toContain('⚠️ 变差：正文里提到的文件找不到 0 → 1（`new`）')
    expect(markdown).toContain('🆕 这次新扫到：`new`')
    expect(markdown).toContain('🗑 上次有、这次不在：`gone`')
    expect(markdown).toContain('整体：问题总数 4 → 3')
    // 复诊对比紧跟体检分布，排在正文细节之前：刚修完的人第一眼想看“好了多少”。
    expect(markdown.indexOf('复诊对比')).toBeLessThan(markdown.indexOf('## 其他小问题'))
  })

  it('exposes the comparison to CI in JSON output', () => {
    const parsed = JSON.parse(renderLintJson(after, { baselineDiff: diff })) as {
      comparison: { totalBefore: number; totalAfter: number; regressed: { rule: string }[] }
    }
    expect(parsed.comparison.totalBefore).toBe(4)
    expect(parsed.comparison.totalAfter).toBe(3)
    expect(parsed.comparison.regressed[0]!.rule).toBe('SD008')
  })

  it('does not render the section without a baseline', () => {
    expect(renderLintMarkdown(after)).not.toContain('复诊对比')
    expect(renderLintJson(after) as unknown as { comparison?: unknown }).not.toHaveProperty('comparison')
  })

  it('explains the first auto-record instead of showing a confusing empty comparison', () => {
    // auto 模式第一次跑没有旧病历：不是异常，要说清“下次开始有对比”。
    const markdown = renderLintMarkdown(after, { baselineFirstRecord: true })
    expect(markdown).toContain('第一次记录病历')
    expect(markdown).toContain('下次体检开始')
    // 没有旧病历就没有对比章节本身（只允许提示文案里提到这四个字）。
    expect(markdown).not.toContain('## 复诊对比')
  })

  it('acknowledges the stored record so the user knows the next diff is against it', () => {
    const markdown = renderLintMarkdown(after, { recordSaved: 'D:/records/auto.json' })
    expect(markdown).toContain('已存为新病历')
    expect(markdown).toContain('D:/records/auto.json')
    const withDiff = renderLintMarkdown(after, {
      baselineDiff: diff,
      baselineLabel: '`record.json`（2026-10-31 存档）',
      recordSaved: 'D:/records/auto.json',
    })
    // 有对比时回执跟在对比后面，两件事都在。
    expect(withDiff).toContain('复诊对比')
    expect(withDiff).toContain('已存为新病历')
    expect((JSON.parse(renderLintJson(after, { recordSaved: 'x' })) as { recordSaved: string }).recordSaved).toBe('x')
  })
})
