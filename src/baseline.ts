/**
 * 病历与复诊：把一次体检的结果存下来，下次对照着看。
 *
 * 为什么要做这个：13 个"简介超长"修完 11 个之后再跑一次，报告还是一堆
 * "还有 2 个超长"——用户看不出"修好了 11 个"这个最重要的事实。医生看复诊
 * 单，看的是和上次的差值：哪些好了、哪些没动、哪些新冒出来。
 *
 * 纪律：
 *  - 病历只由 CLI `--save` 显式写出（插件工具保持只读，绝不写任何文件）；
 *  - 工具侧只允许**读**病历（config.baseline），读不到就跳过对比，不影响体检；
 *  - 对比按规则聚合（和聚类同一哲学：按根因看，不按个数看），
 *    只有"变差"才点名具体技能——那是需要立刻看的新问题。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { ResolvedConfig } from './config.js'
import { dshHome } from './plugins/scan.js'
import { RULES, RULE_IDS } from './scanner/rules.js'
import type { ScanResult, Severity, SkillLintResult } from './types.js'

/** 病历文件格式版本；以后字段变更时用它做兼容判断。 */
const FORMAT_VERSION = 1

/** 病历里单个技能的快照。 */
export interface BaselineSkillRecord {
  readonly errors: number
  readonly warnings: number
  readonly infos: number
  /** ruleId → 这条规则在该技能上命中几次。 */
  readonly rules: Readonly<Record<string, number>>
}

/** 保存病历时的检查口径；口径不同，数字不可直接比。 */
export interface BaselineMeta {
  readonly severity: Severity
  /** 启用的规则；全部启用时是 ['*']。 */
  readonly rules: readonly string[]
}

/** 病历文件（JSON 落盘的形状）。 */
export interface BaselineFile {
  readonly version: number
  readonly savedAt: string
  readonly meta: BaselineMeta
  /** 技能名 → 快照；同名遮蔽时只留赢家，与体检报告的口径一致。 */
  readonly skills: Readonly<Record<string, BaselineSkillRecord>>
}

/** 一条规则在两次体检之间的变化。 */
export interface RuleDelta {
  readonly rule: string
  readonly plainTitle: string
  readonly before: number
  readonly after: number
}

/** 复诊对比结果。 */
export interface BaselineDiff {
  /** 命中变少（after < before），按降幅排序。 */
  readonly improved: readonly RuleDelta[]
  /** 命中数没变（> 0），说明还没动。 */
  readonly unchanged: readonly RuleDelta[]
  /** 命中变多（after > before），按增幅排序。 */
  readonly regressed: readonly RuleDelta[]
  /** "变差"规则的点名：这次新命中的技能，每条最多 3 个。 */
  readonly regressedSkills: Readonly<Record<string, readonly string[]>>
  readonly newSkills: readonly string[]
  readonly goneSkills: readonly string[]
  readonly totalBefore: number
  readonly totalAfter: number
  readonly errorsBefore: number
  readonly errorsAfter: number
  /** 口径不一致时的提醒；一致则没有这个字段。 */
  readonly metaWarning?: string
}

/** 展开 `~` 开头的路径；其他路径原样返回。 */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return joinHome(path.slice(2))
  }
  return path
}

/**
 * `baseline: auto` 时的病历路径：`$DSH_HOME/skill-doctor/record-<profile>.json`。
 *
 * 为什么要支持 auto：复诊的第一版只给了 CLI `--save`，插件用户被迫开终端——
 * 违背"会话内一个入口"。auto 模式下病历由插件自动维护（每次体检先读旧、后写新），
 * 用户只需在 patch 里配一次 `baseline: auto`，之后复诊完全无感。
 * 按 profile 分文件：desktop 和 headless 的技能集合不同，病历不能混。
 */
export function autoRecordPath(profile: string): string {
  return resolve(dshHome(), 'skill-doctor', `record-${profile}.json`)
}

