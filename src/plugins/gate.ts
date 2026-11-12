/**
 * 安装门禁：在「包还没落盘」的时候审查 tarball，命中高危规则就拒绝安装。
 *
 * ## 这个模块在整条链路里的位置
 *
 * dsh 的 `installBundle` 把「下载 + 解压到 profile/node_modules + 写 package.json /
 * pnpm-lock.yaml + 应用 patch」合成一次 `pnpm add`，中间没有可暂停的点。所以想
 * 做到「审过才装」，只能**自己先把 tarball 取回来审一遍**，通过后再调官方安装。
 * 代价是包会下载两次（门禁一次、installBundle 一次），换来的好处是回滚、registry
 * 回退、peer 兼容性检查仍由官方负责，不用重造。
 *
 * ## 三条硬边界
 *
 * 1. **不落盘、不执行被审包的代码。** tarball 在内存里用 `zlib.gunzipSync` 解压，
 *    手写 tar 解析读出文本；不写临时目录，也不调用包内的任何脚本。没有临时目录，
 *    自然也不涉及删除操作（用户明确要求删除必须先确认）。
 * 2. **fail closed。** 取不到包、解析失败、网络出错，一律返回 `decision: 'error'`，
 *    **绝不当成通过**。门禁最危险的失败模式就是「查不了就放行」。
 * 3. **插件页也能覆盖。** 插件页走 `plugin-manager` 的同一个服务实例，包装
 *    `installBundle` 就能拦到它（独立组件行 `skill-doctor-gate`）。`dsh plugin add`
 *    与手改 `package.json` 后的 `pnpm install` 是包管理器的写入路径，管不着。
 *
 * ## 与 RV 规则的关系
 *
 * RV001–RV012 是 `info`/`warn` 的**提示**，正常打包产物几乎必然命中 `eval`、
 * `child_process` 之类，拿它们直接阻断会挡掉大量正常插件。因此门禁另立一组
 * GT001–GT003，只覆盖结构明确、误报可控的高危信号，命中才 `error`。
 * 完整的 RV 报告仍会一并输出，供人工判断，但不参与拒绝。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { parse as parseYaml } from 'yaml'
import type { Context } from '@deepseek-ai/cordis'
import {
  evaluateRiskHints,
  TEXT_EXT,
  type ReviewResult,
  type RiskHint,
  type TextFile,
} from './review.js'
import { parsePatchIds } from './scan.js'
import { loadTrust, trustedNames } from '../trust.js'

/** 门禁规则的稳定 id。与 RV* 分开编号，避免「提示」和「拒绝」混成一件事。 */
export type GateRuleId = 'GT001' | 'GT002' | 'GT003'

export interface GateFinding {
  readonly id: GateRuleId
  /** 门禁规则只有一档：命中即拒绝。这里写死 'error' 是为了输出时不用再判断。 */
  readonly severity: 'error'
  readonly title: string
  readonly detail: string
  /** 包内相对路径，绝不含本机绝对路径。 */
  readonly where?: string
}

/**
 * 门禁的取包来源。
 *
 * `registry` 来自 `installBundle(spec, { registry })`——插件页会显式传它，
 * 也就是「这次安装真正要用的源」。不传时按本机 npm 配置（环境变量 → ~/.npmrc → 官方）。
 */
export interface GateOptions {
  readonly registry?: string
  /**
   * 用户信任的包名白名单。命中高危但在名单里的包会被放行，并在报告里标注。
   *
   * 由调用方决定是否传：安装路径（`/install`、插件页包装）读清单后传入；
   * `--gate` 命令行**故意不传** —— 它是「只审不装」的检查工具，脚本靠退出码
   * 做门禁，被白名单放行就等于门禁失效。
   */
  readonly trusted?: readonly string[]
}

export interface GateResult {
  readonly spec: string
  readonly name: string
  readonly version: string
  /** 交给 installBundle 的精确 spec，保证装的就是审的那份。 */
  readonly installSpec: string
  /** tarball URL 只用于定位，报告里可以展示（registry 是公开地址，不是本机路径）。 */
  readonly tarball: string
  /** 实际取包的 registry base。插件页传了 `options.registry` 时就是它，否则按本机 npm 配置。 */
  readonly registry: string
  /** pass = 可装；block = 命中高危；error = 没审成，按 fail closed 也不装。 */
  readonly decision: 'pass' | 'block' | 'error'
  readonly findings: readonly GateFinding[]
  /** 完整的 RV 审查报告，仅作人工参考，不参与判定。 */
  readonly review: ReviewResult
  readonly notes: readonly string[]
  /** decision === 'error' 时的原因；只含错误类别，不含本机绝对路径。 */
  readonly problem?: string
  /**
   * 命中了高危规则，但该包在信任清单里，按用户授权放行（`decision` 为 `pass`）。
   *
   * 单独一个字段而不是只靠 `notes`：报告要显著提示「这是放行，不是没问题」，
   * 调用方也需要能据此区分「审完干净」和「审出问题但被信任」。
   */
  readonly trustedOverride?: boolean
}

