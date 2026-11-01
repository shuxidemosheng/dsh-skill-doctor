/**
 * 插件体检：读出当前 profile 装了哪些插件，找出它们之间的结构性冲突。
 *
 * 数据全部来自磁盘，不需要 dsh 运行时：
 *   $DSH_HOME/profiles/<profile>/package.json   → bundles 顺序 + 依赖来源
 *   $DSH_HOME/profiles/<profile>/node_modules/<bundle>/package.json
 *   $DSH_HOME/profiles/<profile>/node_modules/<bundle>/cordis.patch.yml
 *
 * 能查到的“冲突”只有结构性那几类（同一个 loader 条目被两个插件抢/改、重复安装、
 * 装了没启用、启用了但包不在）。工具名被两个插件同时注册这类运行时冲突，
 * 注册表不暴露归属信息，这里查不到，不要假装能查。
 */
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/** 一条已解析 patch 里、与“技能链路”相关的配置改动。 */
export interface SkillTouchpoint {
  /** 被改动的 loader 条目 id（如 `skill-filesystem`）。 */
  readonly entryId: string
  /** 被改动的配置键。 */
  readonly key: string
  /** 人话化的值（JSON 形式，超长截断）。 */
  readonly value: string
}

/** 一个已安装插件的摘要。 */
export interface BundleInfo {
  readonly name: string
  readonly version?: string
  /** profile 依赖里的 spec：`link:` / `file:` / 版本范围；bundle 自带时可能没有。 */
  readonly source?: string
  /** 在 `dsh.profile.bundles` 里出现几次（正常应为 1）。 */
  readonly orderedTimes: number
  /** 包在哪：profile 自己的 node_modules / dsh 应用自带 / 找不到。 */
  readonly availability: 'profile' | 'shipped' | 'missing'
  readonly description?: string
  /** 它的 patch 插入的 loader 条目 id。 */
  readonly inserts: readonly string[]
  /** 它的 patch 修改（而非新增）的 loader 条目 id。 */
  readonly patches: readonly string[]
  /** 它的 patch 里触碰“技能链路”的配置改动（会诊用）。 */
  readonly skillTouchpoints: readonly SkillTouchpoint[]
  /** 读文件失败时的原因，用于报告里解释“为什么这个插件没被检查”。 */
  readonly note?: string
}

/** 一条冲突。 */
export interface PluginConflict {
  readonly rule: 'PL001' | 'PL002' | 'PL003' | 'PL004' | 'PL005' | 'PL006'
  readonly severity: 'error' | 'warn' | 'info'
  /** 人话标题，第一屏直接显示。 */
  readonly title: string
  /** 现在是什么情况。 */
  readonly detail: string
  readonly suggestion?: string
  /** 涉及哪些插件（按加载顺序）。 */
  readonly involved: readonly string[]
}

/** 一次插件体检的完整结果。 */
export interface PluginReport {
  readonly profileName: string
  readonly profileDir: string
  readonly bundles: readonly BundleInfo[]
  readonly conflicts: readonly PluginConflict[]
  /** 读不了的文件等非致命问题。 */
  readonly notes: readonly string[]
}

const RULE_TITLES = {
  PL001: '同一个插件被装了两遍',
  PL002: '两个插件抢同一个 loader 条目',
  PL003: '两个插件改同一行配置',
  PL004: '插件装了但没启用 / 启用了但包不在',
  PL005: '同一个包存在多个副本',
  PL006: '插件动了技能链路配置',
} as const

/** dsh 的 HOME：环境变量优先，其次 ~/.dsh。 */
export function dshHome(): string {
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh')
}

/** profile 目录。 */
export function profileDirOf(profile: string): string {
  return join(dshHome(), 'profiles', profile)
}

/** 读 JSON，失败返回 undefined（不抛，报告里用 note 说明）。 */
async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** 读文本，失败返回 undefined。 */
async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 解析一个 cordis.patch.yml，拆出“新插入的条目”和“改已有条目的 id”。
 *
 * patch 的两种常见形态：
 *   - insert: [ { id, name, config } ]      → 新增条目
 *   - { id, config } / { id, disabled }     → 修改已有条目
 */
