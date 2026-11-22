/**
 * 审查归档：把每次门禁审查的**完整结论**落盘，供事后回溯。
 *
 * ## 与「日志」的区别
 *
 * 日志回答「发生过什么」，归档回答「当时到底看到了什么」。
 * 所以一条记录里带的是完整的 findings（含 detail 全文）与 RV 提示清单，
 * 而不是一行「拒绝安装」。代价是体积，因此容量与生命周期必须独立管理。
 *
 * ## 存储形态：单个 JSONL
 *
 * 选它是因为追加是 O(1)。修剪需要重写整个文件，但只在超过上限时发生，
 * 20 MB 重写一次可以接受。不用「每包一个文件」——Windows 上大量小文件很慢。
 *
 * ## 三条硬约束
 *
 * 1. **不写本机路径。** 记录里只有包名、版本、registry 地址、规则 id。
 *    审查证据（detail）里可能含包内脚本片段，那是判断依据，需要保留。
 * 2. **写失败只 warn。** 归档是旁路，永远不能因为它让安装失败。
 * 3. **修剪有上界。** 单条 64 KB / 总量 20 MB / 5000 条 / 180 天，
 *    任一超标都从最旧的开始删。不设定时器，写入时顺带检查。
 */
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { dshHome } from './plugins/scan.js'

/** 归档格式版本；字段变更时用它做兼容判断。 */
export const AUDIT_VERSION = 1

/** 单条记录序列化后的上限。畸形包可能带几百条 finding，不能让它撑爆一条。 */
const MAX_ENTRY_BYTES = 64 * 1024
/** 归档文件总大小上限。 */
const MAX_TOTAL_BYTES = 20 * 1024 * 1024
/** 条数上限，与体积上限任一先到即触发修剪。 */
const MAX_ENTRIES = 5000
/** 保留天数。 */
const MAX_AGE_DAYS = 180

/** detail 字段的截断长度：保留足够的判断依据，又不至于被大文件撑满。 */
const DETAIL_LIMIT = 500

/** 审查来源。用于区分「谁发起的这次安装」。 */
export type AuditSource = 'plugin-page' | 'install' | 'cli'

/** 一条命中的高危规则。detail 是当时的判断依据，截断后保留。 */
export interface AuditFinding {
  readonly id: string
  readonly severity: string
  readonly title: string
  readonly detail: string
  readonly where?: string
}

/** 一条 RV 提示（只提示、不参与判定），按需保留。 */
export interface AuditHint {
  readonly id: string
  readonly severity: string
  readonly where?: string
}

/** 一条归档记录。 */
export interface AuditEntry {
  readonly v: number
  /** ISO 8601。 */
  readonly ts: string
  readonly source: AuditSource
  readonly spec: string
  readonly name: string
  readonly version: string
  readonly registry: string
  readonly decision: 'pass' | 'block' | 'error'
  /** 命中高危但按信任清单放行。 */
  readonly trustedOverride?: boolean
  /** decision === 'error' 时的原因类别。 */
  readonly problem?: string
  readonly findings: readonly AuditFinding[]
  readonly hints: readonly AuditHint[]
}

/** 查询条件。全部可选，不传即全部。 */
export interface AuditQuery {
  readonly pkg?: string
  /** 只返回这个时间点之后的记录（ISO 8601）。 */
  readonly since?: string
  readonly limit?: number
}

/** 归档统计。 */
export interface AuditStats {
  readonly count: number
  readonly bytes: number
  readonly oldest?: string
  readonly newest?: string
}

/** 修剪结果。 */
export interface PruneResult {
  readonly removed: number
  readonly kept: number
  readonly freedBytes: number
}

/** 默认归档路径：`$DSH_HOME/skill-doctor/audit.jsonl`，与信任清单同目录。 */
export function auditPath(): string {
  return resolve(dshHome(), 'skill-doctor', 'audit.jsonl')
}

