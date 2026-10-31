/**
 * 运行时探测：dsh 实际把哪些插件跑起来了、注册了哪些工具。
 *
 * 三条硬约束决定了这里的写法：
 * 1. **绝不把 `pluginInventory` 写进 `inject`**。它是 Remote 服务，没挂载时
 *    依赖方会永久 pending 且没有任何提示——拿稳定性换信息不划算。所以只在
 *    execute 里软取，取不到就降级。
 * 2. **`schemas()` 必须传 `exec.agent`**，否则只拿到全局视图，会漏掉
 *    agent preset 层的工具，把好好的工具报成"不见了"。
 * 3. **只报确定的事**。工具归属查不到（注册表没有 owner 字段），失败原因
 *    也拿不到（inventory 不投影 error），所以宁可少报也不能猜。
 */
import type { Context } from '@deepseek-ai/cordis'
import { TOOL_NAMES } from '../tool-names.js'

/** 探测结果的状态。`ok` 以外都表示"没查到"，不是"没问题"。 */
export type RuntimeStatus = 'ok' | 'unavailable' | 'timeout' | 'error'

/** inventory 里的一行。 */
export interface RuntimeEntry {
  readonly moduleName: string
  readonly entryId?: string
  readonly enabled: boolean
  readonly fiberPhase: string | null
}

/** 一次性快照。 */
export interface RuntimeSnapshot {
  readonly status: RuntimeStatus
  /** 降级原因，给人看的一句话。 */
  readonly note?: string
  readonly entries: readonly RuntimeEntry[]
  /** 当前会话可见的工具名；拿不到为 null。 */
  readonly toolNames: readonly string[] | null
}

/** 汇总后的结论，供报告直接渲染。 */
export interface RuntimeSummary {
  readonly status: RuntimeStatus
  readonly note?: string
  /** 运行时报告为启用的条目数。 */
  readonly enabled: number
  /** 启用了但 fiber 阶段是 failed 的插件名——这是唯一可以点名的"确定有问题"。 */
  readonly failed: readonly string[]
  /** fiber 阶段分布。 */
  readonly phases: Readonly<Record<string, number>>
  /** 静态清单里的 bundle 能在 inventory 里按 moduleName 找到几个。 */
  readonly matched: number
  /** 清单里的总数。 */
  readonly declared: number
  /** 我自己的工具里，哪些不在当前会话的工具列表里。 */
  readonly missingOwnTools: readonly string[]
  /** 当前会话注册表里的工具总数；拿不到为 null。 */
  readonly toolCount: number | null
}

/** 探测超时：inventory 是跨进程调用，卡住不能拖死整个体检。 */
const TIMEOUT_MS = 800

/** 软查一个服务；Cordis 的 ctx.get 在服务缺失时返回 undefined。 */
function safeGet(ctx: Context, name: string): unknown {
  const lookup = (ctx as unknown as { get?: (key: string) => unknown }).get
  if (typeof lookup !== 'function') return undefined
  try {
    return lookup.call(ctx, name)
  } catch {
    return undefined
  }
}

/** 给 promise 加超时；到点返回 `'timeout'`。定时器必须清掉，否则会拖住进程退出。 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), ms)
        // 别让这个定时器单独撑住事件循环（headless e2e 会因此挂住）。
        ;(timer as { unref?: () => void }).unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 从 inventory 的原始返回值里抠出 entries。字段缺失一律跳过，不做补全猜测。 */
function parseEntries(raw: unknown): RuntimeEntry[] {
  const record = raw as { entries?: unknown } | undefined
  const list = Array.isArray(record?.entries) ? record.entries : []
  const entries: RuntimeEntry[] = []
  for (const item of list) {
    const value = item as Record<string, unknown>
    const moduleName = typeof value.moduleName === 'string' ? value.moduleName : undefined
    if (moduleName === undefined) continue
    entries.push({
      moduleName,
      ...typeof value.entryId === 'string' ? { entryId: value.entryId } : {},
      enabled: value.enabled !== false,
      fiberPhase: typeof value.fiberPhase === 'string' ? value.fiberPhase : null,
    })
  }
  return entries
}

