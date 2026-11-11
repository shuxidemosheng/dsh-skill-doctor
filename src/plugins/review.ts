/**
 * 新装插件审查：静态启发式风险提示 + 与已装插件的冲突聚焦。
 *
 * ## 这个模块做什么，不做什么
 *
 * 它只读地扫一个**已经落盘**的插件目录（通常是 `<profile>/node_modules/<pkg>`），
 * 从 `package.json`、`cordis.patch.yml` 和包内文本里找出「值得人工看一眼」的结构特征，
 * 再把现有 `scanProfile` 的 PL001–PL006 里涉及这个包的冲突单列出来。
 *
 * 三条硬边界，写代码前先想清楚：
 * - **不是安全扫描器，也不是恶意代码判定。** 插件是 JS，判断作者意图需要 AST 分析、
 *   沙箱执行、依赖供应链审计；这里只做文本模式匹配，正常打包产物几乎必然命中
 *   `eval(`、`child_process` 之类，所以那些规则刻意定成 `info`。命中不等于恶意。
 * - **不拦截安装、不回滚、不删文件、不执行被审包的代码。** 全部是 `readFile`。
 * - **不解析 `.tgz`。** 用户说的是「下载后」，此时包已经解压在 `node_modules` 里；
 *   只支持目录，避免引入 tar 解析依赖。
 *
 * ## 为什么单独一套 RV* 编号，不复用 SD 规则引擎
 *
 * `Finding`/`ScanResult` 绑死 `RuleId = SD001–SD015`，`tests/prescriptions.spec.ts`
 * 还强制每条规则都有 `prescribeKind`；更要命的是病历（baseline）只按 `finding.rule`
 * 计数——多产一条 Finding 就会让老病历被误判成「新冒出来一个」。这里所有结论都是
 * **纯展示**，不进 findings 集合，所以 RV* 独立编号、独立类型，与 `PluginReport` 并列。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { HIDDEN, REMOTE_EXEC } from '../scanner/checks/instructions.js'
import { profileNameOf } from '../profile-name.js'
import type { PluginConflict, PluginReport } from './scan.js'
import { parsePatchIds, parseSkillTouchpoints, profileDirOf, scanProfile } from './scan.js'

/** 12 条启发式规则的稳定 id；报告文案与测试都按它断言。 */
export type RiskRuleId =
  | 'RV001' | 'RV002' | 'RV003' | 'RV004' | 'RV005' | 'RV006'
  | 'RV007' | 'RV008' | 'RV009' | 'RV010' | 'RV011' | 'RV012'

/**
 * 一条风险提示。
 * 刻意只有 `info` / `warn` 两档、**没有 `error`**：既然不能判定恶意，就不该让
 * 它把 CI 挂掉（`--warn-as-error` 会把任何 warn 变成失败，所以 CLI 的 --review
 * 分支退出码恒 0，详见 cli.ts）。
 */
export interface RiskHint {
  readonly id: RiskRuleId
  readonly severity: 'info' | 'warn'
  readonly title: string
  readonly detail: string
  /** 包内相对路径，绝不含本机绝对路径。 */
  readonly where?: string
}

/** 一条冲突，以及「和谁冲突」。 */
export interface ConflictFocus {
  readonly conflict: PluginConflict
  /** `involved` 里除本包之外的名字；单包冲突（PL001/004/006）为空数组。 */
  readonly counterpart: readonly string[]
}

/** 一次审查的完整结果。三条输出（纯文本 / Markdown / JSON）都从它派生。 */
export interface ReviewResult {
  /** 包名（或目录名），用于展示与聚焦过滤。 */
  readonly pkg: string
  /** 被审目录；内部定位用，展示时不输出绝对路径。 */
  readonly dir: string
  readonly hints: readonly RiskHint[]
  readonly focus: readonly ConflictFocus[]
  /** 读不到的文件、跳过的原因等非致命说明。 */
  readonly notes: readonly string[]
}

/** 只把能当文本读的文件纳入扫描，避免把二进制喂给正则。 */
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx',
  '.json', '.yml', '.yaml', '.md', '.txt', '.sh', '.bash', '.ps1', '.py',
])