/**
 * 把 GateResult 之类的原始结论转成归档条目。
 *
 * 放在这里而不是 gate.ts：`audit.ts` 不应该反向依赖门禁实现，
 * 所以这里接收的是**形状**而非具体类型（见 `RawVerdict`）。
 */
export interface RawVerdict {
  readonly spec: string
  readonly name: string
  readonly version: string
  readonly registry: string
  readonly decision: 'pass' | 'block' | 'error'
  readonly trustedOverride?: boolean
  readonly problem?: string
  readonly findings: readonly AuditFinding[]
  readonly review: { readonly hints: readonly AuditHint[] }
}

/** 从原始结论构造条目，按上限截断 detail 与提示数量。 */
export function toEntry(raw: RawVerdict, source: AuditSource, now = new Date()): AuditEntry {
  return {
    v: AUDIT_VERSION,
    ts: now.toISOString(),
    source,
    spec: raw.spec,
    name: raw.name,
    version: raw.version,
    registry: raw.registry,
    decision: raw.decision,
    ...raw.trustedOverride === true ? { trustedOverride: true } : {},
    ...raw.problem === undefined ? {} : { problem: raw.problem },
    findings: raw.findings.map(finding => ({
      id: finding.id,
      severity: finding.severity,
      title: finding.title,
      detail: finding.detail.length > DETAIL_LIMIT
        ? `${finding.detail.slice(0, DETAIL_LIMIT)}…`
        : finding.detail,
      ...finding.where === undefined ? {} : { where: finding.where },
    })),
    // RV 提示动辄几十条，归档只留前 20 条——再多也帮不上回溯。
    hints: raw.review.hints.slice(0, 20).map(hint => ({
      id: hint.id,
      severity: hint.severity,
      ...hint.where === undefined ? {} : { where: hint.where },
    })),
  }
}

/**
 * 序列化一条记录，超长时逐级降级。
 *
 * 降级顺序：先砍提示数量，再砍 detail，最后仍然超长就只留结构与结论——
 * 丢弃整条记录比留下一条「看不懂为什么拒绝」的半条更糟。
 */
export function serializeEntry(entry: AuditEntry): string {
  const attempt = (value: AuditEntry): string => `${JSON.stringify(value)}\n`

  let text = attempt(entry)
  if (Buffer.byteLength(text, 'utf8') <= MAX_ENTRY_BYTES) return text

  const lean: AuditEntry = {
    ...entry,
    findings: entry.findings.map(finding => ({ ...finding, detail: finding.detail.slice(0, 120) })),
    hints: entry.hints.slice(0, 5),
  }
  text = attempt(lean)
  if (Buffer.byteLength(text, 'utf8') <= MAX_ENTRY_BYTES) return text

  const minimal: AuditEntry = {
    ...lean,
    findings: lean.findings.map(finding => ({ ...finding, detail: '' })),
    hints: [],
  }
  return attempt(minimal)
}

/** 逐行解析；坏行跳过，不因一条损坏记录让整个归档不可读。 */
export function parseEntries(text: string): AuditEntry[] {
  const out: AuditEntry[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const value: unknown = JSON.parse(trimmed)
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      const candidate = value as Partial<AuditEntry>
      if (typeof candidate.name !== 'string' || typeof candidate.ts !== 'string') continue
      out.push(candidate as AuditEntry)
    } catch {
      continue
    }
  }
  return out
}

/**
 * 按容量上限修剪。
 *
 * 纯函数：输入全部条目与当前时间，输出应保留的部分。这样修剪规则可以
 * 单独测，不必每次造真实文件。
 */
