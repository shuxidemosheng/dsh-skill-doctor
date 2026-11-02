/**
 * 活动解析：把会话快照折成“模型刚刚调用了什么”的一行行记录。
 *
 * 这里是纯函数，host 与 client 共用，也和 React 无关，所以能被 vitest 直接覆盖——
 * 面板里的 UI 只能靠肉眼验，但“解析对不对”必须可测。
 *
 * 为什么不用 sessionProjections：
 * 注册投影要带 zod schema，todo-plus 为此把 zod 打进了产物（约 60KB）。
 * 而面板要回答的是“**现在**在调用什么”，`useChat` 给的当前窗口就够了，
 * 于是整个 host 侧零改动。代价是超出窗口更早的调用看不到，面板会如实说明。
 */
import { TOOL_NAMES } from './tool-names.js'

/** 一次工具调用的归类。 */
export type ActivityKind = 'skill' | 'plugin' | 'tool'

/** 一条活动记录。 */
export interface ActivityEntry {
  /** 调用 id，用来和结果配对、去重。 */
  readonly callId: string
  /** 工具名，原样保留。 */
  readonly tool: string
  /** 技能加载 / 本插件的工具 / 其他工具。 */
  readonly kind: ActivityKind
  /** 参数摘要，压成一行。 */
  readonly detail: string
  /** 是否已经拿到结果。 */
  readonly done: boolean
}

/** 面板顶部的累计数字。 */
export interface ActivitySummary {
  readonly skills: number
  readonly plugin: number
  readonly tools: number
}

/** 技能加载用的工具名；dsh 用它把 SKILL.md 正文读进上下文。 */
const SKILL_TOOL = 'skill'

/** 参数摘要的长度上限，再长就会把面板撑破。 */
const DETAIL_MAX = 60

/** 参与摘要的字段，按“最像人话”的顺序排。 */
const DETAIL_KEYS = ['name', 'description', 'command', 'path', 'file_path', 'pattern', 'query', 'profile'] as const

/** 判断工具属于哪一类。 */
function kindOf(tool: string): ActivityKind {
  if (tool === SKILL_TOOL) return 'skill'
  if ((TOOL_NAMES as readonly string[]).includes(tool)) return 'plugin'
  return 'tool'
}

/** 压成一行并截断。 */
function clip(text: string, max = DETAIL_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * 从参数里挑一个最能说明“这次调用在干什么”的字段。
 * @param raw - 原始 arguments 字符串，可能不是合法 JSON。
 */
function summarizeArgs(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 不是 JSON 就原样截一段：至少能看出意图，别整行丢掉。
    return clip(raw)
  }
  if (parsed === null || typeof parsed !== 'object') return clip(String(parsed))
  const record = parsed as Record<string, unknown>
  for (const key of DETAIL_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return clip(value)
  }
  // 没有已知字段时，给一个“有几个参数”的提示，比空白强。
  const keys = Object.keys(record)
  return keys.length === 0 ? '' : `(${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '…' : ''})`
}

/** 从节点集合里取出对话节点；两种历史形态都兼容。 */
function nodesOf(snapshot: unknown): unknown[] {
  const value = snapshot as { nodes?: unknown; legacy?: { nodes?: unknown } } | undefined
  const raw = value?.legacy?.nodes ?? value?.nodes
  if (raw === null || raw === undefined) return []
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'object') return Object.values(raw as Record<string, unknown>)
  return []
}

/** 一个 block 是否携带工具调用；两种写法都见过。 */
function callOf(block: unknown): { name?: unknown; callId?: unknown; argsRaw?: unknown } | undefined {
  const value = block as { call?: unknown; callId?: unknown; name?: unknown } | undefined
  const call = value?.call ?? (value?.callId === undefined ? undefined : value)
  return call as { name?: unknown; callId?: unknown; argsRaw?: unknown } | undefined
}

/**
 * 解析会话快照，按出现顺序返回工具调用。
 *
 * 只读取，不修改传入对象；未知结构一律跳过，不抛错——
 * 面板崩掉会连带整个会话页出问题，代价太大。
 * @param snapshot - `props.useChat(s => s)` 拿到的快照。
 */