/** 体积上限与 hub 的装前审计对齐：单文件 2 MiB、整包 10 MiB、最多 500 文件。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_BYTES = 10 * 1024 * 1024
const MAX_FILES = 500

interface TextFile {
  /** 包内相对路径，统一用正斜杠。 */
  readonly path: string
  readonly text: string
  readonly bytes: number
}

interface Collected {
  readonly files: readonly TextFile[]
  readonly notes: readonly string[]
  /** 命中体积/数量上限时置 true，用于 RV011。 */
  readonly oversized: boolean
  readonly truncated: boolean
}

function toPosix(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * 从 IO 异常里只取错误码（ENOENT / EACCES …）。
 *
 * 关键：`error.message` 在 Node 里是 `ENOENT: no such file or directory, open '<absolute path>'`，
 * **含完整的本机绝对路径**。审查结果会进 JSON、Markdown 报告、会话流与发布物料，
 * 把 message 原样写进 notes 就等于把开发机目录结构带出去。这里只保留 code，
 * 其余一律降级成「读取失败」，配合包内相对路径已经足够定位问题。
 */
function reasonOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : '读取失败'
}

/**
 * 递归收集包内文本文件。
 *
 * 跳过包**内部**的 `node_modules`（那是依赖，不是这个插件自己的代码）、`.git`
 * 与二进制扩展名。递归深度不设上限但用文件数与总字节兜底：恶意包塞一万个
 * 小文件时，我们不能跟着读一万个。
 */
async function collectFiles(dir: string): Promise<Collected> {
  const files: TextFile[] = []
  const notes: string[] = []
  let totalBytes = 0
  let oversized = false
  let truncated = false

  async function walk(current: string): Promise<void> {
    if (files.length >= MAX_FILES) {
      truncated = true
      return
    }
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      notes.push(`读不到目录 ${toPosix(relative(dir, current)) || '.'}：${reasonOf(error)}`)
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) { truncated = true; return }
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase()
      if (!TEXT_EXT.has(ext)) continue
      const rel = toPosix(relative(dir, full))
      try {
        const info = await stat(full)
        if (info.size > MAX_FILE_BYTES) { oversized = true; continue }
        totalBytes += info.size
        if (totalBytes > MAX_TOTAL_BYTES) { oversized = true; truncated = true; return }
        // 用 utf8 解码：二进制文件即便扩展名像文本，读出来也会是乱码，
        // 正则匹配不到有意义的内容，不会制造额外告警。
        const text = await readFile(full, 'utf8')
        files.push({ path: rel, text, bytes: info.size })
      } catch (error) {
        notes.push(`读不到 ${rel}：${reasonOf(error)}`)
      }
    }
  }

  await walk(dir)
  if (truncated) notes.push(`扫描在 ${MAX_FILES} 个文件或 ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MiB 处停止，报告可能不完整。`)
  return { files, notes, oversized, truncated }
}

/** 只取第一条命中：同一条规则在一个包里刷 20 次没有诊断价值。 */
function pushOnce(out: RiskHint[], seen: Set<RiskRuleId>, hint: RiskHint): void {
  if (seen.has(hint.id)) return
  seen.add(hint.id)
  out.push(hint)
}

/** 编辑距离（Levenshtein），只用于 RV004 的短 scope 字符串，O(n*m) 足够。 */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const saved = row[j]!
      row[j] = Math.min(
        row[j]! + 1,
        row[j - 1]! + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      previous = saved
    }
  }
  return row[b.length]!
}

/** 官方 scope 名，RV004 用来识别「只差一个字母」的仿冒依赖。 */
const OFFICIAL_SCOPE = 'deepseek-ai'

/** 从 package.json 里抽 scripts / dependencies 的形状；字段缺失就当空。 */
function manifestFields(manifest: Record<string, unknown>): {
  scripts: Record<string, string>
  dependencies: Record<string, string>
} {
  const asStrings = (value: unknown): Record<string, string> => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
    const out: Record<string, string> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === 'string') out[key] = item
    }
    return out
  }
  return {
    scripts: asStrings(manifest.scripts),
    dependencies: {
      ...asStrings(manifest.dependencies),
      ...asStrings(manifest.devDependencies),
    },
  }
}

