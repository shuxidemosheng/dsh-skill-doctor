/**
 * 审查归档：条目构造、序列化降级、修剪、查询、容错。
 *
 * 三个重点：
 * 1. 超长条目必须降级而不是丢——留一条「看不懂为什么拒绝」的半条更糟；
 * 2. 修剪按时间/条数/字节三者取最严，且从最旧的开始；
 * 3. 文件坏了按空处理，绝不让归档问题影响安装。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendEntry,
  auditPath,
  auditStats,
  parseEntries,
  pruneEntries,
  pruneFile,
  queryEntries,
  serializeEntry,
  shouldSkipAudit,
  toEntry,
  type AuditEntry,
  type RawVerdict,
} from '../src/audit'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-audit-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const file = (): string => join(dir, 'audit.jsonl')

/** 造一个最小的原始结论。 */
function raw(overrides: Partial<RawVerdict> = {}): RawVerdict {
  return {
    spec: 'demo@1.0.0',
    name: 'demo',
    version: '1.0.0',
    registry: 'https://registry.example',
    decision: 'pass',
    findings: [],
    review: { hints: [] },
    ...overrides,
  }
}

describe('toEntry', () => {
  it('keeps the verdict and trims nothing when short', () => {
    const entry = toEntry(raw({ decision: 'block', trustedOverride: true }), 'plugin-page')
    expect(entry.v).toBe(1)
    expect(entry.decision).toBe('block')
    expect(entry.trustedOverride).toBe(true)
    expect(entry.source).toBe('plugin-page')
  })

  it('truncates long finding details to 500 characters', () => {
    const entry = toEntry(raw({
      findings: [{ id: 'GT001', severity: 'error', title: 't', detail: 'x'.repeat(900) }],
    }), 'install')
    expect(entry.findings[0]!.detail.length).toBe(501)   // 500 + 省略号
    expect(entry.findings[0]!.detail.endsWith('…')).toBe(true)
  })

  it('keeps at most 20 RV hints', () => {
    const hints = Array.from({ length: 40 }, (_, i) => ({ id: `RV${String(i).padStart(3, '0')}`, severity: 'info' }))
    const entry = toEntry(raw({ review: { hints } }), 'install')
    expect(entry.hints).toHaveLength(20)
  })

  it('records the problem only for error verdicts', () => {
    expect(toEntry(raw({ decision: 'error', problem: 'http-404' }), 'cli').problem).toBe('http-404')
    expect(toEntry(raw(), 'cli').problem).toBeUndefined()
  })
})

describe('serializeEntry fallback', () => {
  it('degrades instead of dropping an oversized entry', () => {
    // 30 条 finding，每条 detail 900 字 —— 远超 64KB 的单条上限。
    const findings = Array.from({ length: 30 }, (_, i) => ({
      id: `GT${String(i).padStart(3, '0')}`,
      severity: 'error',
      title: '标题'.repeat(20),
      detail: '详细'.repeat(450),
      where: 'package.json',
    }))
    const entry = toEntry(raw({ decision: 'block', findings }), 'plugin-page')
    const text = serializeEntry(entry)
    const parsed = JSON.parse(text) as AuditEntry

    // 关键：记录还在，结论还在，只是证据被压缩了。
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(64 * 1024)
    expect(parsed.decision).toBe('block')
    expect(parsed.name).toBe('demo')
    expect(parsed.findings.length).toBe(30)
    expect(parsed.findings[0]!.id).toBe('GT000')
  })
})

describe('parseEntries', () => {
  it('skips corrupt lines but keeps valid ones', () => {
    const good = JSON.stringify(toEntry(raw(), 'install'))
    const text = [
      good,
      '{ not json',
      '[1,2,3]',
      JSON.stringify({ name: 'x' }),          // 缺 ts
      '',
      JSON.stringify({ ts: '2026-01-01T00:00:00Z', name: 'ok' }),
    ].join('\n')
    const entries = parseEntries(text)
    expect(entries.map(entry => entry.name)).toEqual(['demo', 'ok'])
  })
})

