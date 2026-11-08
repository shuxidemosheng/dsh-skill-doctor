import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config'
import { scanRoot } from '../src/scanner/fs-scan'
import { lintSkills } from '../src/scanner/scan'
import type { Finding, SkillInput, WinnerInfo } from '../src/types'
import { FIXTURES } from './helpers'

async function lintDirs(dirs: readonly string[], config = resolveConfig(undefined)) {
  const skills: SkillInput[] = []
  for (const dir of dirs) {
    const scan = await scanRoot(`${FIXTURES}${dir}`, config.maxFileBytes)
    skills.push(...scan.skills)
  }
  const result = await lintSkills(skills, config)
  return { result, findings: result.results.flatMap(item => item.findings) }
}

function has(findings: readonly Finding[], rule: string): boolean {
  return findings.some(finding => finding.rule === rule)
}

describe('scanner rules', () => {
  it('a healthy skill has no findings', async () => {
    const { result } = await lintDirs(['good-skill'])
    expect(result.results).toHaveLength(1)
    expect(result.results[0]!.findings).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('reports missing frontmatter (SD001)', async () => {
    const { findings } = await lintDirs(['bad-frontmatter'])
    expect(has(findings, 'SD001')).toBe(true)
  })

  it('reports invalid name, short description and invalid invocation (SD002/SD005/SD010)', async () => {
    const { findings } = await lintDirs(['bad-name'])
    expect(has(findings, 'SD002')).toBe(true)
    expect(has(findings, 'SD005')).toBe(true)
    expect(has(findings, 'SD010')).toBe(true)
  })

  it('reports a long description when the limit is lowered (SD004)', async () => {
    const { findings } = await lintDirs(['bad-description'], resolveConfig({ maxDescriptionLength: 60 }))
    expect(has(findings, 'SD004')).toBe(true)
  })

  it('reports a missing resource (SD008)', async () => {
    const { findings } = await lintDirs(['bad-resource'])
    expect(has(findings, 'SD008')).toBe(true)
  })

  it('reports path traversal (SD015)', async () => {
    const { findings } = await lintDirs(['traversal'])
    expect(has(findings, 'SD015')).toBe(true)
  })

  it('reports suspicious instructions (SD012)', async () => {
    const { findings } = await lintDirs(['suspicious'])
    expect(has(findings, 'SD012')).toBe(true)
  })

  it('reports a body over a tiny token budget (SD007)', async () => {
    const { findings } = await lintDirs(['budget'], resolveConfig({ maxBodyTokens: 10 }))
    expect(has(findings, 'SD007')).toBe(true)
  })

  it('reports duplicate names across roots (SD009)', async () => {
    const { findings } = await lintDirs(['dup-a', 'dup-b'])
    expect(findings.filter(finding => finding.rule === 'SD009')).toHaveLength(2)
  })

  it('honours rule off overrides and severity thresholds', async () => {
    const off = resolveConfig({ rules: { SD005: 'off' } })
    const without = await lintDirs(['bad-name'], off)
    expect(has(without.findings, 'SD005')).toBe(false)

    const errorsOnly = resolveConfig({ severityThreshold: 'error' })
    const onlyErrors = await lintDirs(['bad-name'], errorsOnly)
    expect(onlyErrors.findings.every(finding => finding.severity === 'error')).toBe(true)
  })
})

describe('SD009 with a registry winner', () => {
  async function dupSkills(): Promise<SkillInput[]> {
    const config = resolveConfig(undefined)
    const skills: SkillInput[] = []
    for (const dir of ['dup-a', 'dup-b']) {
      skills.push(...(await scanRoot(`${FIXTURES}${dir}`, config.maxFileBytes)).skills)
    }
    return skills
  }

  it('names the winner but keeps exactly two SD009 findings', async () => {
    const skills = await dupSkills()
    const winner = skills[0]!
    const info: WinnerInfo = {
      name: winner.name,
      provider: winner.provider,
      source: winner.source,
      ...winner.path === undefined ? {} : { path: winner.path },
    }
    const result = await lintSkills(skills, resolveConfig(undefined), new Map([[winner.name, info]]))
    const findings = result.results.flatMap(item => item.findings).filter(item => item.rule === 'SD009')
    expect(findings).toHaveLength(2)
    expect(findings.some(item => item.message.includes('registry 实际加载的是'))).toBe(true)
  })

  it('keeps the candidate wording when no registry view is available', async () => {
    const skills = await dupSkills()
    const result = await lintSkills(skills, resolveConfig(undefined))
    const findings = result.results.flatMap(item => item.findings).filter(item => item.rule === 'SD009')
    expect(findings).toHaveLength(2)
    expect(findings.every(item => item.message.includes('dsh 只会加载其中一个'))).toBe(true)
  })
})
