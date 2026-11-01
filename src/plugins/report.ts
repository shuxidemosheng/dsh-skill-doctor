/** 插件体检报告渲染：和技能报告同一套语言——第一屏人话，技术细节收在文末。 */
import type { PluginConflict, PluginReport } from './scan.js'
import { sortConflicts } from './scan.js'
import type { RuntimeSummary } from './runtime.js'
import { prescriptionLine, prescriptionOf } from '../tools/prescriptions.js'

const SEVERITY_MARK = { error: '⛔', warn: '⚠️', info: '💡' } as const

/** 结论句：一句话说清有没有冲突、是哪一类。 */
function verdict(
  report: PluginReport,
  conflicts: readonly PluginConflict[],
  runtime: RuntimeSummary | undefined,
): string {
  const errors = conflicts.filter(item => item.severity === 'error').length
  const warns = conflicts.filter(item => item.severity === 'warn').length
  // 运行时失败是唯一"已经确定坏了"的证据，优先级高于磁盘上的结构问题。
  if (runtime !== undefined && runtime.failed.length > 0) {
    return `有 ${runtime.failed.length} 个插件启动了但失败，它们提供的功能不会出现。`
  }
  if (report.bundles.length === 0 && report.conflicts.length === 0) {
    return '这个 profile 里没有装任何插件。'
  }
  if (errors > 0) return `有 ${errors} 个严重问题，插件可能根本装不起来。`
  if (warns > 0) {
    const kinds = [...new Set(conflicts.filter(item => item.severity === 'warn').map(item => item.title))]
    return `发现 ${warns} 处冲突：${kinds.join('、')}。`
  }
  if (conflicts.length > 0) return '没有冲突，只有几条“装了但没启用”的提示。'
  // 没查到运行时状态时，结论必须带限定，否则会被读成“一定没问题”。
  const caveat = runtime !== undefined && runtime.status !== 'ok'
    ? '（磁盘上没有冲突；运行时状态这次没查到）'
    : ''
  return `没发现冲突：这些插件的 loader 条目互不重叠${caveat}。`
}

/** 来源列：link:/file: 原样显示，纯版本号标成 registry，没有 spec 说明是自带。 */
function formatSource(source: string | undefined): string {
  if (source === undefined) return '（自带）'
  if (source.startsWith('link:') || source.startsWith('file:') || source.startsWith('git')) return source
  return `registry ${source}`
}

/** 报告摘要表：先给能一眼扫完的几行，再展开细节。 */
function summaryTable(
  report: PluginReport,
  conflicts: readonly PluginConflict[],
  runtime: RuntimeSummary | undefined,
): string[] {
  const shipped = report.bundles.filter(bundle => bundle.availability === 'shipped').length
  const missing = report.bundles.filter(bundle => bundle.availability === 'missing').length
  const local = report.bundles.length - shipped - missing
  const error = conflicts.filter(item => item.severity === 'error').length
  const warn = conflicts.filter(item => item.severity === 'warn').length
  const runtimeCell = runtime === undefined
    ? '命令行模式，不检查'
    : runtime.status === 'ok'
      ? `${runtime.enabled} 个在跑${runtime.failed.length > 0 ? `，**${runtime.failed.length} 个失败**` : ''}`
      : `**没查到**（${runtime.status === 'unavailable' ? '这个 dsh 没暴露' : runtime.status === 'timeout' ? '读取超时' : '读取出错'}）`
  return [
    '| 项目 | 情况 |',
    '|---|---|',
    `| Profile | \`${report.profileName}\` |`,
    `| 插件 | ${report.bundles.length} 个（本地 ${local} / dsh 自带 ${shipped} / 缺失 ${missing}） |`,
    `| 运行时 | ${runtimeCell} |`,
    `| 冲突 | ${error > 0 ? `**${error} 个严重**` : '0 个严重'}，${warn} 个警告 |`,
    `| 结论 | ${verdict(report, conflicts, runtime)} |`,
    '',
  ]
}

/** 一行插件清单。 */
function bundleRow(bundle: PluginReport['bundles'][number]): string {
  const version = bundle.version ?? '?'
  const state = bundle.availability === 'missing'
    ? '**包缺失**'
    : bundle.availability === 'shipped' ? 'dsh 自带' : '已启用'
  return `| \`${bundle.name}\` | ${version} | ${formatSource(bundle.source)} | ${state} |`
}