export function parsePatchIds(source: string): { inserts: string[]; patches: string[] } {
  const inserts: string[] = []
  const patches: string[] = []
  let list: unknown
  try {
    list = parseYaml(source)
  } catch {
    return { inserts, patches }
  }
  if (!Array.isArray(list)) return { inserts, patches }
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    if (Array.isArray(record.insert)) {
      for (const child of record.insert) {
        if (child !== null && typeof child === 'object') {
          const id = (child as Record<string, unknown>).id
          if (typeof id === 'string' && id.length > 0) inserts.push(id)
        }
      }
      continue
    }
    if (typeof record.id === 'string' && record.id.length > 0) patches.push(record.id)
  }
  return { inserts, patches }
}

/** 会关心的技能链路配置键：改动它们会直接改变“会话里能看到哪些技能”。 */
const SKILL_CONFIG_KEYS = ['includeDefaultRoots', 'customSkillDirs'] as const

/** 条目 id 含 `skill` 就当成技能链路（skill-filesystem / skill-doctor / 未来其他来源）。 */
function isSkillEntry(id: string): boolean {
  return id.toLowerCase().includes('skill')
}

/** 值转成人话：数组/对象用 JSON，超长截断，报告里放得下。 */
function formatValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const flat = text ?? String(value)
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat
}

/**
 * 从 patch 里提取“触碰技能链路”的配置改动（会诊素材）。
 *
 * 为什么要单独解析一遍（而不是复用 parsePatchIds）：结构性冲突只关心条目 id，
 * 会诊关心的是**具体改了哪个键、改成了什么**——同一个条目，改 maxDescriptionLength
 * 无关紧要，改 includeDefaultRoots 会让整个技能目录消失。
 * 解析失败返回空数组，和 parsePatchIds 一样不抛。
 */
export function parseSkillTouchpoints(source: string): SkillTouchpoint[] {
  let list: unknown
  try {
    list = parseYaml(source)
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []

  const touchpoints: SkillTouchpoint[] = []
  const visit = (entryId: string, record: Record<string, unknown>): void => {
    if (!isSkillEntry(entryId)) return
    // 整个条目被禁用：这个条目提供的技能来源会从会话里消失。
    if (record.disabled === true) {
      touchpoints.push({ entryId, key: 'disabled', value: 'true' })
    }
    const config = record.config
    if (config === null || typeof config !== 'object' || Array.isArray(config)) return
    for (const key of SKILL_CONFIG_KEYS) {
      const value = (config as Record<string, unknown>)[key]
      if (value !== undefined) touchpoints.push({ entryId, key, value: formatValue(value) })
    }
  }

  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    if (Array.isArray(record.insert)) {
      for (const child of record.insert) {
        if (child === null || typeof child !== 'object') continue
        const id = (child as Record<string, unknown>).id
        if (typeof id === 'string' && id.length > 0) visit(id, child as Record<string, unknown>)
      }
      continue
    }
    if (typeof record.id === 'string' && record.id.length > 0) visit(record.id, record)
  }
  return touchpoints
}

/** 读一个插件的清单与 patch。 */
async function readBundle(profileDir: string, name: string, source: string | undefined, orderedTimes: number): Promise<BundleInfo> {
  const dir = join(profileDir, 'node_modules', name)
  const manifest = await readJson(join(dir, 'package.json'))
  if (manifest === undefined) {
    // @deepseek-ai/* 默认由 dsh 应用自带（在 app.asar 里），不在 profile 的 node_modules；
    // 把它们当成“装坏了”会制造大量误报。
    const shipped = name.startsWith('@deepseek-ai/')
    return {
      name,
      ...source === undefined ? {} : { source },
      orderedTimes,
      availability: shipped ? 'shipped' : 'missing',
      inserts: [],
      patches: [],
      skillTouchpoints: [],
      note: shipped
        ? 'dsh 自带，包在应用内，读不到它的 patch，无法参与条目冲突分析'
        : 'node_modules 里找不到这个包',
    }
  }
  const dsh = manifest.dsh as Record<string, unknown> | undefined
  const bundle = dsh?.bundle as Record<string, unknown> | undefined
  const patchRelative = typeof bundle?.patch === 'string' ? bundle.patch : './cordis.patch.yml'
  const patchText = await readText(join(dir, patchRelative))
  const ids = patchText === undefined ? { inserts: [], patches: [] } : parsePatchIds(patchText)
  const skillTouchpoints = patchText === undefined ? [] : parseSkillTouchpoints(patchText)
  return {
    name,
    ...typeof manifest.version === 'string' ? { version: manifest.version } : {},
    ...source === undefined ? {} : { source },
    orderedTimes,
    availability: 'profile',
    ...typeof manifest.description === 'string' ? { description: manifest.description } : {},
    inserts: ids.inserts,
    patches: ids.patches,
    skillTouchpoints,
    ...patchText === undefined ? { note: `没有读到 ${patchRelative}` } : {},
  }
}