export function collectActivity(snapshot: unknown): ActivityEntry[] {
  const nodes = nodesOf(snapshot)
  if (nodes.length === 0) return []

  // 先扫一遍结果，才能知道哪次调用已经结束。
  const finished = new Set<string>()
  for (const node of nodes) {
    const value = node as { kind?: unknown; callId?: unknown } | undefined
    if (value?.kind === 'tool-result' && value.callId !== undefined) {
      finished.add(String(value.callId))
    }
  }

  const entries: ActivityEntry[] = []
  const seen = new Set<string>()
  for (const node of nodes) {
    const value = node as { kind?: unknown; blocks?: unknown } | undefined
    if (value?.kind !== 'assistant' || !Array.isArray(value.blocks)) continue
    for (const block of value.blocks) {
      const call = callOf(block)
      if (call === undefined) continue
      if (typeof call.name !== 'string' || call.callId === undefined) continue
      const callId = String(call.callId)
      if (seen.has(callId)) continue
      seen.add(callId)
      entries.push({
        callId,
        tool: call.name,
        kind: kindOf(call.name),
        detail: summarizeArgs(call.argsRaw),
        done: finished.has(callId),
      })
    }
  }
  return entries
}

/**
 * 合并两批活动：保留旧的，只追加没见过的。
 *
 * 会话窗口会滑动，早期调用会被挤出快照；靠这一步把见过的攒住，
 * 面板的“本次会话累计”才不会随着滚动倒退。
 * @param previous - 已经攒下的记录。
 * @param next - 本次快照解析出来的记录。
 */
export function mergeActivity(
  previous: readonly ActivityEntry[],
  next: readonly ActivityEntry[],
): ActivityEntry[] {
  if (next.length === 0) return [...previous]
  const known = new Map(previous.map(entry => [entry.callId, entry]))
  const merged = [...previous]
  for (const entry of next) {
    const old = known.get(entry.callId)
    if (old === undefined) {
      known.set(entry.callId, entry)
      merged.push(entry)
    } else if (!old.done && entry.done) {
      // 同一次调用后来拿到结果了，就地更新状态。
      const index = merged.findIndex(item => item.callId === entry.callId)
      if (index >= 0) merged[index] = entry
    }
  }
  return merged
}

/** 统计各类次数。 */
export function summarize(entries: readonly ActivityEntry[]): ActivitySummary {
  let skills = 0
  let plugin = 0
  let tools = 0
  for (const entry of entries) {
    if (entry.kind === 'skill') skills++
    else if (entry.kind === 'plugin') plugin++
    else tools++
  }
  return { skills, plugin, tools }
}

/** 只留最近 n 条，面板默认显示这些。 */
export function recent(entries: readonly ActivityEntry[], n: number): ActivityEntry[] {
  return entries.length <= n ? [...entries] : entries.slice(entries.length - n)
}

/** 一行的人话描述，面板和悬浮卡片都用它。 */
export function describeEntry(entry: ActivityEntry): string {
  if (entry.kind === 'skill') {
    return entry.detail.length > 0 ? `读入技能 ${entry.detail}` : '读入技能'
  }
  return entry.detail.length > 0 ? `${entry.tool} · ${entry.detail}` : entry.tool
}

/**
 * 执行中的那一条，用来做“当前动作”。
 * @param entries - 已合并的活动。
 */
export function currentEntry(entries: readonly ActivityEntry[]): ActivityEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (!entry.done) return entry
  }
  return undefined
}

// ---------- 跨会话使用统计 ----------

/**
 * 跨会话使用统计：每个技能被读进上下文多少次、最近一次是什么时候。
 *
 * 为什么放在客户端：模型读技能这件事只有会话页看得到（tool_call 事件带
 * `skill` 工具名），插件 node 侧拿不到任何归属信息。持久化用 webview 的
 * localStorage——纯本机数据，不上传、不进技能文件，可随时清空。
 *
 * 为什么只统计 `skill` 工具：模型直接 `read` 技能文件时读不到“这是技能”
 * 的归属（路径匹配是猜测，会误报），宁可少记也不记错。
 */
export interface SkillUsage {
  readonly loads: number
  /** ISO 时间；空串表示未知（旧数据兜底）。 */
  readonly lastUsed: string
}