/** 单条冲突展开成“涉及/现在/处方”。 */
function conflictBlock(conflict: PluginConflict, index: number): string[] {
  return [
    `${index}. ${SEVERITY_MARK[conflict.severity]} **${conflict.title}**`,
    `   涉及：${conflict.involved.map(name => `\`${name}\``).join('、')}`,
    `   现在：${conflict.detail}`,
    `   处方：${prescriptionLine(conflict.rule, conflict.suggestion)}`,
    '',
  ]
}

/**
 * 运行时状态章节。
 *
 * 这一节的主基调是「没查到 ≠ 没问题」：探测失败时必须明确写出缺失，
 * 否则用户会把"没报错"读成"插件都在正常运行"。
 */
function runtimeSection(runtime: RuntimeSummary | undefined): string[] {
  if (runtime === undefined) {
    return [
      '## 运行时状态',
      '',
      '命令行模式读不到运行时状态（`dsh-skill-lint` 不在 dsh 进程里）。',
      '**这不等于插件都正常**：上面的结论只基于磁盘文件，插件可能装了却没跑起来——这一项要在会话里用 `plugin_doctor` 才查得到。',
      '',
    ]
  }

  const lines = ['## 运行时状态', '']

  if (runtime.status !== 'ok') {
    lines.push(`这次没查到：${runtime.note ?? '运行时服务不可用。'}`)
    if (runtime.toolCount !== null) lines.push('', `当前会话可见的工具：${runtime.toolCount} 个。`)
    lines.push(
      '',
      '**这不等于“没问题”**：下面的结论都只基于磁盘文件，插件完全可能装了却没跑起来。',
      '',
    )
    return lines
  }

  const phases = Object.entries(runtime.phases)
    .map(([phase, count]) => `${phase} ${count}`)
    .join('、')
  lines.push(
    `- 正在运行：${runtime.enabled} 个插件`,
    `- 阶段分布：${phases.length > 0 ? phases : '（空）'}`,
    `- 清单能对上：${runtime.matched} / ${runtime.declared}`,
  )
  if (runtime.toolCount !== null) lines.push(`- 当前会话可见的工具：${runtime.toolCount} 个`)
  lines.push('')

  if (runtime.failed.length > 0) {
    lines.push(
      '### ⛔ 启动了但失败',
      '',
      ...runtime.failed.map(name => `- \`${name}\``),
      '',
      '这些插件的 fiber 阶段是 failed，它们注册的工具不会出现在会话里。',
      '失败原因 dsh 没有投影出来（运行时状态只有阶段、没有错误信息），只能看桌面端启动时的输出。',
      '',
    )
  }

  if (runtime.missingOwnTools.length > 0) {
    lines.push(
      '### 💡 本插件有工具不在当前会话里',
      '',
      ...runtime.missingOwnTools.map(name => `- \`${name}\``),
      '',
      '两种可能：被别的插件的同名工具占了（本插件会主动让位），或者被当前 agent 的工具范围隐藏了。',
      '注册表不记录“工具是谁注册的”，所以没法进一步区分。',
      '',
    )
  }

  if (runtime.matched < runtime.declared) {
    lines.push(
      `磁盘清单里有 ${runtime.declared - runtime.matched} 个 bundle 在运行时快照里没对上。`,
      'dsh 自带的插件（`@deepseek-ai/*`）模块名常与清单写法不同，这种情况不用管；',
      '如果没有“启动了但失败”的项，通常说明它们只是换了名字或还没加载。',
      '',
    )
  }

  return lines
}

/**
 * 会诊章节：技能 × 插件交叉。
 *
 * skill_doctor 管技能、这里管插件，两边单独看都可能"没问题"——
 * 但真实的故障经常跨这两层：某个插件的 patch 把技能目录改了，
 * 技能报告只会显示"0 个技能"，看起来像技能坏了，根因却在插件层。
 * 这一节把所有会改变"会话里能看到哪些技能"的插件层改动摆到一张桌子上。
 */
