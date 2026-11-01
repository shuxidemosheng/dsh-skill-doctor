import { describe, expect, it } from 'vitest'
import {
  collectActivity,
  currentEntry,
  describeEntry,
  emptyUsage,
  loadUsage,
  mergeActivity,
  recent,
  recordSession,
  recordSkillLoad,
  saveUsage,
  skillLoadNames,
  summarize,
  topSkills,
  USAGE_MAX_SKILLS,
  usageSummary,
  type ActivityEntry,
} from '../src/activity'

/** 造一个最简会话快照；dsh 的 chat snapshot 结构在不同版本里是对象或数组。 */
function snapshotWith(nodes: Record<string, unknown>): unknown {
  return { nodes }
}

/** 一条 assistant 消息里的工具调用。 */
function callBlock(name: string, callId: string, argsRaw: string): unknown {
  return { call: { name, callId, argsRaw } }
}

describe('collectActivity', () => {
  it('classifies skill loads, our own tools, and plain tools', () => {
    const entries = collectActivity(snapshotWith({
      a1: { kind: 'assistant', blocks: [callBlock('skill', 'c1', '{"name":"nature-citation"}')] },
      a2: { kind: 'assistant', blocks: [callBlock('skill_doctor', 'c2', '{"name":"typst-author"}')] },
      a3: { kind: 'assistant', blocks: [callBlock('pwsh', 'c3', '{"command":"npm test"}')] },
    }))

    expect(entries.map(entry => entry.kind)).toEqual(['skill', 'plugin', 'tool'])
    expect(entries.map(entry => entry.detail)).toEqual(['nature-citation', 'typst-author', 'npm test'])
  })

  it('pairs a call with its result', () => {
    const entries = collectActivity(snapshotWith({
      a1: { kind: 'assistant', blocks: [callBlock('skill', 'c1', '{"name":"a"}')] },
      r1: { kind: 'tool-result', callId: 'c1' },
      a2: { kind: 'assistant', blocks: [callBlock('skill', 'c2', '{"name":"b"}')] },
    }))

    expect(entries[0]!.done).toBe(true)
    expect(entries[1]!.done).toBe(false)
  })

  it('reads the legacy snapshot shape and the array shape', () => {
    const legacy = { legacy: { nodes: { a1: { kind: 'assistant', blocks: [callBlock('read', 'c1', '{"path":"x.md"}')] } } } }
    expect(collectActivity(legacy)).toHaveLength(1)

    const array = { nodes: [{ kind: 'assistant', blocks: [callBlock('read', 'c1', '{"path":"x.md"}')] }] }
    expect(collectActivity(array)).toHaveLength(1)
  })

  it('accepts a bare call block without the nested call field', () => {
    const entries = collectActivity(snapshotWith({
      a1: { kind: 'assistant', blocks: [{ name: 'grep', callId: 'c9', argsRaw: '{"pattern":"TODO"}' }] },
    }))
    expect(entries[0]).toMatchObject({ tool: 'grep', detail: 'TODO' })
  })

  it('deduplicates a call that appears twice', () => {
    const block = callBlock('skill', 'c1', '{"name":"a"}')
    const entries = collectActivity(snapshotWith({
      a1: { kind: 'assistant', blocks: [block] },
      a2: { kind: 'assistant', blocks: [block] },
    }))
    expect(entries).toHaveLength(1)
  })

  it('survives malformed arguments and unknown shapes', () => {
    const entries = collectActivity(snapshotWith({
      a1: { kind: 'assistant', blocks: [callBlock('pwsh', 'c1', 'not json at all')] },
      a2: { kind: 'assistant', blocks: [{ call: { name: 'x' } }] }, // 没有 callId，跳过
      a3: null,
      a4: { kind: 'user' },
    }))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.detail).toBe('not json at all')
  })

  it('returns nothing for an empty or missing snapshot', () => {
    expect(collectActivity(undefined)).toEqual([])
    expect(collectActivity({})).toEqual([])
    expect(collectActivity({ nodes: {} })).toEqual([])
  })

  it('clips a very long argument instead of breaking the panel', () => {
    const entries = collectActivity(snapshotWith({
      a1: { kind: 'assistant', blocks: [callBlock('pwsh', 'c1', JSON.stringify({ command: 'x'.repeat(300) }))] },
    }))
    expect(entries[0]!.detail.length).toBeLessThanOrEqual(61)
    expect(entries[0]!.detail.endsWith('…')).toBe(true)
  })
})

describe('mergeActivity', () => {
  const a: ActivityEntry = { callId: 'c1', tool: 'skill', kind: 'skill', detail: 'one', done: false }

  it('appends only the calls it has not seen', () => {
    const merged = mergeActivity([a], [a, { ...a, callId: 'c2', detail: 'two' }])
    expect(merged.map(entry => entry.callId)).toEqual(['c1', 'c2'])
  })

  it('keeps entries that already scrolled out of the window', () => {
    // 会话窗口会滑动，早期调用从快照里消失；不保留的话计数会倒退。
    const merged = mergeActivity([a], [])
    expect(merged).toHaveLength(1)
  })

  it('updates a call in place when its result arrives', () => {
    const merged = mergeActivity([a], [{ ...a, done: true }])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.done).toBe(true)
  })
})