export interface UsageRecord {
  readonly version: 1
  readonly skills: Readonly<Record<string, SkillUsage>>
  /** 见过的会话 id → true；只用来数“统计覆盖了几个会话”。 */
  readonly sessions: Readonly<Record<string, true>>
}

/** localStorage 的 key；带项目前缀避免和宿主其他数据打架。 */
export const USAGE_STORAGE_KEY = 'dsh-skill-doctor:usage'

/** 技能数上限：防止名字无限膨胀撑爆 localStorage；超限按次数留最常用的。 */
export const USAGE_MAX_SKILLS = 200

export function emptyUsage(): UsageRecord {
  return { version: 1, skills: {}, sessions: {} }
}

/**
 * 从 localStorage 读统计；任何失败（被禁、坏 JSON、版本不认识）都回到空表。
 * 统计是锦上添花，绝不能让面板挂掉。
 */
export function loadUsage(storage: Storage | undefined): UsageRecord {
  if (storage === undefined) return emptyUsage()
  try {
    const raw = storage.getItem(USAGE_STORAGE_KEY)
    if (raw === null || raw.trim().length === 0) return emptyUsage()
    const parsed = JSON.parse(raw) as { version?: unknown; skills?: unknown; sessions?: unknown }
    if (parsed.version !== 1 || typeof parsed.skills !== 'object' || parsed.skills === null) {
      return emptyUsage()
    }
    const skills: Record<string, SkillUsage> = {}
    for (const [name, value] of Object.entries(parsed.skills as Record<string, unknown>)) {
      const usage = value as { loads?: unknown; lastUsed?: unknown }
      if (typeof usage?.loads === 'number' && Number.isFinite(usage.loads) && usage.loads > 0) {
        skills[name] = {
          loads: usage.loads,
          lastUsed: typeof usage.lastUsed === 'string' ? usage.lastUsed : '',
        }
      }
    }
    const sessions: Record<string, true> = {}
    if (typeof parsed.sessions === 'object' && parsed.sessions !== null) {
      for (const id of Object.keys(parsed.sessions as Record<string, unknown>)) sessions[id] = true
    }
    return { version: 1, skills, sessions }
  } catch {
    return emptyUsage()
  }
}

/** 写回 localStorage；失败静默（配额满 / 被禁），统计少记一次无所谓。 */
export function saveUsage(storage: Storage | undefined, record: UsageRecord): void {
  if (storage === undefined) return
  try {
    storage.setItem(USAGE_STORAGE_KEY, JSON.stringify(record))
  } catch {
    /* 忽略：统计不是关键数据 */
  }
}

function trimSkills(skills: Record<string, SkillUsage>, max: number): Record<string, SkillUsage> {
  const names = Object.keys(skills)
  if (names.length <= max) return skills
  const keep = names
    .sort((a, b) => (skills[b]!.loads - skills[a]!.loads) || a.localeCompare(b))
    .slice(0, max)
  const trimmed: Record<string, SkillUsage> = {}
  for (const name of keep) trimmed[name] = skills[name]!
  return trimmed
}

/**
 * 记一次技能加载（同名多次调用各计一次）；
 * 顺带把会话 id 记进 seen 表（统计覆盖了几个会话）。
 */
export function recordSkillLoad(
  record: UsageRecord,
  skillName: string,
  sessionId: string | undefined,
  now = new Date(),
): UsageRecord {
  const previous = record.skills[skillName]
  const skills: Record<string, SkillUsage> = {
    ...record.skills,
    [skillName]: { loads: (previous?.loads ?? 0) + 1, lastUsed: now.toISOString() },
  }
  const sessions: Record<string, true> = { ...record.sessions }
  if (sessionId !== undefined && sessionId.length > 0) sessions[sessionId] = true
  return { version: 1, skills: trimSkills(skills, USAGE_MAX_SKILLS), sessions: trimSessions(sessions) }
}

/** 会话 id 数量兜底：只用来数数，超限删最先插入的（无时间戳，任删一个都行）。 */
function trimSessions(sessions: Record<string, true>, max = 500): Record<string, true> {
  const ids = Object.keys(sessions)
  if (ids.length <= max) return sessions
  const trimmed: Record<string, true> = {}
  for (const id of ids.slice(ids.length - max)) trimmed[id] = true
  return trimmed
}