function consultationSection(report: PluginReport): string[] {
  const lines: string[] = ['## 会诊：技能链路交叉检查', '']
  const points = report.bundles.flatMap(bundle =>
    bundle.skillTouchpoints.map(point => ({ bundle: bundle.name, ...point })))

  if (points.length === 0) {
    lines.push(
      '插件层没有任何会改变技能链路的 patch：没人动技能目录配置，也没人禁用技能条目。',
      '如果技能消失了，原因**不在插件配置层**——回到技能文件本身，用 `skill_doctor` 查。',
      '',
    )
    return lines
  }

  lines.push(
    '`skill_doctor` 管技能，这里管插件；真实的故障经常跨这两层。技能报告只会显示"0 个技能"，',
    '看不出是插件把目录改了。下面是所有会改变"会话里能看到哪些技能"的插件层改动：',
    '',
  )
  for (const point of points) {
    lines.push(`- \`${point.bundle}\` → \`${point.entryId}.${point.key}\` = \`${point.value}\``)
  }
  lines.push('')

  const pl006 = report.conflicts.filter(conflict => conflict.rule === 'PL006')
  lines.push(pl006.length > 0
    ? `**其中 ${pl006.length} 处会造成技能消失**（见上面的冲突列表）：如果你的现象正是"技能看不见/变少了"，根因大概率在这里，而不是技能文件本身。`
    : '这些改动看起来是有意配置的，不一定是故障；但如果你现在的现象是"技能看不见/变少了"，先对照上面这几行——根因多半在插件层，而不是技能文件本身。')
  lines.push('')
  return lines
}

/** Markdown 报告（通俗风格）。 */
export function renderPluginMarkdown(report: PluginReport, runtime?: RuntimeSummary): string {
  const conflicts = sortConflicts(report.conflicts)
  const blocking = conflicts.filter(item => item.severity !== 'info')
  const info = conflicts.filter(item => item.severity === 'info')

  const lines: string[] = [
    `# 插件体检：${report.profileName} profile`,
    '',
    `**结论：${verdict(report, conflicts, runtime)}**`,
    '',
    ...summaryTable(report, conflicts, runtime),
    `## 装了哪些插件（${report.bundles.length} 个）`,
    '',
    '| 插件 | 版本 | 来源 | 状态 |',
    '|---|---|---|---|',
    ...report.bundles.map(bundleRow),
    '',
    ...runtimeSection(runtime),
  ]

  if (blocking.length > 0) {
    lines.push(`## 冲突（${blocking.length} 处）`, '')
    blocking.forEach((conflict, index) => lines.push(...conflictBlock(conflict, index + 1)))
  }

  if (info.length > 0) {
    lines.push(`## 需要注意（${info.length} 条）`, '')
    info.forEach((conflict, index) => lines.push(...conflictBlock(conflict, index + 1)))
  }

  if (blocking.length === 0 && info.length === 0) {
    lines.push('没有发现冲突。', '')
  }

  lines.push(...consultationSection(report))

  lines.push('---', '', '## 技术细节（可跳过）', '')
  lines.push(`- profile 目录：${report.profileDir}`)
  const shipped = report.bundles.filter(bundle => bundle.availability === 'shipped').length
  const missing = report.bundles.filter(bundle => bundle.availability === 'missing').length
  const local = report.bundles.length - shipped - missing
  lines.push(`- 插件数：${report.bundles.length}（profile 自带 ${local} / dsh 自带 ${shipped} / 缺失 ${missing}）`)
  const inserts = new Set(report.bundles.flatMap(bundle => bundle.inserts))
  const patches = new Set(report.bundles.flatMap(bundle => bundle.patches))
  lines.push(`- loader 条目：新增 ${inserts.size} 个、修改 ${patches.size} 个`)
  lines.push('- 只分析结构性冲突（同一条目被抢/被改、重复安装、装了没启用）。工具名被两个插件同时注册属于运行时冲突，注册表不暴露归属，这里查不到。')
  if (shipped > 0) lines.push('- dsh 自带的插件（@deepseek-ai/*）包在应用内，读不到它们的 patch，条目冲突只在 profile 插件之间比对。')
  for (const note of report.notes) lines.push(`- 注意：${note}`)
  // 自带插件的说明已经在上面合并成一句，这里只补“真正有问题”的单个插件。
  for (const bundle of report.bundles) {
    if (bundle.note !== undefined && bundle.availability !== 'shipped') {
      lines.push(`- ${bundle.name}：${bundle.note}`)
    }
  }

  return lines.join('\n').trimEnd()
}

/** JSON 输出：字段稳定，给脚本用。 */
export function renderPluginJson(report: PluginReport, runtime?: RuntimeSummary): string {
  return JSON.stringify({
    profile: report.profileName,
    profileDir: report.profileDir,
    bundles: report.bundles,
    conflicts: report.conflicts.map(conflict => ({
      ...conflict,
      prescription: prescriptionOf(conflict.rule),
    })),
    notes: report.notes,
    ...runtime === undefined ? {} : { runtime },
  }, null, 2)
}
