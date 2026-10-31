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