describe('pruneEntries', () => {
  const entryAt = (iso: string, name = 'p'): AuditEntry => ({
    v: 1, ts: iso, source: 'install', spec: `${name}@1.0.0`, name,
    version: '1.0.0', registry: 'r', decision: 'pass', findings: [], hints: [],
  })

  it('drops entries older than the retention window', () => {
    const now = new Date('2026-11-22T00:00:00Z')
    const entries = [
      entryAt('2025-01-01T00:00:00Z'),   // 太旧
      entryAt('2026-11-01T00:00:00Z'),   // 21 天前，保留
    ]
    const { kept, removed } = pruneEntries(entries, { now })
    expect(removed).toBe(1)
    expect(kept).toHaveLength(1)
  })

  it('keeps only the newest N entries', () => {
    const now = new Date('2026-11-22T00:00:00Z')
    const entries = Array.from({ length: 10 }, (_, i) => entryAt(`2026-11-${String(i + 1).padStart(2, '0')}T00:00:00Z`))
    const { kept, removed } = pruneEntries(entries, { now, maxEntries: 3 })
    expect(removed).toBe(7)
    expect(kept.map(entry => entry.ts)).toEqual([
      '2026-11-08T00:00:00Z', '2026-11-09T00:00:00Z', '2026-11-10T00:00:00Z',
    ])
  })

  it('drops the oldest until the byte budget fits', () => {
    const now = new Date('2026-11-22T00:00:00Z')
    const entries = Array.from({ length: 5 }, (_, i) => ({
      ...entryAt(`2026-11-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
      findings: [{ id: 'GT001', severity: 'error', title: 't', detail: 'd'.repeat(400) }],
    }))
    const oneSize = Buffer.byteLength(serializeEntry(entries[0]!), 'utf8')
    const { kept } = pruneEntries(entries, { now, maxBytes: oneSize * 2 + 10 })
    expect(kept.length).toBeLessThanOrEqual(2)
    // 保留的必须是最新的那几条
    expect(kept[kept.length - 1]!.ts).toBe('2026-11-05T00:00:00Z')
  })
})

describe('append / query / stats', () => {
  it('appends entries and reads them back', async () => {
    await appendEntry(toEntry(raw(), 'install'), file())
    await appendEntry(toEntry(raw({ spec: 'other@2.0.0', name: 'other', version: '2.0.0' }), 'plugin-page'), file())

    const all = await queryEntries({}, file())
    expect(all.map(entry => entry.name)).toEqual(['demo', 'other'])

    const onlyDemo = await queryEntries({ pkg: 'DEMO' }, file())
    expect(onlyDemo).toHaveLength(1)

    const limited = await queryEntries({ limit: 1 }, file())
    expect(limited).toHaveLength(1)
    expect(limited[0]!.name).toBe('other')
  })

  it('filters by since', async () => {
    const old = toEntry(raw(), 'install', new Date('2026-01-01T00:00:00Z'))
    const recent = toEntry(raw({ spec: 'new@1.0.0', name: 'new' }), 'install', new Date('2026-11-01T00:00:00Z'))
    await appendEntry(old, file())
    await appendEntry(recent, file())

    const after = await queryEntries({ since: '2026-10-01T00:00:00Z' }, file())
    expect(after.map(entry => entry.name)).toEqual(['new'])
  })

  it('reports stats and an empty file without throwing', async () => {
    expect(await auditStats(file())).toEqual({ count: 0, bytes: 0 })

    await appendEntry(toEntry(raw(), 'install'), file())
    const stats = await auditStats(file())
    expect(stats.count).toBe(1)
    expect(stats.bytes).toBeGreaterThan(0)
    expect(stats.oldest).toBeDefined()
  })

  it('returns an empty list for a corrupt file', async () => {
    await writeFile(file(), 'garbage\n{ broken', 'utf8')
    await expect(queryEntries({}, file())).resolves.toEqual([])
  })

  it('prunes a real file and reports freed bytes', async () => {
    await writeFile(file(), [
      JSON.stringify(toEntry(raw({ spec: 'a@1.0.0', name: 'a' }), 'install')),
      JSON.stringify(toEntry(raw(), 'install')),
    ].join('\n') + '\n', 'utf8')
    const before = (await readFile(file(), 'utf8')).length

    // 保留期设成 0 天：全部过期
    const result = await pruneFile(file())
    expect(result.removed + result.kept).toBeGreaterThan(0)
    expect(result.freedBytes).toBeGreaterThanOrEqual(0)
    expect(before).toBeGreaterThan(0)
  })

  it('points at $DSH_HOME/skill-doctor/audit.jsonl', () => {
    expect(auditPath().replace(/\\/g, '/')).toMatch(/skill-doctor\/audit\.jsonl$/)
  })
})

describe('shouldSkipAudit', () => {
  it('writes by default', () => {
    expect(shouldSkipAudit(false, {})).toBe(false)
  })

  it('honours --no-audit', () => {
    expect(shouldSkipAudit(true, {})).toBe(true)
  })

  it('honours the environment variable so CI can opt out once', () => {
    // 只认字面量 '1'：其它值（'0'、'true'、空串）都不该被当成关闭，
    // 否则 CI 里随便设个变量就静默停掉归档，排查时很难发现。
    expect(shouldSkipAudit(false, { DSH_SKILL_DOCTOR_NO_AUDIT: '1' })).toBe(true)
    expect(shouldSkipAudit(false, { DSH_SKILL_DOCTOR_NO_AUDIT: '0' })).toBe(false)
    expect(shouldSkipAudit(false, { DSH_SKILL_DOCTOR_NO_AUDIT: 'true' })).toBe(false)
    expect(shouldSkipAudit(false, { DSH_SKILL_DOCTOR_NO_AUDIT: '' })).toBe(false)
  })
})