/** 单文件 2 MiB、整包 10 MiB、最多 500 个文件；与 review.ts 的口径一致。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_BYTES = 10 * 1024 * 1024
const MAX_FILES = 500
/** tarball 本身的上限，防止一个超大的包把内存吃满。 */
const MAX_TARBALL_BYTES = 32 * 1024 * 1024

interface TarEntry {
  readonly path: string
  readonly data: Buffer
}

/** 从 tar 头部的固定字节区间读 C 字符串（遇到第一个 NUL 结束）。 */
function headerString(header: Buffer, from: number, length: number): string {
  const slice = header.subarray(from, from + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end < 0 ? length : end).toString('utf8')
}

/**
 * 解析 tar.gz 的内容，只在内存里返回条目，不写磁盘。
 *
 * tar 格式很朴素：每个成员先是一个 512 字节的头，`size` 字段在偏移 124 处、
 * 12 字节的**八进制 ASCII**；随后是文件内容，按 512 字节对齐；两个全零块结尾。
 * 这里只处理普通文件（typeflag '0' 或 NUL），其余类型（目录、软链等）跳过。
 *
 * 处理两类长文件名，否则深层目录的包会被悄悄漏审：
 * - GNU `L`：这一项的 data 就是下一项的真实路径；
 * - PAX `x`：data 里形如 `NNN path=...` 的记录。
 * 两者都把名字暂存到 `pendingName`，下一次取普通文件时用。
 */
export function untarGzip(buffer: Buffer): readonly TarEntry[] {
  // gzip 格式固定用 zlib 解；不调用外部 tar 命令，避免依赖 PATH 与平台差异。
  const raw = gunzipSync(buffer)
  const entries: TarEntry[] = []
  let offset = 0
  let pendingName: string | undefined

  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512)
    offset += 512

    // 两个连续全零块表示归档结束；遇到第一个就停。
    let allZero = true
    for (const byte of header) {
      if (byte !== 0) { allZero = false; break }
    }
    if (allZero) break

    const size = Number.parseInt(headerString(header, 124, 12).trim(), 8)
    if (!Number.isFinite(size) || size < 0 || size > raw.length - offset) break
    const data = raw.subarray(offset, offset + size)
    // 内容按 512 字节对齐：向上取整后再跳。
    offset += Math.ceil(size / 512) * 512

    const typeflag = String.fromCharCode(header[156] ?? 0)
    if (typeflag === 'L') {
      pendingName = data.toString('utf8').replace(/\0+$/, '')
      continue
    }
    if (typeflag === 'x') {
      const match = /\bpath=([^\n]+)/.exec(data.toString('utf8'))
      if (match !== null) pendingName = match[1]!.trim()
      continue
    }
    if (typeflag !== '0' && typeflag !== '\0') continue

    const prefix = headerString(header, 345, 155)
    const base = headerString(header, 0, 100)
    const path = pendingName ?? (prefix.length > 0 ? `${prefix}/${base}` : base)
    pendingName = undefined
    entries.push({ path, data })
  }
  return entries
}

/** 把 tar 条目转成审查内核能吃的 TextFile；顺手做体积限制与路径清洗。 */
export function filesFromTarball(buffer: Buffer): {
  files: readonly TextFile[]
  notes: readonly string[]
  oversized: boolean
} {
  const files: TextFile[] = []
  const notes: string[] = []
  let total = 0
  let oversized = false
  let truncated = false

  for (const entry of untarGzip(buffer)) {
    if (files.length >= MAX_FILES) { truncated = true; break }
    // npm 发布的 tarball 一律包在 `package/` 里；剥掉它，让路径与本地目录一致。
    let path = entry.path.replace(/\\/g, '/').replace(/^\.\//, '')
    if (path.startsWith('package/')) path = path.slice('package/'.length)
    // 只用于展示与定位，仍然拒绝穿越路径，避免报告里出现奇怪的 `../../`。
    if (path.includes('..') || path.startsWith('/') || path.length === 0) continue
    if (path.startsWith('node_modules/') || path.includes('/node_modules/')) continue

    const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
    if (!TEXT_EXT.has(ext)) continue
    const bytes = entry.data.length
    if (bytes > MAX_FILE_BYTES) { oversized = true; continue }
    total += bytes
    if (total > MAX_TOTAL_BYTES) { oversized = true; truncated = true; break }
    files.push({ path, text: entry.data.toString('utf8'), bytes })
  }

  if (truncated) notes.push(`扫描在 ${MAX_FILES} 个文件或 ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MiB 处停止，判定可能不完整。`)
  return { files, notes, oversized }
}

/**
 * 只允许 registry 形态的 spec（包名，可带版本范围）。
 *
 * 第一版刻意不接 git / tarball URL / 本地路径：那些形态的「本地取包」逻辑与
 * pnpm 实际拉取结果容易不一致，一旦审的和装的不是同一份，门禁就失去意义。
 * 不确定的形态宁可明确拒绝，也不猜。
 */
export function parseRegistrySpec(spec: string): { name: string; version?: string } | undefined {
  const value = spec.trim()
  if (value.length === 0) return undefined
  if (/^(?:git\+|git@|github:|file:|link:|https?:|ftp:)/i.test(value)) return undefined
  if (/\.tgz?$/i.test(value) || value.includes('://') || value.includes('\\')) return undefined

  // scoped 包以 @ 开头，所以用 lastIndexOf('@') 找版本分隔符；at > 0 才算带版本。
  const at = value.lastIndexOf('@')
  const name = at > 0 ? value.slice(0, at) : value
  const version = at > 0 ? value.slice(at + 1) : undefined
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) return undefined
  // 范围表达式会让「审的版本」和 pnpm 实际装的版本可能不同；第一版明确拒绝，
  // 只接受精确版本或 dist-tag。
  if (version !== undefined && (version.length === 0 || /[\s^~><*=xX*|]/.test(version))) return undefined
  return version === undefined ? { name } : { name, version }
}

