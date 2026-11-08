/** 「来源与遮蔽」视图：条件渲染、胜负判定、路径脱敏与三种输出口径。 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatProvenancePath } from '../src/scanner/text'
import {
  buildProvenance,
  provenanceJson,
  provenanceMarkdownLines,
  provenancePlainLines,
} from '../src/tools/provenance'
import type { SkillInput, WinnerInfo } from '../src/types'

/** 造一条最小技能输入；path 直接决定根目录分组与胜负匹配。 */
function skill(name: string, provider: string, source: string, path?: string): SkillInput {
  return {
    name,
    description: 'demo',
    content: 'body',
    provider,
    source,
    ...path === undefined ? {} : { path },
    invocation: { modelInvocable: true, userInvocable: true },
  }
}

/** 把技能列表当成一次 snapshot 的获胜者视图。 */
function winnersOf(...skills: SkillInput[]): Map<string, WinnerInfo> {
  const map = new Map<string, WinnerInfo>()
  for (const item of skills) {
    map.set(item.name, {
      name: item.name,
      provider: item.provider,
      source: item.source,
      ...item.path === undefined ? {} : { path: item.path },
    })
  }
  return map
}

const HOME_SKILL = join(homedir(), '.claude', 'skills', 'demo', 'SKILL.md')
const PROJECT_SKILL = join(homedir(), 'proj', '.dsh', 'skills', 'demo', 'SKILL.md')

describe('buildProvenance: conditional rendering', () => {
  it('stays silent for a single provider with no duplicate names', () => {
    const view = buildProvenance([
      skill('a', 'filesystem', 'filesystem', HOME_SKILL),
      skill('b', 'filesystem', 'filesystem', HOME_SKILL),
    ])
    expect(view).toBeUndefined()
  })

  it('appears when more than one provider is present', () => {
    const view = buildProvenance([
      skill('a', 'filesystem', 'filesystem', HOME_SKILL),
      skill('b', 'filesystem', 'filesystem', HOME_SKILL),
      skill('c', 'skill-doctor-compat', 'claude-code', PROJECT_SKILL),
    ])
    expect(view).toBeDefined()
    expect(view!.byProvider).toEqual([
      { provider: 'filesystem', count: 2 },
      { provider: 'skill-doctor-compat', count: 1 },
    ])
  })

  it('groups SKILL.md paths by their root, not by each skill folder', () => {
    const view = buildProvenance([
      skill('a', 'filesystem', 'filesystem', HOME_SKILL),
      skill('b', 'skill-doctor-compat', 'claude-code', join(homedir(), '.claude', 'skills', 'other', 'SKILL.md')),
    ])
    expect(view!.byRoot).toEqual([{ root: '~/.claude/skills', count: 2 }])
  })
})

describe('buildProvenance: shadow verdict', () => {
  it('names the winner when registry path matches one candidate', () => {
    const a = skill('demo', 'filesystem', 'filesystem', HOME_SKILL)
    const b = skill('demo', 'filesystem', 'filesystem', PROJECT_SKILL)
    const view = buildProvenance([a, b], winnersOf(a))
    expect(view!.shadows).toHaveLength(1)
    expect(view!.shadows[0]!.resolved).toBe(true)
    expect(view!.shadows[0]!.winner).toContain('~/.claude/skills/demo/SKILL.md')
    expect(view!.shadows[0]!.shadowed[0]).toContain('proj/.dsh/skills/demo/SKILL.md')
  })

  it('keeps the candidate wording when no winners are available', () => {
    const a = skill('demo', 'filesystem', 'filesystem', HOME_SKILL)
    const b = skill('demo', 'filesystem', 'filesystem', PROJECT_SKILL)
    const view = buildProvenance([a, b])
    expect(view!.shadows[0]!.resolved).toBe(false)
    expect(view!.shadows[0]!.winner).toBeUndefined()
    expect(provenancePlainLines(view!).join('\n')).toContain('未判定胜出者，以 registry 为准')
  })

  it('degrades when the winner path matches no candidate (ad-hoc root)', () => {
    const a = skill('demo', 'filesystem', 'filesystem', HOME_SKILL)
    const b = skill('demo', 'filesystem', 'filesystem', PROJECT_SKILL)
    const stray = skill('demo', 'dsh-filesystem', 'dsh', join(homedir(), 'elsewhere', 'demo', 'SKILL.md'))
    const view = buildProvenance([a, b], winnersOf(stray))
    expect(view!.shadows[0]!.resolved).toBe(false)
  })
})

describe('formatProvenancePath: no machine-specific absolute paths', () => {
  it('folds the home directory into ~', () => {
    expect(formatProvenancePath(HOME_SKILL)).toContain('~/.claude/skills/demo/SKILL.md')
  })

  it('folds a project root into <项目>', () => {
    const path = '/workspace/project/.dsh/skills/demo/SKILL.md'
    expect(formatProvenancePath(path, '/workspace/project')).toBe('<项目>/.dsh/skills/demo/SKILL.md')
  })

  it('drops the drive letter and keeps only the last two segments', () => {
    const path = 'Z:/shared-workspace/test-skills/demo/SKILL.md'
    const folded = formatProvenancePath(path)
    expect(folded).toBe('demo/SKILL.md')
    expect(folded).not.toContain('Z:')
    expect(folded).not.toContain('shared-workspace')
  })

  it('never leaks the real home path in any of the three outputs', () => {
    const a = skill('demo', 'filesystem', 'filesystem', HOME_SKILL)
    const b = skill('demo', 'skill-doctor-compat', 'claude-code', PROJECT_SKILL)
    const view = buildProvenance([a, b], winnersOf(a))!
    const all = [
      provenancePlainLines(view).join('\n'),
      provenanceMarkdownLines(view).join('\n'),
      JSON.stringify(provenanceJson(view)),
    ].join('\n')
    expect(all).not.toContain(homedir())
    expect(all).not.toMatch(/[A-Za-z]:[\\/]/)
  })
})

describe('renderers', () => {
  const view = buildProvenance([
    skill('a', 'filesystem', 'filesystem', HOME_SKILL),
    skill('demo', 'skill-doctor-compat', 'claude-code', PROJECT_SKILL),
    skill('demo', 'filesystem', 'filesystem', HOME_SKILL),
  ])!

  it('plain text uses an indented list, never a Markdown table', () => {
    const lines = provenancePlainLines(view)
    expect(lines[0]).toBe('来源与遮蔽')
    expect(lines.join('\n')).toContain('· 按来源：')
    expect(lines.join('\n')).not.toContain('|')
  })

  it('markdown and JSON describe the same shadow groups', () => {
    const md = provenanceMarkdownLines(view).join('\n')
    const json = provenanceJson(view) as { shadows: unknown[] }
    expect(md).toContain('## 来源与遮蔽')
    expect(json.shadows).toHaveLength(view.shadows.length)
  })
})