/** 记一个“统计覆盖到的会话”；重复记是幂等的。 */
export function recordSession(record: UsageRecord, sessionId: string): UsageRecord {
  if (record.sessions[sessionId] === true) return record
  return { version: 1, skills: record.skills, sessions: trimSessions({ ...record.sessions, [sessionId]: true }) }
}

/** 只统计一屏能看完的前 n 名。 */
export function topSkills(
  record: UsageRecord,
  n: number,
): Array<{ readonly name: string; readonly loads: number; readonly lastUsed: string }> {
  return Object.entries(record.skills)
    .map(([name, usage]) => ({ name, loads: usage.loads, lastUsed: usage.lastUsed }))
    .sort((a, b) => b.loads - a.loads || a.name.localeCompare(b.name))
    .slice(0, n)
}

/** 面板统计页头部的那三个数。 */
export function usageSummary(record: UsageRecord): {
  readonly totalLoads: number
  readonly distinctSkills: number
  readonly sessions: number
} {
  const totalLoads = Object.values(record.skills).reduce((total, usage) => total + usage.loads, 0)
  return {
    totalLoads,
    distinctSkills: Object.keys(record.skills).length,
    sessions: Object.keys(record.sessions).length,
  }
}

/** 从一批活动里挑出“技能加载”且带名字的（去重由调用方的 callId 合并保证）。 */
export function skillLoadNames(entries: readonly ActivityEntry[]): string[] {
  return entries.filter(entry => entry.kind === 'skill' && entry.detail.length > 0).map(entry => entry.detail)
}

// ---------- 面板位置（可拖动 + 记住位置） ----------

/** 浮层左上角坐标（视口坐标系，单位 px）。 */
export interface PanelPosition {
  readonly x: number
  readonly y: number
}

/** 位置存储键；与统计同理，放本机 localStorage，不上传。 */
export const PANEL_POS_KEY = 'dsh-skill-doctor:panel-pos'

/** 拖动时至少保留的可见边距，避免把面板拖出屏幕后找不回来。 */
export const PANEL_MARGIN = 8

/**
 * 把位置夹进视口内。
 *
 * 三个来源会让坐标越界：拖到边缘、窗口缩小、换显示器后分辨率变化。
 * 这里统一处理——宁可贴边，也不让面板有一半在屏幕外。
 */
export function clampPanelPosition(
  position: PanelPosition,
  viewport: { readonly width: number; readonly height: number },
  size: { readonly width: number; readonly height: number },
  margin = PANEL_MARGIN,
): PanelPosition {
  const maxX = Math.max(margin, viewport.width - size.width - margin)
  const maxY = Math.max(margin, viewport.height - size.height - margin)
  return {
    x: Math.min(Math.max(position.x, margin), maxX),
    y: Math.min(Math.max(position.y, margin), maxY),
  }
}

/** 读回上次的位置；没有或数据坏了返回 undefined（回到默认居中）。 */
export function loadPanelPosition(storage: Storage | undefined): PanelPosition | undefined {
  if (storage === undefined) return undefined
  try {
    const raw = storage.getItem(PANEL_POS_KEY)
    if (raw === null) return undefined
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown }
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return undefined
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return undefined
    return { x: parsed.x, y: parsed.y }
  } catch {
    return undefined
  }
}

/** 清掉记住的位置（双击标题复位时用）。 */
export function clearPanelPosition(storage: Storage | undefined): void {
  if (storage === undefined) return
  try {
    storage.removeItem(PANEL_POS_KEY)
  } catch {
    /* 忽略 */
  }
}

/** 记住位置；失败静默（隐私模式 / 配额满），下次回默认位置即可。 */
export function savePanelPosition(storage: Storage | undefined, position: PanelPosition): void {
  if (storage === undefined) return
  try {
    storage.setItem(PANEL_POS_KEY, JSON.stringify({ x: Math.round(position.x), y: Math.round(position.y) }))
  } catch {
    /* 忽略：位置不是关键数据 */
  }
}