/** 从 IO / 网络异常里只取错误码，绝不把 error.message 写进报告（它可能含本机路径）。 */
/** 抛带 code 的错误。`reasonOf` 只取 code 不取 message，所以 `problem` 里
 * 只会出现固定类别名，不会把 registry 地址或本机路径带进报告。 */
function codedError(code: string): Error {
  const error = new Error(code)
  ;(error as { code?: string }).code = code
  return error
}

/**
 * 把异常压成一个固定的类别名，用于 `problem`。
 *
 * 只看 `code` 不取 `message`：`fetch` 的错误可能带完整 URL，一旦是内网
 * registry 就会把地址写进报告。但 `fetch` 的网络失败抛的是没有 code 的
 * TypeError，超时抛的是 DOMException，所以这两类单列出来——否则用户只会
 * 看到 `UNKNOWN`，完全不知道是「网络不通」还是「版本不存在」。
 */
function reasonOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const name = (error as { name?: unknown } | null)?.name
  if (name === 'TimeoutError') return 'timeout'
  if (name === 'AbortError') return 'aborted'
  if (error instanceof TypeError) return 'network-error'
  return 'UNKNOWN'
}

/**
 * 决定用哪个 registry。
 *
 * 优先级：显式传入的 `override`（插件页 `installBundle` 的 `options.registry`，
 * 也就是这次安装真正要用的源）→ 环境变量 `npm_config_registry` → 用户
 * `~/.npmrc` 的 `registry=` → 官方源。只读配置，不写任何文件。
 *
 * 为什么要 override：插件页调 `installBundle` 时会显式传 registry。若门禁仍按
 * `~/.npmrc` 取包，审的和装的就可能来自两个不同的源——UI 指到私有源而
 * `.npmrc` 是公网源时，门禁等于审了一个不相干的包然后放行，形同失效。
 *
 * 显式传了却不合法时**抛错而不回退**：静默回退会重新造出「审 A 装 B」。
 * 上层会把它记成 `decision='error'`（主动入口 fail closed，插件页 fail open）。
 */