/**
 * 从配置值算出病历文件路径。
 *
 * 三种取值：`auto`（默认，按 profile 分文件）、`off`（关闭，返回 undefined）、
 * 具体路径（支持 `~`）。工具与斜杠命令共用同一套判断，避免出现"工具写 auto、
 * 命令写别处"这种两份病历各记一半的情况。
 * @param baseline - `ResolvedConfig.baseline`。
 * @param profile - 当前 profile 名；拿不到时退回 `default`。
 */
export function recordPathOf(baseline: string, profile: string | undefined): string | undefined {
  if (baseline === 'off') return undefined
  return baseline === 'auto' ? autoRecordPath(profile ?? 'default') : expandHome(baseline)
}

/**
 * 把病历写到磁盘。auto 模式由 skill_doctor 在每次体检后调用，
 * CLI `--save` 也用它；写之前先建目录（第一次跑时 skill-doctor/ 还不存在）。
 */
export async function saveBaseline(path: string, baseline: BaselineFile): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
}

function joinHome(rest: string): string {
  return resolve(homedir(), rest)
}

/** 把一次扫描结果压成病历快照。 */
export function buildBaseline(
  result: ScanResult,
  meta: BaselineMeta,
  savedAt = new Date().toISOString(),
): BaselineFile {
  const skills: Record<string, BaselineSkillRecord> = {}
  for (const item of result.results) {
    const rules: Record<string, number> = {}
    for (const finding of item.findings) {
      rules[finding.rule] = (rules[finding.rule] ?? 0) + 1
    }
    skills[item.skill.name] = {
      errors: item.errors,
      warnings: item.warnings,
      infos: item.infos,
      rules,
    }
  }
  return { version: FORMAT_VERSION, savedAt, meta, skills }
}

/**
 * 读一份病历；任何失败（不存在 / 坏 JSON / 版本不认识）都返回 undefined。
 * 对比是锦上添花，读不到绝不能让体检本身失败。
 */
export async function loadBaseline(path: string): Promise<BaselineFile | undefined> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
  const file = raw as { version?: unknown; savedAt?: unknown; meta?: unknown; skills?: unknown }
  if (file.version !== FORMAT_VERSION || typeof file.savedAt !== 'string' || !isPlainObject(file.skills)) {
    return undefined
  }
  const meta = isPlainObject(file.meta)
    ? {
        severity: (typeof file.meta.severity === 'string' ? file.meta.severity : 'info') as Severity,
        rules: Array.isArray(file.meta.rules) ? file.meta.rules.filter((item): item is string => typeof item === 'string') : ['*'],
      }
    : { severity: 'info' as Severity, rules: ['*'] as const }
  const skills: Record<string, BaselineSkillRecord> = {}
  for (const [name, value] of Object.entries(file.skills)) {
    if (!isPlainObject(value) || !isPlainObject(value.rules)) continue
    const rules: Record<string, number> = {}
    for (const [rule, count] of Object.entries(value.rules)) {
      if (typeof count === 'number' && Number.isFinite(count)) rules[rule] = count
    }
    skills[name] = {
      errors: numberOrZero(value.errors),
      warnings: numberOrZero(value.warnings),
      infos: numberOrZero(value.infos),
      rules,
    }
  }
  return { version: FORMAT_VERSION, savedAt: file.savedAt, meta, skills }
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 当前这次体检的口径，写病历 / 对比时都要带上：
 * 病历是用哪把尺子量的，对比时才知道数字可不可比。
 */
export function currentMetaOf(config: ResolvedConfig): BaselineMeta {
  const off = RULE_IDS.filter(rule => config.rules[rule] === 'off')
  return {
    severity: config.severityThreshold,
    rules: off.length === 0 ? ['*'] : RULE_IDS.filter(rule => !off.includes(rule)),
  }
}

/**
 * 复诊对比：按规则聚合两次体检的差值。
 * @param baseline - 上次的病历。
 * @param result - 这次的多技能扫描结果。
 * @param currentMeta - 这次的检查口径，用来发现"病历和这次不是同一把尺子"。
 */