/** 把 id → 插件列表 的映射变成“被多个插件碰过”的冲突。 */
function collisions(
  map: Map<string, string[]>,
  rule: 'PL002' | 'PL003',
): PluginConflict[] {
  const out: PluginConflict[] = []
  for (const [id, owners] of map) {
    if (owners.length < 2) continue
    const unique = [...new Set(owners)]
    if (unique.length < 2) continue
    out.push({
      rule,
      severity: 'warn',
      title: RULE_TITLES[rule],
      detail: rule === 'PL002'
        ? `条目 ${id} 被 ${unique.length} 个插件各自插入了一份，加载时只会有一个真正生效，另一个插件的功能等于没装。`
        : `条目 ${id} 被 ${unique.length} 个插件同时修改，后加载的会覆盖前面的，前面的设置静默失效。`,
      suggestion: rule === 'PL002'
        ? `保留一个插件负责 ${id}，把另一个插件的 patch 换一个条目 id 或删掉。`
        : `确认 ${id} 最终应该由谁负责；不需要的插件用 plugin --profile … 禁用，或把它的 patch 改成独立条目。`,
      involved: unique,
    })
  }
  return out
}

/**
 * 体检一个 profile。
 * @param profile - profile 名（例如 desktop / headless）。
 */
export async function scanProfile(profile: string): Promise<PluginReport> {
  const profileDir = profileDirOf(profile)
  const notes: string[] = []
  const manifest = await readJson(join(profileDir, 'package.json'))
  if (manifest === undefined) {
    return {
      profileName: profile,
      profileDir,
      bundles: [],
      conflicts: [],
      notes: [`读不到 ${join(profileDir, 'package.json')}：确认 profile 名是否正确，或 dsh 是否在这个用户下运行过。`],
    }
  }

  const dependencies = (manifest.dependencies ?? {}) as Record<string, string>
  const dshField = manifest.dsh as Record<string, unknown> | undefined
  const profileField = dshField?.profile as Record<string, unknown> | undefined
  const ordered = Array.isArray(profileField?.bundles)
    ? (profileField.bundles as unknown[]).filter((item): item is string => typeof item === 'string')
    : []
  if (ordered.length === 0) notes.push('profile 的 dsh.profile.bundles 是空的：这个 profile 没有装任何插件。')

  const bundles: BundleInfo[] = []
  const seen = new Map<string, number>()
  for (const name of ordered) {
    seen.set(name, (seen.get(name) ?? 0) + 1)
  }
  for (const [name, times] of seen) {
    bundles.push(await readBundle(profileDir, name, dependencies[name], times))
  }

  const conflicts: PluginConflict[] = []

  // PL001：bundles 里同一个名字出现多次。
  for (const [name, times] of seen) {
    if (times < 2) continue
    conflicts.push({
      rule: 'PL001',
      severity: 'warn',
      title: RULE_TITLES.PL001,
      detail: `${name} 在 dsh.profile.bundles 里出现了 ${times} 次，同一个插件会被重复装载。`,
      suggestion: '去掉重复项，只保留一条。',
      involved: [name],
    })
  }

  // PL004：装了但没启用，或启用了但包不在。
  for (const name of Object.keys(dependencies)) {
    if (seen.has(name)) continue
    conflicts.push({
      rule: 'PL004',
      severity: 'info',
      title: RULE_TITLES.PL004,
      detail: `${name} 在 dependencies 里，但不在 dsh.profile.bundles 里：装了但没启用。`,
      suggestion: `要启用：dsh plugin --profile ${profile} enable ${name}（或把名字加进 bundles）。不要了：plugin --profile ${profile} remove ${name}。`,
      involved: [name],
    })
  }
  for (const bundle of bundles) {
    if (bundle.availability !== 'missing') continue
    conflicts.push({
      rule: 'PL004',
      severity: 'error',
      title: RULE_TITLES.PL004,
      detail: `${bundle.name} 在 dsh.profile.bundles 里，但 profile 的 node_modules 里没有这个包，也不是 dsh 自带，启动时会报错或静默跳过。`,
      suggestion: `重新安装：dsh plugin --profile ${profile} add ${bundle.name}；或把它从 bundles 里删掉。`,
      involved: [bundle.name],
    })
  }

  // PL002/PL003：同一条目被多个插件插入 / 修改。
  const insertedBy = new Map<string, string[]>()
  const patchedBy = new Map<string, string[]>()
  for (const bundle of bundles) {
    for (const id of bundle.inserts) {
      insertedBy.set(id, [...insertedBy.get(id) ?? [], bundle.name])
    }
    for (const id of bundle.patches) {
      patchedBy.set(id, [...patchedBy.get(id) ?? [], bundle.name])
    }
  }
  conflicts.push(...collisions(insertedBy, 'PL002'))
  conflicts.push(...collisions(patchedBy, 'PL003'))

  // PL006：技能链路被插件层动了。这是“会诊”的核心——技能消失的症状，
  // 根因常在这一层，而技能侧的报告只会说“0 个技能”，看起来像技能坏了。
  const touchpoints = bundles.flatMap(bundle =>
    bundle.skillTouchpoints.map(point => ({ bundle: bundle.name, ...point })))

  for (const point of touchpoints) {
    if (point.key !== 'disabled') continue
    conflicts.push({
      rule: 'PL006',
      severity: 'warn',
      title: RULE_TITLES.PL006,
      detail: `${point.bundle} 把技能条目 ${point.entryId} 整个禁用了（disabled: true）。`
        + `这个条目提供的技能来源会从会话里消失——症状是“技能全没了”，但技能文件本身没有任何问题。`,
      suggestion: `确认这是不是有意的；不是的话，把 ${point.bundle} 的 patch 里 ${point.entryId} 的 disabled 去掉，或禁用这个插件。`,
      involved: [point.bundle],
    })
  }

  // 关掉默认技能根、又没有任何插件提供替代目录 → 会话里一个本地技能都看不到。
  // 注意“任何插件”：customSkillDirs 写在别的 bundle 里同样有效，不能只看同一个。
  const hasCustomDirs = touchpoints.some(point =>
    point.key === 'customSkillDirs' && point.value !== '[]')
  for (const point of touchpoints) {
    if (point.key !== 'includeDefaultRoots' || point.value !== 'false') continue
    if (hasCustomDirs) continue
    conflicts.push({
      rule: 'PL006',
      severity: 'warn',
      title: RULE_TITLES.PL006,
      detail: `${point.bundle} 把 ${point.entryId} 的默认技能根关了（includeDefaultRoots=false），`
        + `而 profile 里没有任何插件配置 customSkillDirs 替代——会话里可能一个本地技能都看不到。`,
      suggestion: `要么把 ${point.entryId}.includeDefaultRoots 改回 true，要么在同一处配置 customSkillDirs 指向你的技能目录。`,
      involved: [point.bundle],
    })
  }

  return { profileName: profile, profileDir, bundles, conflicts, notes }
}

/** 按严重程度排序，报告里先显示要紧的。 */
export function sortConflicts(conflicts: readonly PluginConflict[]): PluginConflict[] {
  const rank = { error: 0, warn: 1, info: 2 } as const
  return [...conflicts].sort((a, b) => rank[a.severity] - rank[b.severity] || a.rule.localeCompare(b.rule))
}

/** 目录是否存在，供工具在给建议前判断。 */
export async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