/** 读当前会话可见的工具名。拿不到返回 null，不抛错。 */
function readToolNames(ctx: Context, exec: { readonly agent?: unknown } | undefined): readonly string[] | null {
  const tools = safeGet(ctx, 'tools') as { schemas?: (scope?: unknown) => unknown } | undefined
  if (tools === undefined || typeof tools.schemas !== 'function') return null
  try {
    // 必须传 exec.agent：不传只是全局视图，会漏 preset 层的工具。
    const schemas = tools.schemas(exec?.agent)
    if (!Array.isArray(schemas)) return null
    const names: string[] = []
    for (const item of schemas) {
      const name = (item as { name?: unknown }).name
      if (typeof name === 'string') names.push(name)
    }
    return names
  } catch {
    return null
  }
}

/**
 * 探测运行时状态。任何失败都转成降级快照，不抛错。
 * @param ctx - 插件上下文。
 * @param exec - 工具执行上下文，用来取 agent scope。
 */
export async function probeRuntime(
  ctx: Context,
  exec?: { readonly agent?: unknown },
): Promise<RuntimeSnapshot> {
  const toolNames = readToolNames(ctx, exec)
  const service = safeGet(ctx, 'pluginInventory') as { list?: () => Promise<unknown> } | undefined

  if (service === undefined || typeof service.list !== 'function') {
    return {
      status: 'unavailable',
      note: '当前 dsh 没有暴露 pluginInventory 服务（可能版本较旧），插件是否真的跑起来这次没查到。',
      entries: [],
      toolNames,
    }
  }

  let raw: unknown
  try {
    const result = await withTimeout(service.list(), TIMEOUT_MS)
    if (result === 'timeout') {
      return {
        status: 'timeout',
        note: `读取插件运行时状态超过 ${TIMEOUT_MS}ms 没有返回，这次跳过了这一项。`,
        entries: [],
        toolNames,
      }
    }
    raw = result
  } catch (error) {
    return {
      status: 'error',
      note: `读取插件运行时状态失败：${error instanceof Error ? error.message : String(error)}`,
      entries: [],
      toolNames,
    }
  }

  return { status: 'ok', entries: parseEntries(raw), toolNames }
}

/**
 * 把快照折成报告要用的结论。
 * @param snapshot - 探测结果。
 * @param bundles - 磁盘上读到的 bundle 清单（用来算"对上了几个"）。
 */
export function summarizeRuntime(
  snapshot: RuntimeSnapshot,
  bundles: readonly { readonly name: string }[],
): RuntimeSummary {
  const phases: Record<string, number> = {}
  for (const entry of snapshot.entries) {
    const key = entry.fiberPhase ?? 'unknown'
    phases[key] = (phases[key] ?? 0) + 1
  }

  // 只有 enabled 且明确 failed 才点名：这是唯一不需要猜的"有问题"。
  const failed = snapshot.entries
    .filter(entry => entry.enabled && entry.fiberPhase === 'failed')
    .map(entry => entry.moduleName)

  const moduleNames = new Set(snapshot.entries.map(entry => entry.moduleName))
  const matched = bundles.filter(bundle => moduleNames.has(bundle.name)).length

  const missingOwnTools = snapshot.toolNames === null
    ? []
    : TOOL_NAMES.filter(name => !snapshot.toolNames!.includes(name))

  return {
    status: snapshot.status,
    ...snapshot.note === undefined ? {} : { note: snapshot.note },
    enabled: snapshot.entries.filter(entry => entry.enabled).length,
    failed,
    phases,
    matched,
    declared: bundles.length,
    missingOwnTools,
    toolCount: snapshot.toolNames === null ? null : snapshot.toolNames.length,
  }
}