export function diffBaseline(baseline: BaselineFile, result: ScanResult, currentMeta: BaselineMeta): BaselineDiff {
  const before: Map<string, number> = new Map()
  for (const record of Object.values(baseline.skills)) {
    for (const [rule, count] of Object.entries(record.rules)) {
      before.set(rule, (before.get(rule) ?? 0) + count)
    }
  }

  // 技能级：rule → 这次命中该规则的技能（用于"变差"点名）。
  const after: Map<string, number> = new Map()
  const hitSkills: Map<string, Set<string>> = new Map()
  const currentNames = new Set<string>()
  for (const item of result.results) {
    currentNames.add(item.skill.name)
    for (const finding of item.findings) {
      after.set(finding.rule, (after.get(finding.rule) ?? 0) + 1)
      const set = hitSkills.get(finding.rule) ?? new Set<string>()
      set.add(item.skill.name)
      hitSkills.set(finding.rule, set)
    }
  }

  const titleOf = (rule: string): string => RULES[rule as keyof typeof RULES]?.plainTitle ?? rule
  const allRules = [...new Set([...before.keys(), ...after.keys()])].sort()
  const improved: RuleDelta[] = []
  const unchanged: RuleDelta[] = []
  const regressed: RuleDelta[] = []
  const regressedSkills: Record<string, string[]> = {}

  for (const rule of allRules) {
    const was = before.get(rule) ?? 0
    const now = after.get(rule) ?? 0
    if (now < was) improved.push({ rule, plainTitle: titleOf(rule), before: was, after: now })
    else if (now > was) {
      regressed.push({ rule, plainTitle: titleOf(rule), before: was, after: now })
      const baselineNames = new Set(
        Object.entries(baseline.skills)
          .filter(([, record]) => (record.rules[rule] ?? 0) > 0)
          .map(([name]) => name),
      )
      const fresh = [...(hitSkills.get(rule) ?? [])]
        .filter(name => !baselineNames.has(name))
        .sort()
        .slice(0, 3)
      if (fresh.length > 0) regressedSkills[rule] = fresh
    } else if (now > 0) unchanged.push({ rule, plainTitle: titleOf(rule), before: was, after: now })
  }

  const byDelta = (delta: (item: RuleDelta) => number): ((a: RuleDelta, b: RuleDelta) => number) =>
    (a, b) => delta(b) - delta(a) || a.rule.localeCompare(b.rule)
  improved.sort(byDelta(item => item.before - item.after))
  regressed.sort(byDelta(item => item.after - item.before))
  unchanged.sort(byDelta(item => item.before))

  const baselineNames = new Set(Object.keys(baseline.skills))
  const sum = (values: Iterable<number>): number => [...values].reduce((total, value) => total + value, 0)

  const diff: BaselineDiff = {
    improved,
    unchanged,
    regressed,
    regressedSkills,
    newSkills: [...currentNames].filter(name => !baselineNames.has(name)).sort(),
    goneSkills: [...baselineNames].filter(name => !currentNames.has(name)).sort(),
    totalBefore: sum(before.values()),
    totalAfter: sum(after.values()),
    errorsBefore: sum(Object.values(baseline.skills).map(record => record.errors)),
    errorsAfter: sum(result.results.map(item => item.errors)),
  }

  // 口径不同就直说：13 → 2 可能只是上次没开 info 级，不是修好了。
  if (baseline.meta.severity !== currentMeta.severity) {
    return {
      ...diff,
      metaWarning: `病历是用 severity=${baseline.meta.severity} 存的，这次是 ${currentMeta.severity}，两组数字不可直接比。`,
    }
  }
  const baselineRules = [...baseline.meta.rules].sort().join(',')
  const activeRules = [...currentMeta.rules].sort().join(',')
  if (baselineRules !== activeRules) {
    return {
      ...diff,
      metaWarning: `病历和这次启用的规则集不同（病历：${baselineRules}；这次：${activeRules}），差值未必是修好了。`,
    }
  }
  return diff
}