describe('summarize and friends', () => {
  const entries: ActivityEntry[] = [
    { callId: 'c1', tool: 'skill', kind: 'skill', detail: 'a', done: true },
    { callId: 'c2', tool: 'skill', kind: 'skill', detail: 'b', done: true },
    { callId: 'c3', tool: 'skill_doctor', kind: 'plugin', detail: '', done: true },
    { callId: 'c4', tool: 'pwsh', kind: 'tool', detail: 'npm test', done: false },
  ]

  it('counts by kind', () => {
    expect(summarize(entries)).toEqual({ skills: 2, plugin: 1, tools: 1 })
  })

  it('keeps only the most recent entries', () => {
    expect(recent(entries, 2).map(entry => entry.callId)).toEqual(['c3', 'c4'])
    expect(recent(entries, 99)).toHaveLength(4)
  })

  it('picks the running call as the current action', () => {
    expect(currentEntry(entries)?.callId).toBe('c4')
    expect(currentEntry(entries.slice(0, 3))).toBeUndefined()
  })

  it('describes a skill load in plain words', () => {
    expect(describeEntry(entries[0]!)).toBe('读入技能 a')
    expect(describeEntry(entries[3]!)).toBe('pwsh · npm test')
  })
})

// ---------- 跨会话使用统计 ----------

/** localStorage 替身：Map 存储，行为与真的一致（可能抛错的场景单独模拟）。 */
function fakeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: key => map.get(key) ?? null,
    key: index => [...map.keys()][index] ?? null,
    removeItem: key => { map.delete(key) },
    setItem: (key, value) => { map.set(key, value) },
  }
}

describe('usage stats (cross-session)', () => {
  it('counts each skill load and remembers the last time', () => {
    let usage = emptyUsage()
    usage = recordSkillLoad(usage, 'a', 's1', new Date('2026-11-01T01:00:00Z'))
    usage = recordSkillLoad(usage, 'a', 's1', new Date('2026-11-02T01:00:00Z'))
    usage = recordSkillLoad(usage, 'b', 's2', new Date('2026-11-03T01:00:00Z'))
    expect(usage.skills.a).toEqual({ loads: 2, lastUsed: '2026-11-02T01:00:00.000Z' })
    const summary = usageSummary(usage)
    expect(summary).toEqual({ totalLoads: 3, distinctSkills: 2, sessions: 2 })
  })

  it('ranks by loads, then by name', () => {
    let usage = emptyUsage()
    for (let i = 0; i < 3; i++) usage = recordSkillLoad(usage, 'b', undefined)
    for (let i = 0; i < 5; i++) usage = recordSkillLoad(usage, 'a', undefined)
    usage = recordSkillLoad(usage, 'c', undefined)
    expect(topSkills(usage, 10).map(item => item.name)).toEqual(['a', 'b', 'c'])
    expect(topSkills(usage, 2).map(item => item.name)).toEqual(['a', 'b'])
  })

  it('caps the skill table so names cannot grow forever', () => {
    let usage = emptyUsage()
    for (let i = 0; i < USAGE_MAX_SKILLS + 30; i++) usage = recordSkillLoad(usage, `skill-${i}`, undefined)
    expect(Object.keys(usage.skills)).toHaveLength(USAGE_MAX_SKILLS)
    // 被裁掉的应该是最少使用的：30 个多出来的名字消失，留下的都有 1 次。
    expect(Object.values(usage.skills).every(usage => usage.loads === 1)).toBe(true)
  })

  it('records a session id once', () => {
    let usage = emptyUsage()
    usage = recordSession(usage, 's1')
    usage = recordSession(usage, 's1')
    usage = recordSession(usage, 's2')
    expect(usageSummary(usage).sessions).toBe(2)
  })

  it('round-trips through storage', () => {
    const storage = fakeStorage()
    let usage = emptyUsage()
    usage = recordSkillLoad(usage, 'a', 's1', new Date('2026-11-01T01:00:00Z'))
    usage = recordSession(usage, 's1')
    saveUsage(storage, usage)
    expect(loadUsage(storage)).toEqual(usage)
  })

  it('falls back to an empty record instead of throwing', () => {
    expect(loadUsage(undefined)).toEqual(emptyUsage())
    const broken = fakeStorage()
    broken.setItem('dsh-skill-doctor:usage', '{ not json')
    expect(loadUsage(broken)).toEqual(emptyUsage())
    const wrongVersion = fakeStorage()
    wrongVersion.setItem('dsh-skill-doctor:usage', JSON.stringify({ version: 99, skills: {} }))
    expect(loadUsage(wrongVersion)).toEqual(emptyUsage())
    const garbageValues = fakeStorage()
    garbageValues.setItem('dsh-skill-doctor:usage', JSON.stringify({ version: 1, skills: { a: { loads: 'many' } } }))
    expect(loadUsage(garbageValues).skills).toEqual({})
  })

  it('picks skill loads with a name out of activities', () => {
    const loaded = collectActivity(snapshotWith({
      a1: { kind: 'assistant', blocks: [callBlock('skill', 'c1', '{"name":"nature-citation"}')] },
      a2: { kind: 'assistant', blocks: [callBlock('skill', 'c2', '{}')] },
      a3: { kind: 'assistant', blocks: [callBlock('skill_doctor', 'c3', '{"name":"x"}')] },
    }))
    // 没带名字的不计（不知道是哪个技能），本插件的工具更不算。
    expect(skillLoadNames(loaded)).toEqual(['nature-citation'])
  })
})
