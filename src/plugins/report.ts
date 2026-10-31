/** 插件体检报告渲染：和技能报告同一套语言——第一屏人话，技术细节收在文末。 */
import type { PluginConflict, PluginReport } from './scan.js'
import { sortConflicts } from './scan.js'

const SEVERITY_MARK = { error: '⛔', warn: '⚠️', info: '💡' } as const

/** 结论句：一句话说清有没有冲突、是哪一类。 */
function verdict(report: PluginReport, conflicts: readonly PluginConflict[]): string {
  const errors = conflicts.filter(item => item.severity === 'error').length
  const warns = conflicts.filter(item => item.severity === 'warn').length
  if (report.bundles.length === 0 && report.conflicts.length === 0) {
    return '这个 profile 里没有装任何插件。'
  }
  if (errors > 0) return `有 ${errors} 个严重问题，插件可能根本装不起来。`
  if (warns > 0) {
    const kinds = [...new Set(conflicts.filter(item => item.severity === 'warn').map(item => item.title))]
    return `发现 ${warns} 处冲突：${kinds.join('、')}。`
  }
  if (conflicts.length > 0) return '没有冲突，只有几条“装了但没启用”的提示。'
  return '没发现冲突：这些插件的 loader 条目互不重叠。'
}

/** 来源列：link:/file: 原样显示，纯版本号标成 registry，没有 spec 说明是自带。 */
function formatSource(source: string | undefined): string {
  if (source === undefined) return '（自带）'
  if (source.startsWith('link:') || source.startsWith('file:') || source.startsWith('git')) return source
  return `registry ${source}`
}

/** 一行插件清单。 */
function bundleRow(bundle: PluginReport['bundles'][number]): string {
  const version = bundle.version ?? '?'
  const state = bundle.availability === 'missing'
    ? '**包缺失**'
    : bundle.availability === 'shipped' ? 'dsh 自带' : '已启用'
  return `| \`${bundle.name}\` | ${version} | ${formatSource(bundle.source)} | ${state} |`
}

/** 单条冲突展开成“涉及/现在/怎么改”。 */
function conflictBlock(conflict: PluginConflict, index: number): string[] {
  return [
    `${index}. ${SEVERITY_MARK[conflict.severity]} **${conflict.title}**`,
    `   涉及：${conflict.involved.map(name => `\`${name}\``).join('、')}`,
    `   现在：${conflict.detail}`,
    ...conflict.suggestion === undefined ? [] : [`   怎么改：${conflict.suggestion}`],
    '',
  ]
}

/** Markdown 报告（通俗风格）。 */
export function renderPluginMarkdown(report: PluginReport): string {
  const conflicts = sortConflicts(report.conflicts)
  const blocking = conflicts.filter(item => item.severity !== 'info')
  const info = conflicts.filter(item => item.severity === 'info')

  const lines: string[] = [
    `# 插件体检：${report.profileName} profile`,
    '',
    `**结论：${verdict(report, conflicts)}**`,
    '',
    `## 装了哪些插件（${report.bundles.length} 个）`,
    '',
    '| 插件 | 版本 | 来源 | 状态 |',
    '|---|---|---|---|',
    ...report.bundles.map(bundleRow),
    '',
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
export function renderPluginJson(report: PluginReport): string {
  return JSON.stringify({
    profile: report.profileName,
    profileDir: report.profileDir,
    bundles: report.bundles,
    conflicts: report.conflicts,
    notes: report.notes,
  }, null, 2)
}
