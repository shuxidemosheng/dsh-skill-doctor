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
 * 3. **不覆盖插件页。** 插件页的安装走 `plugin-manager` 自己的链路，本模块管不着。
 *    只有 `--gate` 与 `/install` 这两个新入口才带门禁。
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

export interface GateResult {
  readonly spec: string
  readonly name: string
  readonly version: string
  /** 交给 installBundle 的精确 spec，保证装的就是审的那份。 */
  readonly installSpec: string
  /** tarball URL 只用于定位，报告里可以展示（registry 是公开地址，不是本机路径）。 */
  readonly tarball: string
  /** pass = 可装；block = 命中高危；error = 没审成，按 fail closed 也不装。 */
  readonly decision: 'pass' | 'block' | 'error'
  readonly findings: readonly GateFinding[]
  /** 完整的 RV 审查报告，仅作人工参考，不参与判定。 */
  readonly review: ReviewResult
  readonly notes: readonly string[]
  /** decision === 'error' 时的原因；只含错误类别，不含本机绝对路径。 */
  readonly problem?: string
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
function reasonOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'UNKNOWN'
}

/**
 * 决定用哪个 registry。
 *
 * 优先级：环境变量 `npm_config_registry` → 用户 `~/.npmrc` 的 `registry=` →
 * 官方源。前两项与 npm / pnpm 读到的是同一套配置，尽量让「审的 tarball」和
 * 「装的 tarball」来自同一个源。这里只读配置，不写任何文件。
 */
function registryBase(): string {
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
async function resolveMetadata(spec: { name: string; version?: string }): Promise<{
  version: string
  tarball: string
  installSpec: string
}> {
  const base = registryBase()
  // scoped 包 `@scope/name` 的斜杠必须编码，否则 registry 会当成路径分隔符。
  const encoded = spec.name.startsWith('@') ? spec.name.replace('/', '%2f') : spec.name
  const response = await fetch(`${base}/${encoded}`, {
    signal: AbortSignal.timeout(30_000),
    // 精简 packument：只要 versions / dist-tags / dist，体积比完整元数据小很多。
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  })
  if (!response.ok) throw new Error(`http ${response.status}`)
  const doc: unknown = await response.json()
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('bad packument')
  const record = doc as Record<string, unknown>
  const versions = (record.versions ?? {}) as Record<string, Record<string, unknown>>
  const tags = (record['dist-tags'] ?? {}) as Record<string, string>

  const wanted = spec.version ?? tags.latest
  if (typeof wanted !== 'string' || wanted.length === 0) throw new Error('no version')
  // wanted 可能是精确版本，也可能是 dist-tag（latest / next）。
  const exact = versions[wanted] !== undefined ? wanted : tags[wanted]
  if (typeof exact !== 'string' || versions[exact] === undefined) throw new Error('version not found')
  const dist = versions[exact]!.dist
  const tarball = (dist as { tarball?: unknown } | null)?.tarball
  if (typeof tarball !== 'string' || !/^https?:\/\//.test(tarball)) throw new Error('no tarball')
  return { version: exact, tarball, installSpec: `${spec.name}@${exact}` }
}

/** 下载 tarball；带超时和体积上限，避免一个恶意包把内存吃满。 */
async function downloadTarball(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`http ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > MAX_TARBALL_BYTES) throw new Error('tarball too large')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > MAX_TARBALL_BYTES) throw new Error('tarball too large')
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

/**
 * 门禁主流程：校验 spec → 取元数据 → 下载 tarball → 内存解压 → 审 → 判定。
 * 任何一步失败都返回 `decision: 'error'`，调用方不得把它当通过。
 */
export async function gateSpec(rawSpec: string): Promise<GateResult> {
  const parsed = parseRegistrySpec(rawSpec)
  const empty = (problem: string): GateResult => ({
    spec: rawSpec, name: '', version: '', installSpec: '', tarball: '',
    decision: 'error', findings: [], problem,
    review: { pkg: '', dir: '<tarball>', hints: [], focus: [], notes: [] },
    notes: [],
  })
  if (parsed === undefined) {
    return empty('invalid-spec：第一版只支持 registry 包名（可带版本），不支持 git / URL / 本地路径 / .tgz。')
  }

  let resolved: { version: string; tarball: string; installSpec: string }
  try {
    resolved = await resolveMetadata(parsed)
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

  return {
    spec: rawSpec,
    name: parsed.name,
    version: resolved.version,
    installSpec: resolved.installSpec,
    tarball: resolved.tarball,
    decision: findings.length > 0 ? 'block' : 'pass',
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
  lines.push(`  结论：${result.decision === 'pass' ? '通过，可以安装' : '拒绝安装'}`)
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
  lines.push('  说明：审的是 tarball 内容，安装时 pnpm 会再下载一次；插件页安装不受本门禁约束。')
  return lines
}

/** Markdown 版（CLI 默认输出）。 */
export function gateMarkdownLines(result: GateResult): string[] {
  const lines: string[] = ['## 安装门禁', '']
  lines.push(`> 审的是 tarball 内容，不落盘、不执行被审包代码。命中高危规则即拒绝；取包失败也按拒绝处理。`, '')
  lines.push(`审查对象：\`${result.spec}\`；版本：\`${result.version}\`；结论：**${result.decision === 'pass' ? '通过' : result.decision === 'block' ? '拒绝安装' : '未能完成审查'}**。`)
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
  lines.push('', '**边界**：只覆盖 `--gate` 与 `/install` 两个入口；插件页安装走 `plugin-manager` 自己的链路，不受本门禁约束。')
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
    decision: result.decision,
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
export async function installAfterGate(
  ctx: Context,
  rawSpec: string,
  /** 测试可传入已算好的门禁结果，跳过网络；生产调用方不传。 */
  precomputed?: GateResult,
): Promise<string[]> {
  const gate = precomputed ?? await gateSpec(rawSpec)
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
    const changed = await install(gate.installSpec, { saveExact: true })
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