export function pruneEntries(
  entries: readonly AuditEntry[],
  options: { now?: Date; maxEntries?: number; maxBytes?: number; maxAgeDays?: number } = {},
): { kept: AuditEntry[]; removed: number } {
  const now = options.now ?? new Date()
  const maxEntries = options.maxEntries ?? MAX_ENTRIES
  const maxBytes = options.maxBytes ?? MAX_TOTAL_BYTES
  const maxAgeDays = options.maxAgeDays ?? MAX_AGE_DAYS
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000

  // 记录是按时间追加的，所以 [老 → 新] 顺序，从头开始丢弃最省的。
  let kept = entries.filter(entry => {
    const ts = Date.parse(entry.ts)
    return Number.isFinite(ts) && ts >= cutoff
  })

  if (kept.length > maxEntries) kept = kept.slice(kept.length - maxEntries)

  let bytes = kept.reduce((sum, entry) => sum + Buffer.byteLength(serializeEntry(entry), 'utf8'), 0)
  while (bytes > maxBytes && kept.length > 0) {
    bytes -= Buffer.byteLength(serializeEntry(kept[0]!), 'utf8')
    kept = kept.slice(1)
  }

  return { kept, removed: entries.length - kept.length }
}

/**
 * 追加一条记录，必要时修剪。写失败向上抛，由调用方决定只 warn。
 * @param path - 覆盖路径；测试用。
 */
export async function appendEntry(
  entry: AuditEntry,
  path: string = auditPath(),
): Promise<{ pruned: PruneResult }> {
  await mkdir(dirname(path), { recursive: true })
  const line = serializeEntry(entry)
  await appendFile(path, line, 'utf8')

  const size = (await stat(path)).size
  if (size <= MAX_TOTAL_BYTES) return { pruned: { removed: 0, kept: 0, freedBytes: 0 } }

  // 超限才读全文重写；平时不碰，避免每次安装都整文件读一遍。
  const before = await readFile(path, 'utf8')
  const entries = parseEntries(before)
  const { kept, removed } = pruneEntries(entries)
  const rebuilt = kept.map(serializeEntry).join('')
  await writeFile(path, rebuilt, 'utf8')
  return {
    pruned: {
      removed,
      kept: kept.length,
      freedBytes: Buffer.byteLength(before, 'utf8') - Buffer.byteLength(rebuilt, 'utf8'),
    },
  }
}

/**
 * 读归档并按条件过滤。文件不存在返回空数组（不是错误）。
 * @param path - 覆盖路径；测试用。
 */
export async function queryEntries(
  query: AuditQuery = {},
  path: string = auditPath(),
): Promise<AuditEntry[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return []
  }
  let entries = parseEntries(text)

  if (query.pkg !== undefined) {
    const target = query.pkg.toLowerCase()
    entries = entries.filter(entry => entry.name.toLowerCase() === target)
  }
  if (query.since !== undefined) {
    const since = Date.parse(query.since)
    if (Number.isFinite(since)) {
      entries = entries.filter(entry => {
        const ts = Date.parse(entry.ts)
        return Number.isFinite(ts) && ts >= since
      })
    }
  }
  if (query.limit !== undefined && query.limit > 0) {
    entries = entries.slice(-query.limit)
  }
  return entries
}

/** 归档统计。文件不存在时 count 为 0。 */
export async function auditStats(path: string = auditPath()): Promise<AuditStats> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { count: 0, bytes: 0 }
  }
  const entries = parseEntries(text)
  return {
    count: entries.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    ...entries.length === 0 ? {} : { oldest: entries[0]!.ts, newest: entries[entries.length - 1]!.ts },
  }
}

/** 手动修剪。返回释放量与仍保留的条数。 */
export async function pruneFile(path: string = auditPath()): Promise<PruneResult> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { removed: 0, kept: 0, freedBytes: 0 }
  }
  const entries = parseEntries(text)
  const { kept, removed } = pruneEntries(entries)
  const rebuilt = kept.map(serializeEntry).join('')
  if (removed > 0) await writeFile(path, rebuilt, 'utf8')
  return {
    removed,
    kept: kept.length,
    freedBytes: Buffer.byteLength(text, 'utf8') - Buffer.byteLength(rebuilt, 'utf8'),
  }
}
