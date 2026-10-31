/**
 * 处方分级：把“怎么改”分成三类，让用户一眼看出哪些能一键解决。
 *
 * - `autofix`：CLI 能直接改，dry-run 出计划、`--apply` 才写，带备份与回滚。
 * - `command`：一条命令就能解决，复制粘贴即可。
 * - `manual` ：没有唯一答案，只能人来判断（改写文案、取舍同名、决定条目归属）。
 *
 * 为什么单独建一张表、而不是给 `Finding` 加字段：
 * 处方依赖运行环境（有没有 CLI、profile 叫什么是运行期才知道的），
 * 把它塞进扫描层会让 pure 的规则实现绑死命令行工具。
 */
import type { RuleId } from '../types.js'

/** 处方的三类。 */
export type PrescriptionKind = 'autofix' | 'command' | 'manual'

/** 一条处方：类别 + 给人看的标签。 */
export interface Prescription {
  readonly kind: PrescriptionKind
  readonly label: string
}

/** 三类处方的显示文案。 */
const KIND_LABEL: Record<PrescriptionKind, string> = {
  autofix: '🔧 能自动修',
  command: '🖥 一条命令',
  manual: '✍️ 只能人工改',
}

/** 插件规则 ID；技能规则来自 `RuleId`。 */
export type PluginRuleId = 'PL001' | 'PL002' | 'PL003' | 'PL004' | 'PL005'

/**
 * 规则 → 处方类别。
 *
 * 判定标准很窄，只有“改法唯一”才给 autofix；
 * 能跑一条命令解决的给 command；其余一律 manual，宁可保守也不假装能自动修。
 */
const KIND_BY_RULE: Readonly<Record<RuleId | PluginRuleId, PrescriptionKind>> = {
  // 技能侧
  SD001: 'manual', // 文件头结构坏了，要看懂原意才能补
  SD002: 'manual', // 改名会打断已有引用，得人来决定
  SD003: 'manual', // 简介内容要写
  SD004: 'manual', // 触发词怎么措辞是语义活
  SD005: 'manual',
  SD006: 'manual',
  SD007: 'manual', // 拆技能还是精简，是结构决策
  SD008: 'manual', // 补文件还是改路径，取决于意图
  SD009: 'manual', // 同名留哪个是产品决策
  SD010: 'manual', // 值猜不出意图；旧字段名要取反
  SD011: 'manual',
  SD012: 'manual', // 安全类，绝不自动改
  SD013: 'autofix', // BOM：删掉开头 3 字节
  SD014: 'autofix', // CRLF：\r\n → \n
  SD015: 'manual',
  // 插件侧
  PL001: 'manual', // 改 profile 的 package.json，属于 dsh 自己的状态文件
  PL002: 'manual', // 谁该让位是插件作者的事
  PL003: 'manual',
  PL004: 'command', // enable / remove / add，一条命令解决
  PL005: 'manual', // 预留规则，目前不产出
}

/** 查一条规则的处方类别；未知规则一律按人工处理。 */
export function prescribeKind(rule: string): PrescriptionKind {
  return (KIND_BY_RULE as Readonly<Record<string, PrescriptionKind>>)[rule] ?? 'manual'
}

/** 查一条规则的完整处方。 */
export function prescriptionOf(rule: string): Prescription {
  const kind = prescribeKind(rule)
  return { kind, label: KIND_LABEL[kind] }
}

/**
 * 自动修的命令提示。
 * @param directory - 技能所在目录；拿不到（例如 dsh 自带的虚拟技能）时用占位符。
 */
export function autofixHint(directory: string | undefined): string {
  const target = directory === undefined ? '<技能目录>' : `"${directory}"`
  return `先跑 \`dsh-skill-lint ${target} --fix\` 看计划，确认没问题再加 \`--apply\``
}

/**
 * 把 finding 的建议包成一行处方文案。
 * @param rule - 规则 ID。
 * @param suggestion - 规则自带的改法。
 * @param directory - 技能所在目录，autofix 的命令要用。
 */
export function prescriptionLine(rule: string, suggestion: string | undefined, directory?: string): string {
  const { kind, label } = prescriptionOf(rule)
  if (kind === 'autofix') return `${label} — ${autofixHint(directory)}`
  if (suggestion === undefined) return label
  return `${label} — ${suggestion}`
}
