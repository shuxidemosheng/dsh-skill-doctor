/**
 * 信任清单：用户明确说「我知道这个包有风险，仍然要装」的包名集合。
 *
 * ## 为什么要它
 *
 * 门禁的价值是拦住误装，但它不该替用户做最终决定。GT 规则是结构性启发式，
 * 一定会误报（例如某个包确实需要 postinstall 下载原生二进制）；也一定存在
 * 「我就是要装」的场景。没有出口的门禁只有两种结局：被卸载，或被全局关掉。
 *
 * 信任清单是有出口的门禁：放行是**按包**记的、有成本（要主动执行命令）、
 * 可审计（带时间）、可撤销（`/doctor untrust`），而且门禁仍然完整审查并
 * 在报告里标出「命中了什么、按信任放行」。
 *
 * ## 三个设计选择
 *
 * 1. **按包名，不绑版本。** 信任针对的是「这个包」，不是「这一次发布」。
 *    绑版本会逼用户每升一次级就重新信任一次，最后必然变成懒得看就点同意。
 * 2. **全局一份，不按 profile 分。** 与病历（`record-<profile>.json`）相反：
 *    病历记录的是「这个 profile 里的技能快照」，天然要分；信任是「我信这个
 *    包」，换 profile 不该重记一遍。
 * 3. **独立 JSON 文件，不写进 `cordis.patch.yml`。** 写配置要重启才生效，
 *    而信任的典型用法是「被拦住 → 加信任 → 立刻重试」。文件每次安装时现读。
 *
 * ## 文件坏了怎么办
 *
 * 一律按「空清单」处理，绝不抛错。清单读不出来最多是门禁回到默认行为
 * （该拦的照拦），而抛错会让安装直接失败——那比误拦更糟。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { dshHome } from './plugins/scan.js'

/** 清单文件格式版本；以后字段变更时用它做兼容判断。 */
const FORMAT_VERSION = 1

/** 清单里的一条。 */
export interface TrustEntry {
  /** 包名（不含版本）。scoped 包保留 `@scope/name` 原样。 */
  readonly pkg: string
  /** 记录时间，ISO 8601。用于事后回答「什么时候起信任的」。 */
  readonly at: string
  /** 可选备注，例如「需要 postinstall 下载原生模块」。 */
  readonly reason?: string
}

/** 清单文件。 */
export interface TrustFile {
  readonly version: number
  readonly trusted: readonly TrustEntry[]
}

const EMPTY: TrustFile = { version: FORMAT_VERSION, trusted: [] }

/**
 * 清单路径：`$DSH_HOME/skill-doctor/trusted.json`。
 *
 * 与病历同目录，便于一起备份或一起清理；但文件名不带 profile，
 * 因为信任是跨 profile 的。
 */
export function trustPath(): string {
  return resolve(dshHome(), 'skill-doctor', 'trusted.json')
}

/** 结构校验：只认 `{ trusted: [{ pkg: string }] }` 里合法的条目。 */
function parseTrustFile(raw: unknown): TrustFile {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY
  const list = (raw as { trusted?: unknown }).trusted
  if (!Array.isArray(list)) return EMPTY
  const trusted: TrustEntry[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const record = item as { pkg?: unknown; at?: unknown; reason?: unknown }
    if (typeof record.pkg !== 'string' || record.pkg.length === 0) continue
    trusted.push({
      pkg: record.pkg,
      at: typeof record.at === 'string' ? record.at : '',
      ...typeof record.reason === 'string' && record.reason.length > 0 ? { reason: record.reason } : {},
    })
  }
  return { version: FORMAT_VERSION, trusted }
}

/**
 * 读清单。文件不存在、JSON 坏了、结构不对，一律返回空清单。
 * @param path - 覆盖路径；测试用，生产不传。
 */
export async function loadTrust(path: string = trustPath()): Promise<TrustFile> {
  try {
    return parseTrustFile(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return EMPTY
  }
}

/** 写清单。先建目录——第一次用时 `skill-doctor/` 还不存在。 */
export async function saveTrust(file: TrustFile, path: string = trustPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
}

/** 供门禁使用的包名列表。 */
export function trustedNames(file: TrustFile): readonly string[] {
  return file.trusted.map(entry => entry.pkg)
}

/** 包名是否已在清单里（大小写不敏感：npm 包名本来就全小写）。 */
export function isTrusted(file: TrustFile, pkg: string): boolean {
  const target = pkg.trim().toLowerCase()
  return file.trusted.some(entry => entry.pkg.toLowerCase() === target)
}

/**
 * 加入清单。已存在则不重复添加（保留原来的时间和备注）。
 * @returns 写入后的清单，以及本次是否真的新增。
 */
export async function addTrust(
  pkg: string,
  reason?: string,
  path: string = trustPath(),
): Promise<{ file: TrustFile; added: boolean }> {
  const name = pkg.trim()
  if (name.length === 0) throw new Error('package name is empty')
  const current = await loadTrust(path)
  if (isTrusted(current, name)) return { file: current, added: false }
  const entry: TrustEntry = {
    pkg: name,
    at: new Date().toISOString(),
    ...reason === undefined || reason.trim().length === 0 ? {} : { reason: reason.trim() },
  }
  const next: TrustFile = { version: FORMAT_VERSION, trusted: [...current.trusted, entry] }
  await saveTrust(next, path)
  return { file: next, added: true }
}

/**
 * 从清单移除。
 * @returns 写入后的清单，以及本次是否真的移除了某条。
 */
export async function removeTrust(
  pkg: string,
  path: string = trustPath(),
): Promise<{ file: TrustFile; removed: boolean }> {
  const target = pkg.trim().toLowerCase()
  const current = await loadTrust(path)
  const kept = current.trusted.filter(entry => entry.pkg.toLowerCase() !== target)
  const removed = kept.length !== current.trusted.length
  if (!removed) return { file: current, removed: false }
  const next: TrustFile = { version: FORMAT_VERSION, trusted: kept }
  await saveTrust(next, path)
  return { file: next, removed: true }
}
