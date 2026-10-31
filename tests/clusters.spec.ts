import { describe, expect, it } from 'vitest'
import { clusterFindings, clusterHint } from '../src/clusters'
import { renderLintJson, renderLintMarkdown } from '../src/tools/report'
import type { Finding, RuleId, Severity, SkillLintResult } from '../src/types'

/** 造一个最小 lint 结果：只带名字和命中的规则，其余字段与聚类无关。 */
function result(name: string, rules: readonly RuleId[], severity: Severity = 'warn'): SkillLintResult {
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

describe('clusterFindings', () => {
  it('returns nothing when there are no skills', () => {
    expect(clusterFindings([])).toEqual([])
  })

  it('merges many hits of one rule into one root cause', () => {
    const results = [
      result('nature-pdf', ['SD004']),
      result('nature-doc', ['SD004']),
      result('nature-xlsx', ['SD004']),
      result('odd-one', []),
    ]
    const clusters = clusterFindings(results)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.rule).toBe('SD004')
    expect(clusters[0]!.count).toBe(3)
    expect(clusters[0]!.share).toBeCloseTo(0.75)
    expect(clusters[0]!.skills).toEqual(['nature-doc', 'nature-pdf', 'nature-xlsx'])
  })

  it('only reports a cluster when it is both numerous and wide-spread', () => {
    // 3 个命中但只占 6%：技能很多时不该把它当成全局根因。
    const many = Array.from({ length: 47 }, (_, index) => result(`skill-${index}`, []))
    const results = [
      ...many,
      result('a', ['SD004']),
      result('b', ['SD004']),
      result('c', ['SD004']),
    ]
    expect(clusterFindings(results)).toEqual([])
  })

  it('does not treat 2 hits as a common problem', () => {
    const results = [result('a', ['SD004']), result('b', ['SD004'])]
    expect(clusterFindings(results)).toEqual([])
  })

  it('counts one skill once even if the same rule hits twice', () => {
    const results = [
      result('a', ['SD004', 'SD004']),
      result('b', ['SD004']),
      result('c', ['SD004']),
    ]
    const clusters = clusterFindings(results)
    expect(clusters[0]!.count).toBe(3)
  })

  it('detects a shared name prefix and says it is probably a template', () => {
    const results = [
      result('nature-pdf', ['SD004']),
      result('nature-doc', ['SD004']),
      result('nature-xlsx', ['SD004']),
    ]
    const cluster = clusterFindings(results)[0]!
    expect(cluster.commonPrefix).toBe('nature')
    expect(clusterHint(cluster)).toContain('nature-')
    expect(clusterHint(cluster)).toContain('同一套模板')
  })

  it('leaves the prefix undefined when names share nothing', () => {
    const results = [result('alpha', ['SD004']), result('beta', ['SD004']), result('gamma', ['SD004'])]
    const cluster = clusterFindings(results)[0]!
    expect(cluster.commonPrefix).toBeUndefined()
    expect(clusterHint(cluster)).toContain('各自独立')
  })

  it('does not count the same skill three times as a common problem', () => {
    // 重名是 SD009 的事：3 条命中如果来自同一个技能，那只是 1 个技能，不是群体问题。
    const sameName = [result('demo', ['SD009']), result('demo', ['SD009']), result('demo', ['SD009'])]
    expect(clusterFindings(sameName)).toEqual([])
  })

  it('sorts by impact so the biggest root cause comes first', () => {
    const results = [
      result('a', ['SD004', 'SD005']),
      result('b', ['SD004', 'SD005']),
      result('c', ['SD004', 'SD005']),
      result('d', ['SD004']),
    ]
    const clusters = clusterFindings(results)
    expect(clusters.map(item => item.rule)).toEqual(['SD004', 'SD005'])
    expect(clusters.map(item => item.count)).toEqual([4, 3])
  })

  it('says "all of them" when every skill in the cluster shares the prefix', () => {
    const results = [
      result('nature-pdf', ['SD004']),
      result('nature-doc', ['SD004']),
      result('nature-xlsx', ['SD004']),
    ]
    expect(clusterHint(clusterFindings(results)[0]!)).toContain('全部')
  })
})

describe('report: common-problem section', () => {
  const results = [
    result('nature-pdf', ['SD004']),
    result('nature-doc', ['SD004']),
    result('nature-xlsx', ['SD004']),
    result('clean', []),
  ]
  const scan = {
    results,
    errors: 0,
    warnings: 3,
    infos: 0,
    ok: false,
  }

  it('shows a grouped root-cause section in the plain report', () => {
    const markdown = renderLintMarkdown(scan)
    expect(markdown).toContain('共性问题')
    expect(markdown).toContain('SD004')
    expect(markdown).toContain('`nature-pdf`')
    expect(markdown).toContain('同一套模板')
  })

  it('exposes clusters to CI through the JSON output', () => {
    const parsed = JSON.parse(renderLintJson(scan)) as {
      clusters: { rule: string; count: number; commonPrefix: string | null }[]
    }
    expect(parsed.clusters).toHaveLength(1)
    expect(parsed.clusters[0]!.rule).toBe('SD004')
    expect(parsed.clusters[0]!.count).toBe(3)
    expect(parsed.clusters[0]!.commonPrefix).toBe('nature')
  })

  it('tells the user to fix autofixable clusters with one command', () => {
    // CRLF 命中 3 个技能时，逐个点开是浪费时间：一条 --fix 就够。
    const crlf = [
      result('a', ['SD014'], 'info'),
      result('b', ['SD014'], 'info'),
      result('c', ['SD014'], 'info'),
    ]
    const markdown = renderLintMarkdown({
      results: crlf,
      errors: 0,
      warnings: 0,
      infos: 3,
      ok: true,
    })
    expect(markdown).toContain('--only SD014')
  })

  it('shows a calibration warning when the dsh version drifted', () => {
    const markdown = renderLintMarkdown(scan, {
      dshVersion: { version: '1.4.0', calibrated: '0.2.1-rc.2', drifted: true },
    })
    expect(markdown).toContain('⚠️')
    expect(markdown).toContain('1.4.0')
    expect(markdown.indexOf('⚠️')).toBeLessThan(markdown.indexOf('共性问题'))
  })

  it('stays quiet about clusters when every skill is healthy', () => {
    const healthy = { results: [result('clean', [])], errors: 0, warnings: 0, infos: 0, ok: true }
    const markdown = renderLintMarkdown(healthy)
    expect(markdown).not.toContain('共性问题')
    expect((JSON.parse(renderLintJson(healthy)) as { clusters: unknown[] }).clusters).toEqual([])
  })
})