function registryBase(override?: string): string {
  if (override !== undefined) {
    const trimmed = override.trim().replace(/\/+$/, '')
    if (trimmed.length === 0) throw codedError('registry-override-empty')
    if (!/^https?:\/\//.test(trimmed)) throw codedError('registry-override-invalid')
    return trimmed
  }
  const fromEnv = process.env.npm_config_registry
  if (typeof fromEnv === 'string' && /^https?:\/\//.test(fromEnv)) {
    return fromEnv.replace(/\/+$/, '')
  }
  try {
    const rc = readFileSync(join(homedir(), '.npmrc'), 'utf8')
    for (const line of rc.split(/\r?\n/)) {
      const match = /^\s*registry\s*=\s*(\S+)/.exec(line)
      if (match !== null && /^https?:\/\//.test(match[1]!)) return match[1]!.replace(/\/+$/, '')
    }
  } catch {
    // 没有 .npmrc 就退回官方源；失败不是错误，只是少了一层配置对齐。
  }
  return 'https://registry.npmjs.org/'
}

/**
 * 从 registry 的 packument 里解析出确切版本、tarball 地址，以及要交给
 * `installBundle` 的精确 spec。
 *
 * 为什么直接读 registry 而不调用 npm 子进程：Windows 上 npm 是批处理脚本，
 * 直接执行会报 EINVAL，改成 shell 包装又会引入命令注入面。`fetch` 读元数据
 * 则跨平台、无子进程、无注入。
 *
 * `installSpec` 是审/装一致性的关键：门禁审的是 `name@exactVersion` 的 tarball，
 * 安装时也强制传同一个精确版本，避免范围表达式解析出不同的版本。
 */
async function resolveMetadata(
  spec: { name: string; version?: string },
  registryOverride?: string,
): Promise<{
  version: string
  tarball: string
  installSpec: string
  registry: string
}> {
  const base = registryBase(registryOverride)
  // scoped 包 `@scope/name` 的斜杠必须编码，否则 registry 会当成路径分隔符。
  const encoded = spec.name.startsWith('@') ? spec.name.replace('/', '%2f') : spec.name
  const response = await fetch(`${base}/${encoded}`, {
    signal: AbortSignal.timeout(30_000),
    // 精简 packument：只要 versions / dist-tags / dist，体积比完整元数据小很多。
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  })
  if (!response.ok) throw codedError(`http-${response.status}`)
  const doc: unknown = await response.json()
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw codedError('bad-packument')
  const record = doc as Record<string, unknown>
  const versions = (record.versions ?? {}) as Record<string, Record<string, unknown>>
  const tags = (record['dist-tags'] ?? {}) as Record<string, string>

  const wanted = spec.version ?? tags.latest
  if (typeof wanted !== 'string' || wanted.length === 0) throw codedError('no-version')
  // wanted 可能是精确版本，也可能是 dist-tag（latest / next）。
  const exact = versions[wanted] !== undefined ? wanted : tags[wanted]
  if (typeof exact !== 'string' || versions[exact] === undefined) throw codedError('version-not-found')
  const dist = versions[exact]!.dist
  const tarball = (dist as { tarball?: unknown } | null)?.tarball
  if (typeof tarball !== 'string' || !/^https?:\/\//.test(tarball)) throw codedError('no-tarball')
  return { version: exact, tarball, installSpec: `${spec.name}@${exact}`, registry: base }
}

/** 下载 tarball；带超时和体积上限，避免一个恶意包把内存吃满。 */
async function downloadTarball(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw codedError(`http-${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > MAX_TARBALL_BYTES) throw codedError('tarball-too-large')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > MAX_TARBALL_BYTES) throw codedError('tarball-too-large')
  return bytes
}

/** 从内存文件里取指定路径的文本；找不到就返回 undefined。 */
function textOf(files: readonly TextFile[], path: string): string | undefined {
  return files.find(file => file.path === path)?.text
}

/**
 * GT001–GT003：只拦结构明确的高危信号。
 *
 * 这些规则刻意不复用 RV 的「出现即提示」阈值。比如 RV001 只要安装脚本里有
 * `curl` 就给 info，而 GT001 要求「下载内容被管道送进 shell / 被 eval」——
 * 这是一个具体的执行链，正常构建脚本很少这么写。
 */
export function evaluateGateRules(input: {
  readonly manifest: Record<string, unknown>
  readonly patchText: string
  readonly files: readonly TextFile[]
}): GateFinding[] {
  const findings: GateFinding[] = []
  const { manifest, patchText, files } = input

  const asStrings = (value: unknown): Record<string, string> => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
    const out: Record<string, string> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === 'string') out[key] = item
    }
    return out
  }
  const scripts = asStrings(manifest.scripts)
  // 只看运行时依赖：devDependencies 里的 file:/link: 是本地开发的常态，不算高危。
  const dependencies = asStrings(manifest.dependencies)

  // ---- GT001：安装期脚本把下载内容直接送进解释器 --------------------------------
  const installScripts = Object.entries(scripts)
    .filter(([name]) => /^(?:pre|post)?install$|^prepare$/.test(name))
    .map(([, value]) => value)
    .join('\n')
  const remoteExecute = /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python[0-9.]*|node|perl)\b|\beval\s*\$\(\s*(?:curl|wget)|\bbase64\s+(?:-d|--decode)\b[^\n|]*\|\s*(?:sh|bash)\b/
  if (remoteExecute.test(installScripts)) {
    findings.push({
      id: 'GT001', severity: 'error',
      title: '安装期脚本会把远程下载内容直接执行',
      detail: 'preinstall/install/postinstall/prepare 里出现 curl|wget 管道进 shell、eval $(curl) 或 base64 解码后执行；这是供应链攻击最常见的落点，正常构建脚本极少需要。',
      where: 'package.json',
    })
  }

  // ---- GT002：patch 改写 / 禁用别人的 loader 条目 --------------------------------
  // 真实 profile 里被覆盖的 id 是 ui-chat、ui-settings 这一类，并不带官方 scope
  // 前缀，所以只看「@deepseek-ai/ 开头」会几乎永远不命中。改为两个具体信号：
  //   a) 覆盖官方 scope 条目；
  //   b) 用 disabled: true 静默关掉一个**不是本包自己 insert** 的条目。
  // 后者是真实可见的高危动作：会让别的插件在毫无提示的情况下消失。
  if (patchText.length > 0) {
    const ids = parsePatchIds(patchText)
    const ownInserts = new Set(ids.inserts)
    const official = ids.patches.filter(id => id.startsWith('@deepseek-ai/'))

    let list: unknown
    try {
      list = parseYaml(patchText)
    } catch {
      list = undefined
    }
    const disabledOthers: string[] = []
    if (Array.isArray(list)) {
      for (const entry of list) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
        const record = entry as Record<string, unknown>
        const id = record.id
        if (typeof id !== 'string' || record.disabled !== true) continue
        // 本包 insert 时把自己默认关掉是正常写法（插件页可再打开），不算高危。
        if (!ownInserts.has(id)) disabledOthers.push(id)
      }
    }

    if (official.length > 0 || disabledOthers.length > 0) {
      const targets = [...official, ...disabledOthers].slice(0, 3).join('、')
      findings.push({
        id: 'GT002', severity: 'error',
        title: 'patch 会覆盖或静默禁用其他插件条目',
        detail: `${targets}；改写官方 scope 条目，或用 disabled: true 关掉非本包的条目，会改变所有会话里其他插件的行为，普通插件没有正当理由这么做。`,
        where: 'cordis.patch.yml',
      })
    }
  }

  // ---- GT003：运行时依赖指向任意远端地址 ----------------------------------------
  // registry 包名 / 语义版本 / workspace: 都放行；其余形态一律视为来源不可核验。
  const remoteDeps = Object.entries(dependencies)
    .filter(([, spec]) => /^(?:https?:|git\+|git@|github:|file:|link:)/i.test(spec) || spec.includes('://'))
    .map(([name]) => name)
  if (remoteDeps.length > 0) {
    findings.push({
      id: 'GT003', severity: 'error',
      title: '运行时依赖指向非 registry 的远端来源',
      detail: `${remoteDeps.slice(0, 3).join('、')} 依赖 URL / git / 本地路径；发布到 registry 的包不该把运行时依赖指向不可核验的地址。`,
      where: 'package.json',
    })
  }

  return findings
}

/** 构造一个「无冲突聚焦」的 RV 报告；装前包还没进 profile，focus 必然为空。 */
function buildReview(
  name: string,
  files: readonly TextFile[],
  manifest: Record<string, unknown>,
  patchText: string,
  oversized: boolean,
  notes: readonly string[],
): ReviewResult {
  const hints: RiskHint[] = evaluateRiskHints({
    files, manifest, patchText, report: undefined, pkg: name, oversized,
  })
  return {
    pkg: name,
    // 内部占位：报告渲染不会输出 dir，避免把本机绝对路径带进会话。
    dir: '<tarball>',
    hints,
    focus: [],
    notes: [...notes, '装前审查没有当前 profile 的插件体检结果，冲突聚焦与 RV005 已跳过。'],
  }
}

/** 包名是否在白名单里（大小写不敏感；npm 包名本来就全小写）。 */
function isTrustedPackage(names: readonly string[] | undefined, pkg: string): boolean {
  if (names === undefined || names.length === 0) return false
  const target = pkg.toLowerCase()
  return names.some(name => name.toLowerCase() === target)
}

/**
 * 门禁主流程：校验 spec → 取元数据 → 下载 tarball → 内存解压 → 审 → 判定。
 * 任何一步失败都返回 `decision: 'error'`，调用方不得把它当通过。
 */
export async function gateSpec(rawSpec: string, options?: GateOptions): Promise<GateResult> {
  const parsed = parseRegistrySpec(rawSpec)
  const empty = (problem: string): GateResult => ({
    spec: rawSpec, name: '', version: '', installSpec: '', tarball: '', registry: '',
    decision: 'error', findings: [], problem,
    review: { pkg: '', dir: '<tarball>', hints: [], focus: [], notes: [] },
    notes: [],
  })
  if (parsed === undefined) {
    return empty('invalid-spec：第一版只支持 registry 包名（可带版本），不支持 git / URL / 本地路径 / .tgz。')
  }

  let resolved: { version: string; tarball: string; installSpec: string; registry: string }
  try {
    resolved = await resolveMetadata(parsed, options?.registry)
  } catch (error) {
    // npm view 的 stderr 常含本机路径，这里只留错误码与固定类别。
    return empty(`resolve-failed：${reasonOf(error)}`)
  }

  let buffer: Buffer
  try {
    buffer = await downloadTarball(resolved.tarball)
  } catch (error) {
    return empty(`download-failed：${reasonOf(error)}`)
  }

  let collected: ReturnType<typeof filesFromTarball>
  try {
    collected = filesFromTarball(buffer)
  } catch (error) {
    return empty(`untar-failed：${reasonOf(error)}`)
  }

  const { files, notes, oversized } = collected
  let manifest: Record<string, unknown> = {}
  const manifestText = textOf(files, 'package.json')
  if (manifestText === undefined) {
    return empty('missing-manifest：tarball 里没有 package.json，无法判定。')
  }
  try {
    const value: unknown = JSON.parse(manifestText)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      manifest = value as Record<string, unknown>
    }
  } catch {
    return empty('bad-manifest：package.json 不是合法 JSON，无法判定。')
  }

  const patchText = textOf(files, 'cordis.patch.yml') ?? ''
  const findings = evaluateGateRules({ manifest, patchText, files })
  const review = buildReview(parsed.name, files, manifest, patchText, oversized, notes)

  // 命中高危但包在信任清单里：放行，但保留 findings 让报告如实写出命中了什么。
  const trustedHit = findings.length > 0 && isTrustedPackage(options?.trusted, parsed.name)

  return {
    spec: rawSpec,
    name: parsed.name,
    version: resolved.version,
    installSpec: resolved.installSpec,
    tarball: resolved.tarball,
    registry: resolved.registry,
    decision: findings.length > 0 && !trustedHit ? 'block' : 'pass',
    ...trustedHit ? { trustedOverride: true } : {},
    findings,
    review,
    notes,
  }
}

/** 纯文本版（斜杠命令输出是会话流文本节点，Markdown 表格会显示成一堆竖线）。 */
export function gatePlainLines(result: GateResult): string[] {
  const lines: string[] = []
  lines.push(`安装门禁 · ${result.spec}`)
  if (result.decision === 'error') {
    lines.push(`  未能完成审查：${result.problem ?? '未知原因'}`)
    lines.push('  按 fail closed 处理，不安装。')
    return lines
  }
  lines.push(`  版本：${result.version}`)
  lines.push(
    `  结论：${result.decision === 'pass' ? '通过，可以安装' : '拒绝安装'}`
    + (result.trustedOverride === true ? '（命中高危，但在信任清单里，已按授权放行）' : ''),
  )
  lines.push(`  RV 提示：${result.review.hints.length} 条（仅供参考，不参与判定）`)
  if (result.findings.length === 0) {
    lines.push('  高危规则：未命中')
  } else {
    lines.push('  高危规则：')
    for (const finding of result.findings) {
      lines.push(`    ${finding.id} ${finding.title}${finding.where === undefined ? '' : `（${finding.where}）`}`)
      lines.push(`      ${finding.detail}`)
    }
  }
  if (result.trustedOverride === true) {
    lines.push('  注意：放行是因为这个包在信任清单里，不代表审查没发现问题。')
    lines.push(`  撤销信任：/doctor untrust ${result.name}`)
  }
  lines.push('  说明：审的是 tarball 内容，安装时 pnpm 会再下载一次；插件页安装只在 skill-doctor-gate 那一行开启时才受约束。')
  return lines
}

/** Markdown 版（CLI 默认输出）。 */
export function gateMarkdownLines(result: GateResult): string[] {
  const lines: string[] = ['## 安装门禁', '']
  lines.push(`> 审的是 tarball 内容，不落盘、不执行被审包代码。命中高危规则即拒绝；取包失败也按拒绝处理。`, '')
  lines.push(`审查对象：\`${result.spec}\`；版本：\`${result.version}\`；结论：**${result.decision === 'pass' ? '通过' : result.decision === 'block' ? '拒绝安装' : '未能完成审查'}**。`)
  if (result.trustedOverride === true) lines.push(`> ⚠ 命中高危，但该包在信任清单里，已按授权放行。撤销：\`/doctor untrust ${result.name}\``)

  if (result.registry.length > 0) lines.push(`取包来源：\`${result.registry}\`（插件页安装时用它传的源，其余入口按本机 npm 配置）。`)
  if (result.decision === 'error') lines.push('', `原因：${result.problem ?? '未知原因'}`, '', '按 fail closed 处理，不安装。')
  lines.push('', `RV 提示 ${result.review.hints.length} 条（仅供参考，不参与判定）：`)
  for (const hint of result.review.hints) {
    lines.push(`- ${hint.severity.toUpperCase()} ${hint.id} ${hint.title}${hint.where === undefined ? '' : `（\`${hint.where}\`）`}`)
  }
  lines.push('', '### 高危规则')
  if (result.findings.length === 0) lines.push('', '未命中。')
  for (const finding of result.findings) {
    lines.push('', `- **ERROR ${finding.id}** ${finding.title}${finding.where === undefined ? '' : `（\`${finding.where}\`）`}`)
    lines.push(`  - ${finding.detail}`)
  }
  lines.push('', '**边界**：覆盖 `--gate`、`/install`、插件页与模型工具发起的安装（后两者经过包装的 `installBundle`）；`dsh plugin add` 与手改 `package.json` 后的 `pnpm install` 不走服务，无法覆盖。')
  lines.push('', '**同源限制**：取包用 `options.registry` 指定的源，但 pnpm 在该源不可达时会回退到本机配置的备用源，因此「审的字节」与「装的字节」不保证完全相同。')
  return lines
}

/** JSON 版（供脚本接退出码与结构化判定）。 */
export function gateJson(result: GateResult): Record<string, unknown> {
  return {
    spec: result.spec,
    name: result.name,
    version: result.version,
    installSpec: result.installSpec,
    tarball: result.tarball,
    registry: result.registry,
    decision: result.decision,
    ...result.trustedOverride === true ? { trustedOverride: true } : {},
    disclaimer: 'static gate, not a malware verdict',
    findings: result.findings.map(finding => ({ ...finding })),
    rvHints: result.review.hints.map(hint => ({ ...hint })),
    notes: [...result.notes],
    ...result.problem === undefined ? {} : { problem: result.problem },
  }
}

/**
 * `/install` 用：审过之后才在 Host 进程里调官方安装服务。
 *
 * 关键：`ctx.pluginManager` 只存在于 dsh Host 进程，独立 CLI 拿不到；所以这里用
 * `ctx.get(name, false)` 软探测，**不写进 inject**（硬注入会让 CLI / 老版本 dsh
 * 整个插件加载失败）。探测不到就明确告诉用户「门禁通过但没装」。
 *
 * 注意：直接调服务不会经过 `plugin_manager` 工具的 `danger-full-access` / 单次审批
 * （那层检查在 tool 层），等于以宿主进程权限安装。这是自动门禁的代价。
 */
/** 读信任清单，转成 `gateSpec` 能用的形状；读不到就当没有白名单（门禁照常拦）。 */
async function trustOptions(): Promise<GateOptions> {
  const file = await loadTrust()
  const names = trustedNames(file)
  return names.length === 0 ? {} : { trusted: names }
}

export async function installAfterGate(
  ctx: Context,
  rawSpec: string,
  /** 测试可传入已算好的门禁结果，跳过网络；生产调用方不传。 */
  precomputed?: GateResult,
): Promise<string[]> {
  const gate = precomputed ?? await gateSpec(rawSpec, await trustOptions())
  const lines = gatePlainLines(gate)
  if (gate.decision !== 'pass') return lines

  const lookup = (ctx as unknown as { get?: (name: string, strict?: boolean) => unknown }).get
  const manager = typeof lookup === 'function'
    ? lookup.call(ctx, 'pluginManager', false) as { installBundle?: unknown } | undefined
    : undefined
  if (typeof manager?.installBundle !== 'function') {
    lines.push('  门禁已通过，但当前上下文没有 pluginManager 服务，未执行安装。')
    lines.push('  请在 dsh 输入框使用 /install，或到插件页手动安装。')
    return lines
  }

  try {
    const install = manager.installBundle as (
      spec: string,
      options?: Record<string, unknown>,
    ) => Promise<unknown>
    // 用门禁解析出的精确版本，而不是用户输入的原始 spec。
    const changed = await install(gate.installSpec, {
      saveExact: true,
      // 把门禁实际取包用的源一并交给安装，避免两边各读一次配置而分叉。
      ...gate.registry.length === 0 ? {} : { registry: gate.registry },
    })
    const result = (changed ?? {}) as Record<string, unknown>
    // 只挑不含本机路径的安全字段，ChangeResult 里可能有目录信息。
    const application = typeof result.application === 'string' ? result.application : 'unknown'
    const errorCode = (result.error as { code?: unknown } | null)?.code
    lines.push(`  已调用 installBundle：application=${application}${typeof errorCode === 'string' ? `，errorCode=${errorCode}` : ''}`)
    if (typeof errorCode === 'string') lines.push('  安装服务返回了错误，请查看 dsh 插件页的安装日志。')
  } catch (error) {
    lines.push(`  安装调用失败：${reasonOf(error)}（门禁已通过，但包可能没装成）。`)
  }
  return lines
}

/** 包装标记：避免热重载时把同一个方法包两层，也用于还原时判断是否还是自己那层。 */
const WRAP_MARK = '__skillDoctorInstallGate'

type ManagedService = {
  installBundle: (spec: string, options?: unknown) => Promise<unknown>
  [key: string]: unknown
}

/**
 * 给**插件页**的安装装一道门。
 *
 * ## 为什么这样可以拦住插件页
 *
 * 插件页不是绕过服务，而是通过 remote 调 `pluginManager` 这**同一个实例**上的
 * `installBundle`（官方源码 `src/index.ts:496` 的 `@Remote` 方法）。把实例上的
 * 该方法替换成「先审再决定」，插件页的点击就会经过它。
 *
 * 这一点是实测出来的，不是推断：在已装包上包装 `setBundleEnabled` 后，插件页
 * 开关组合包时探针收到了 `** setBundleEnabled CALLED`，说明 remote 分发是
 * 按实例属性取方法的，替换有效。`installBundle` 与它同类同机制。
 *
 * ## 三条策略，与主动门禁刻意不同
 *
 * | 情况 | `--gate` / `/install` | 这里（被动经过） |
 * |---|---|---|
 * | 命中 GT 规则 | 拒绝 | 拒绝 |
 * | 未完成审查（网络/解析失败） | 拒绝（fail closed） | **放行 + 记 warn** |
 * | 包装自身异常 | — | **放行 + 记 warn** |
 *
 * 差别的原因：插件页是用户点一下就走的路，一次网络抖动或本插件自己的 bug
 * 不该让**任何插件都装不上**，而且用户未必知道是 doctor 导致的。阻断必须建立
 * 在「确实看到了高危结构」上，而不是「我没查成」。
 *
 * ## 仍然拦不住的
 *
 * CLI 的 `dsh plugin add`、手改 `package.json` 后的 `pnpm install` 都不经过这个
 * 服务，属于包管理器的写入路径，这里无法覆盖。
 */
export function registerInstallGate(
  ctx: Context,
  mode: 'block' | 'off',
  /** 测试可注入审查函数，跳过网络；生产调用方不传，默认用 gateSpec。 */
  inspect?: (spec: string, options?: GateOptions) => Promise<GateResult>,
): void {
  const probe = ctx as unknown as {
    get?: (name: string, strict?: boolean) => unknown
    effect?: (callback: () => () => void, key?: string) => void
    logger: { info: (message: string) => void; warn: (message: string) => void }
  }

  if (mode === 'off') {
    probe.logger.info('skill-doctor: install gate disabled by config (installGate: off)')
    return
  }

  let manager: ManagedService | undefined
  try {
    manager = typeof probe.get === 'function'
      ? probe.get.call(ctx, 'pluginManager', false) as ManagedService | undefined
      : undefined
  } catch {
    manager = undefined
  }
  if (manager === undefined || typeof manager.installBundle !== 'function') {
    // 软探测：不写进 inject，否则 CLI / 老版本 dsh 会整个插件加载失败。
    probe.logger.info('skill-doctor: install gate unavailable — no pluginManager service; plugin-page installs are not gated')
    return
  }
  if (manager[WRAP_MARK] === true) {
    probe.logger.info('skill-doctor: install gate already active')
    return
  }

  const original = manager.installBundle
  const runGate = inspect ?? gateSpec

  const wrapped = async (spec: string, options?: unknown): Promise<unknown> => {
    // 插件页会在这里传 `registry`——那才是这次安装真正要用的源，
    // 交给门禁才能保证「审的包」和「装的包」来自同一处。
    const declared = (options as { registry?: unknown } | undefined)?.registry
    const registryOverride =
      typeof declared === 'string' && declared.length > 0 ? declared : undefined
    // 信任清单每次安装现读：被拦住→加信任→立刻重试就该生效，不需要重启。
    // 读失败按空清单处理（loadTrust 自身不抛，这里只是不让它挡住安装）。
    const trustFile = await loadTrust().catch(() => undefined)
    const trusted = trustFile === undefined ? [] : trustedNames(trustFile)
    const gateOptions: GateOptions | undefined =
      registryOverride === undefined && trusted.length === 0
        ? undefined
        : {
            ...registryOverride === undefined ? {} : { registry: registryOverride },
            ...trusted.length === 0 ? {} : { trusted },
          }
    let gate: GateResult
    try {
      gate = await runGate(String(spec), gateOptions)
    } catch (error) {
      probe.logger.warn(
        `skill-doctor: install gate skipped (${reasonOf(error)}); installing without inspection`,
      )
      return original.call(manager, spec, options)
    }

    if (gate.decision === 'block') {
      const ids = gate.findings.map(finding => finding.id).join('、')
      const detail = gate.findings[0]?.detail ?? ''
      // 返回 ChangeResult 形状的失败结果，让插件页显示具体原因，而不是通用报错。
      return {
        changed: false,
        application: 'failed',
        stage: 'install',
        target: String(spec),
        error: {
          code: 'operation-error',
          diagnostic: `安装门禁拒绝：${ids}。${detail} 若这个包可信，执行 /doctor trust ${gate.name.length > 0 ? gate.name : String(spec)} 后点「重试」即可放行；要临时关掉门禁，在插件页关掉 skill-doctor-gate 那一行。`,
        },
      }
    }

    if (gate.decision === 'error') {
      // 未完成审查不等于有问题：放行，但必须留痕，别让人以为已经查过。
      probe.logger.warn(
        `skill-doctor: install gate could not inspect ${spec} (${gate.problem ?? 'unknown'}); installing without inspection`,
      )
    }
    return original.call(manager, spec, options)
  }

  manager.installBundle = wrapped
  manager[WRAP_MARK] = true

  const restore = (): void => {
    if (manager.installBundle === wrapped) manager.installBundle = original
    delete manager[WRAP_MARK]
  }
  try {
    // ctx.effect 接收的是「**返回** disposer 的函数」，所以这里返回 restore 本身，
    // 而不是把 restore 当成 disposer 直接传进去（那样会被立刻执行）。
    probe.effect?.call(ctx, () => restore, 'skill-doctor-install-gate')
  } catch {
    // 没有 effect 就保留包装：实例随上下文销毁，不会泄漏到别的 profile。
  }
}