/**
 * 审查一个已落盘的插件目录。
 *
 * @param dir - 插件目录绝对路径（内部使用，报告里不输出）。
 * @param report - 可选的 `scanProfile` 结果；给了才能做 RV005/RV006 与冲突聚焦。
 * @param pkgName - 可选的包名；不给就用目录名。
 */
export async function reviewBundle(
  dir: string,
  report?: PluginReport,
  pkgName?: string,
): Promise<ReviewResult> {
  const pkg = pkgName ?? basename(dir)
  const hints: RiskHint[] = []
  const seen = new Set<RiskRuleId>()
  const notes: string[] = []

  let manifest: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      manifest = parsed as Record<string, unknown>
    }
  } catch (error) {
    notes.push(`读不到 package.json：${reasonOf(error)}`)
  }

  let patchText = ''
  try {
    patchText = await readFile(join(dir, 'cordis.patch.yml'), 'utf8')
  } catch {
    notes.push('没有读到 cordis.patch.yml（不是所有插件都带 patch，这本身不是问题）。')
  }

  const { files, notes: fileNotes, oversized } = await collectFiles(dir)
  notes.push(...fileNotes)
  const { scripts, dependencies } = manifestFields(manifest)
  const scriptValues = Object.values(scripts).join('\n')

  // ---- RV001：安装期脚本里出现下载 / 直接执行 --------------------------------
  // 合法的构建脚本也常这么写，所以只给 info，不升级 severity。
  const installScripts = Object.entries(scripts)
    .filter(([name]) => /^(pre|post)?install$|^prepare$/.test(name))
    .map(([, value]) => value)
    .join('\n')
  if (/\b(?:curl|wget)\b|\bsh\s+-c\b|\bnode\s+-e\b|\bbash\s+-c\b/.test(installScripts)) {
    pushOnce(hints, seen, {
      id: 'RV001', severity: 'info', title: '安装期脚本会下载或执行外部命令',
      detail: 'preinstall/install/postinstall/prepare 里出现了 curl、wget 或 shell -c；合法构建也常这样，但值得确认脚本内容。',
      where: 'package.json',
    })
  }

  // ---- RV002：脚本引用绝对路径或凭据位置 ------------------------------------
  if (/\$HOME\/\.ssh|\.ssh\/id_|\.aws\/credentials|\.env\b|id_rsa|(?:^|\s)\/(?:etc|root|Users)\//.test(scriptValues)) {
    pushOnce(hints, seen, {
      id: 'RV002', severity: 'warn', title: '脚本里出现凭据或系统路径',
      detail: 'scripts 引用了 .ssh / .aws / .env / /etc 等位置；确认它不是在读取或外传凭据。',
      where: 'package.json',
    })
  }

  // ---- RV003：非 registry 依赖 ---------------------------------------------
  const localDeps = Object.entries(dependencies)
    .filter(([, spec]) => /^(?:link:|file:|git\+|https?:)/.test(spec))
    .map(([name]) => name)
  if (localDeps.length > 0) {
    pushOnce(hints, seen, {
      id: 'RV003', severity: 'info', title: '依赖里有本地或远端非 registry 来源',
      detail: `${localDeps.slice(0, 3).join('、')} 指向 link:/file:/git+/http 来源；本地开发包常见，但发布版里应确认来路。`,
      where: 'package.json',
    })
  }

  // ---- RV004：疑似仿冒官方 scope -------------------------------------------
  const suspiciousScope = Object.keys(dependencies).find(name => {
    const match = /^@([^/]+)\//.exec(name)
    if (match === null) return false
    const scope = match[1]!
    return scope !== OFFICIAL_SCOPE && editDistance(scope, OFFICIAL_SCOPE) <= 1
  })
  if (suspiciousScope !== undefined) {
    pushOnce(hints, seen, {
      id: 'RV004', severity: 'info', title: '依赖 scope 与官方名只差一个字母',
      detail: `${suspiciousScope} 的 scope 与 @${OFFICIAL_SCOPE}/ 编辑距离 ≤ 1；可能是手误，也可能是 typosquatting，核对一下来源。`,
      where: 'package.json',
    })
  }

  // ---- RV005：本包要插入的 loader 条目 id 撞上已装包 -------------------------
  // 复用 scan.ts 的 parsePatchIds，保证与 PL002/PL003 用同一套解析口径。
  if (patchText.length > 0 && report !== undefined) {
    const ownInserts = parsePatchIds(patchText).inserts
    const others = report.bundles.filter(bundle => bundle.name !== pkg)
    const taken = new Set(others.flatMap(bundle => bundle.inserts))
    const clash = ownInserts.filter(id => taken.has(id))
    if (clash.length > 0) {
      pushOnce(hints, seen, {
        id: 'RV005', severity: 'warn', title: '要插入的 loader 条目 id 已被别的插件占用',
        detail: `${clash.slice(0, 3).join('、')} 在已装插件的 patch 里已出现；dsh 对同名 id 是 last-id-wins，后加载者会覆盖前者。`,
        where: 'cordis.patch.yml',
      })
    }
  }

  // ---- RV006：patch 触碰技能链路 --------------------------------------------
  if (patchText.length > 0 && parseSkillTouchpoints(patchText).length > 0) {
    pushOnce(hints, seen, {
      id: 'RV006', severity: 'warn', title: 'patch 会改动技能目录相关配置',
      detail: '这个插件的 patch 触碰了 skills / disabled / includeDefaultRoots 一类配置；装完如果技能突然消失，优先查它。',
      where: 'cordis.patch.yml',
    })
  }

  // ---- 逐文本文件的模式匹配 -------------------------------------------------
  // REMOTE_EXEC 与 HIDDEN 从 SD012 的实现里 import，避免两份正则各自漂移。
  const rawEsc = /\u001B/
  const unicodeTag = /[\u{E0000}-\u{E007F}]/u
  const dynamicCode = /\beval\s*\(|\bnew\s+Function\s*\(|\bchild_process\b|\bexecSync\s*\(/
  const credentialPath = /\.ssh\/id_|\.aws\/credentials|\.netrc\b|Library\/Keychains|\.docker\/config\.json|\/etc\/shadow/
  const exfilUrl = /https?:\/\/[^\s]{0,80}(?:token|secret|api[_-]?key|credential|password)/i

  for (const file of files) {
    const text = file.text

    for (const pattern of REMOTE_EXEC) {
      if (pattern.re.test(text)) {
        pushOnce(hints, seen, {
          id: 'RV007', severity: 'info', title: '正文里有「下载后直接执行」的写法',
          detail: `命中 ${pattern.label}；打包产物与文档示例也会命中，需人工看上下文。`,
          where: file.path,
        })
        break
      }
    }

    if (dynamicCode.test(text)) {
      pushOnce(hints, seen, {
        id: 'RV008', severity: 'info', title: '正文里有动态执行相关写法',
        detail: '出现 eval / new Function / child_process / execSync；打包后的 JS 几乎必然包含，单独看这条不能说明任何问题。',
        where: file.path,
      })
    }

    if (rawEsc.test(text) || unicodeTag.test(text) || HIDDEN.test(text)) {
      pushOnce(hints, seen, {
        id: 'RV009', severity: 'warn', title: '正文里有不可见或控制字符',
        detail: '裸 ESC、Unicode 标签字符、零宽或双向控制符会让「看过」不等于「看见」，正常文本几乎用不到。',
        where: file.path,
      })
    }

    if (credentialPath.test(text) || exfilUrl.test(text)) {
      pushOnce(hints, seen, {
        id: 'RV010', severity: 'warn', title: '正文里提到凭据路径或带凭证的 URL',
        detail: '确认相关代码只是举例说明，而不是真的读取凭据或把参数拼进外发请求。',
        where: file.path,
      })
    }
  }

  // ---- RV011：体积 / 数量越界 -----------------------------------------------
  if (oversized) {
    pushOnce(hints, seen, {
      id: 'RV011', severity: 'warn', title: '包内文件体积或数量超出扫描上限',
      detail: `单文件超过 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MiB、整包超过 ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MiB、或文件数超过 ${MAX_FILES}；超出部分没有被检查。`,
    })
  }

  // ---- RV012：patch 用 YAML 锚点 / 别名 / 多文档 -----------------------------
  // dsh 的 patch 解析对锚点支持有限，且多文档会让「后一个文档覆盖前一个」变得隐蔽。
  if (/&\w+|\s\*\w+|(?:\n|^)---\s*(?:\n|$)/.test(patchText)) {
    pushOnce(hints, seen, {
      id: 'RV012', severity: 'warn', title: 'patch 里出现 YAML 锚点、别名或多文档分隔',
      detail: '锚点/别名会改变解析结果，多文档可能让后一段静默覆盖前一段；建议改成显式写法。',
      where: 'cordis.patch.yml',
    })
  }

  const focus = report === undefined ? [] : focusConflicts(report, pkg)
  if (report === undefined) notes.push('没有传入当前 profile 的插件体检结果，冲突聚焦与 RV005 已跳过。')

  return { pkg, dir, hints, focus, notes }
}

/**
 * 把 `scanProfile` 的全量冲突里，涉及指定包的那些挑出来。
 *
 * `PluginConflict.involved`（scan.ts:59）已经按加载顺序列了所有涉及方，所以这里
 * 不需要改 scan.ts：过滤 + 去掉自己就是「冲突对方」。PL001/004/006 是单包自身
 * 问题，`counterpart` 会是空数组，报告里要 accordingly 写成「不涉及其他插件」。
 */
export function focusConflicts(report: PluginReport, pkg: string): ConflictFocus[] {
  return report.conflicts
    .filter(conflict => conflict.involved.includes(pkg))
    .map(conflict => ({
      conflict,
      counterpart: conflict.involved.filter(name => name !== pkg),
    }))
}

/** 纯文本（斜杠命令）用：会话流里的文本节点不渲染表格，只能用缩进列表。 */
export function reviewPlainLines(result: ReviewResult): string[] {
  const lines = [
    `插件审查 · ${result.pkg}（静态启发式风险提示，非安全结论）`,
    '· 边界：只支持已落盘目录、不解析 .tgz、不拦截安装、不执行被审代码',
    '',
    `风险提示（${result.hints.length} 条）`,
  ]
  if (result.hints.length === 0) {
    lines.push('· 没有命中静态规则；这不代表包是安全的。')
  } else {
    for (const hint of result.hints.slice(0, 12)) {
      lines.push(`· [${hint.severity}] ${hint.id} ${hint.title}`)
      lines.push(`    ${hint.detail}`)
      if (hint.where !== undefined) lines.push(`    位置：${hint.where}`)
    }
    if (result.hints.length > 12) lines.push(`· …还有 ${result.hints.length - 12} 条`)
  }
  lines.push('', `冲突聚焦（${result.focus.length} 条）`)
  if (result.focus.length === 0) {
    lines.push('· 当前 profile 的结构性冲突里没有涉及这个包。')
  } else {
    for (const item of result.focus.slice(0, 8)) {
      lines.push(`· [${item.conflict.severity}] ${item.conflict.rule} ${item.conflict.title}`)
      lines.push(`    ${item.conflict.detail}`)
      lines.push(`    对方：${item.counterpart.length === 0 ? '不涉及其他插件' : item.counterpart.join('、')}`)
    }
  }
  for (const note of result.notes.slice(0, 3)) lines.push('', `说明：${note}`)
  lines.push('', '结论：以上只是静态提示，命中不等于恶意；是否安装请自行复核。')
  return lines
}

/** 完整 Markdown 报告用：作为独立章节追加，不改 plugin_doctor 原有的 verdict。 */
export function reviewMarkdownLines(result: ReviewResult): string[] {
  const lines = [
    '## 安装审查（新包）',
    '',
    `> **静态启发式风险提示，不是安全结论。** 不替代安全审查，不判定恶意代码，` +
      '不拦截安装、不回滚、不删文件；只支持已落盘的目录，不解析 `.tgz`。',
    '',
    `审查对象：\`${result.pkg}\`；命中 ${result.hints.length} 条提示、${result.focus.length} 条冲突。`,
    '',
  ]
  for (const hint of result.hints) {
    lines.push(`- **${hint.severity.toUpperCase()} ${hint.id}** ${hint.title}${hint.where === undefined ? '' : `（\`${hint.where}\`）`}`)
    lines.push(`  - ${hint.detail}`)
  }
  if (result.hints.length === 0) lines.push('- 没有命中静态规则；这不代表包是安全的。')
  lines.push('', '**与已装插件的冲突**', '')
  for (const item of result.focus) {
    lines.push(`- **${item.conflict.rule}** ${item.conflict.title}：${item.conflict.detail}`)
    lines.push(`  - 对方：${item.counterpart.length === 0 ? '不涉及其他插件' : item.counterpart.map(name => `\`${name}\``).join('、')}`)
  }
  if (result.focus.length === 0) lines.push('- 当前 profile 的结构性冲突里没有涉及这个包。')
  for (const note of result.notes) lines.push(`- 说明：${note}`)
  lines.push('')
  return lines
}

/** JSON 输出用；`dir` 刻意不输出绝对路径，只给包名与包内相对位置。 */
export function reviewJson(result: ReviewResult): Record<string, unknown> {
  return {
    pkg: result.pkg,
    disclaimer: 'static heuristics only; not a security verdict',
    hints: result.hints.map(hint => ({ ...hint })),
    focus: result.focus.map(item => ({
      rule: item.conflict.rule,
      severity: item.conflict.severity,
      title: item.conflict.title,
      detail: item.conflict.detail,
      counterpart: [...item.counterpart],
    })),
    notes: [...result.notes],
  }
}

/**
 * 最近一次审查结果（模块级内存缓存）。
 *
 * 自动订阅到 `plugin-manager/changed` 后把结果放这里，并只写一行 logger.info；
 * 用户随后用 `/review`（不带参数）、CLI 或 `plugin_doctor` 主动查。刻意不主动
 * 往会话里推消息：那需要 Host 侧注入会话的 API，未验证，且会在每次装插件时
 * 打断用户。缓存只保留最后一次，不做持久化，重启即失效。
 */
let lastReview: ReviewResult | undefined

export function setLastReview(result: ReviewResult): void {
  lastReview = result
}

export function getLastReview(): ReviewResult | undefined {
  return lastReview
}

/**
 * 订阅安装完成事件（**尽力而为，探测不到就完全跳过**）。
 *
 * 三条已核实的 Host 事实决定了这里的写法：
 * 1. `plugin-manager/changed` 的 payload 是 `PluginChange { reason }`，**不含包名**
 *    （`packages/boot/plugin-manager/src/types.ts:244-247`）。所以只能对比前后
 *    `scanProfile` 的 bundles 名集合，差集里的新名字就是新装的包；差集为空就跳过，
 *    绝不猜。
 * 2. 官方文档 `docs/subsystems/boot.zh.md:274` 明写「CLI 或手工编辑引发的 HMR
 *    patch 不会发这个事件」，所以自动审查只覆盖插件页安装。
 * 3. 订阅走**进程内的 Cordis 事件表**（`ctx.on`），不是 Web 侧的转发面。
 *    这一点曾经被误判成「有 ACL 风险」，实际不是：`Context.extend()` 用
 *    `Object.create(parent)` 建子上下文（`vendor/cordis/src/context.ts:99-101`），
 *    而 `events` 是 root 的 own property（`context.ts:81`），所以整棵 ctx 树
 *    解析到**同一个** EventsService，`_hooks` 是一张全局表；`emit` 的首参数是
 *    事件名（不是带 `Context.filter` 的对象）时不做上下文过滤
 *    （`vendor/cordis/src/events.ts:165-175`）。因此任何 ctx 上的监听都能收到
 *    任何 ctx 的 emit，与加载顺序、是否兄弟上下文无关，也不需要 inject。
 *    带访问控制的是 `ctx.remote.$on`，那属于渲染进程（`packages/api/gateway/
 *    src/client/remote-events.ts` 的 ClientRemoteEvents），Host 插件不该走。
 *    `ctx.on` 是 Cordis 内建方法，所以也无需软探测后降级到别的通道；
 *    只有它在（不可能）时才跳过，`inject` 始终不加 `remote`。
 *
 * 结果不主动推给会话：放模块级缓存 + 一行 logger.info，由 `/review`、
 * CLI `--review` 或 `plugin_doctor` 主动查。这样既不打扰用户，也不依赖未验证的
 * 「往会话注入消息」API。
 */
export function registerInstallWatch(ctx: Context): void {
  // 只需要 `ctx.on`：它是 Cordis 内建的事件注册方法，必然存在。这里仍用结构化
  // 断言而不是 `ctx.on(...)` 直接调用，只为两件事：
  // - 本事件的 `Events` 类型增强在 doctor 的编译期不一定可见（不 import
  //   `@deepseek-ai/dsh-plugin-manager` 就拿不到声明合并），断言后不必用 as any；
  // - 老到没有事件服务的运行时里，缺 on 就整段跳过，而不是抛出把插件加载搞挂。
  const probe = ctx as unknown as {
    on?: (event: string, handler: (change: unknown) => void) => unknown
    logger: { info: (message: string) => void; warn: (message: string) => void }
  }

  if (typeof probe.on !== 'function') {
    probe.logger.info('skill-doctor: install-watch unavailable — automatic review disabled, use /review instead')
    return
  }

  // 记住上一次的 bundles 名集合。第一次不做审查：插件启动时 profile 里已有的包
  // 不是「刚下载的」，全量报一遍只会制造噪音。
  let previousNames: ReadonlySet<string> | undefined

  const handler = (change: unknown): void => {
    const reason = (change as { reason?: unknown } | null)?.reason
    if (reason !== 'install' && reason !== 'bundle') return

    void (async () => {
      try {
        const profile = profileNameOf(ctx) ?? 'desktop'
        const report = await scanProfile(profile)
        const current = new Set(report.bundles.map(bundle => bundle.name))
        const added = previousNames === undefined
          ? []
          : [...current].filter(name => !previousNames!.has(name))
        previousNames = current
        if (added.length === 0) return

        // 只审最后一个新增项：一次安装通常只加一个包，事件可能连发多次。
        const name = added[added.length - 1]!
        const dir = join(profileDirOf(profile), 'node_modules', name)
        const result = await reviewBundle(dir, report, name)
        setLastReview(result)
        probe.logger.info(
          `skill-doctor: reviewed newly installed ${name} — `
          + `${result.hints.length} hints, ${result.focus.length} conflicts (run /review for details)`,
        )
      } catch (error) {
        // 审查失败绝不能影响插件本体；写一行 warn 即可。
        probe.logger.warn(
          `skill-doctor: automatic review failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    })()
  }

  try {
    // 只订阅，**不要**把返回值再交给 `ctx.effect`。
    //
    // `ctx.on` 内部已经用 `this.ctx.fiber.effect(...)` 注册了注销
    // （`vendor/cordis/src/events.ts:254-260`），返回的就是 disposer 本身；
    // 而 `ctx.effect(callback)` 接收的是「**返回** disposer 的函数」
    // （`vendor/cordis/src/fiber.ts:83-93`），会立刻调用 callback。
    // 把 disposer 传进去等于当场执行注销——监听刚注册就被删掉，
    // 自动审查永远不会触发，而且全程不报错，只有「装完没反应」这一种表现。
    probe.on.call(ctx, 'plugin-manager/changed', handler)
  } catch (error) {
    probe.logger.warn(
      `skill-doctor: cannot subscribe to plugin-manager/changed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
