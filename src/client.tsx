/**
 * 浏览器侧面板：在会话输入框上方常驻一条，点开看模型这次调用了什么。
 *
 * 三点设计约束：
 * 1. **不注册 sessionProjections**。注册要带 zod schema（todo-plus 为此把 zod
 *    打进了产物），而面板要回答的是“现在在调用什么”，`useChat` 的窗口就够。
 *    代价是更早的调用看不到，面板底部如实写明。
 * 2. **宿主要求 CJS 工厂 + `window.__ModuleLoader__.load` 外壳**，所以源码是 ESM、
 *    产物由 esbuild 包成 CJS，且绝不能 `export default`（Loader 会折叠模块）。
 * 3. **状态放在模块级 store**：常驻条挂在槽位里，浮层挂在 body 上（避免被
 *    overflow 裁掉），两个 React 根用 `useSyncExternalStore` 共享同一份状态。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import {
  collectActivity,
  currentEntry,
  describeEntry,
  mergeActivity,
  recent,
  summarize,
  type ActivityEntry,
} from './activity.js'

/** 槽位注入的 props。只声明用到的部分，宿主给多了不影响。 */
interface SlotProps {
  readonly sessionId?: string
  /** 会话快照的 selector hook；由会话槽位注入。 */
  readonly useChat?: <T>(selector: (snapshot: unknown) => T) => T
}

/** 浮层里最多列多少条；再多就滚，避免面板无上限变长。 */
const MAX_VISIBLE = 20

/** 挂到 body 上的浮层容器 id。 */
const OVERLAY_HOST_ID = 'dsh-skill-doctor-overlay'

/** 槽位注册用的唯一 id。 */
const BAR_ID = 'skill-doctor-activity-bar'

// ---------- 模块级状态（两个 React 根共享） ----------

let entries: ActivityEntry[] = []
let panelOpen = false
let inConversation = false
let overlayMounted = false

const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 把新解析出的活动并进 store。
 * @param next - 本次快照解析结果。
 * @param sessionId - 会话 id；变了就清空，避免上一个会话的调用留在面板上。
 */
function pushActivity(next: readonly ActivityEntry[], sessionId: string | undefined): void {
  const scope = sessionId ?? ''
  const changedScope = scope !== currentScope
  currentScope = scope
  const merged = changedScope ? [...next] : mergeActivity(entries, next)
  if (merged.length === entries.length && merged.every((entry, index) => entry === entries[index])) return
  entries = merged
  emit()
}

let currentScope: string | undefined

function togglePanel(): void {
  panelOpen = !panelOpen
  emit()
}

function closePanel(): void {
  if (!panelOpen) return
  panelOpen = false
  emit()
}

// ---------- 样式 ----------

/** 面板统一走宿主 token，亮暗主题自动跟随。 */
const TOKEN = {
  border: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.28))',
  borderStrong: 'var(--dsw-alias-border-l3, rgba(255,255,255,0.16))',
  surface: 'var(--dsw-menu-surface-fill, rgba(67, 69, 74, 0.45))',
  label: 'var(--dsw-alias-label-primary, #e6e6e6)',
  radius: 'var(--dsw-radius-sm, 8px)',
  radiusLg: 'var(--dsw-radius-lg, 16px)',
} as const

/** 各类调用的颜色；本插件用绿色，和“普通工具”区分开。 */
const KIND_COLOR: Record<ActivityEntry['kind'], string> = {
  skill: '#58a6ff',
  plugin: '#3fb950',
  tool: '#8b949e',
}

const barStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  width: '100%',
  minWidth: 0,
  padding: '4px 10px',
  fontSize: 11,
  lineHeight: 1.4,
  fontFamily: 'inherit',
  textAlign: 'left' as const,
  borderRadius: TOKEN.radius,
  border: `1px solid ${TOKEN.border}`,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  opacity: 0.9,
}

const mutedStyle = { opacity: 0.6, fontVariantNumeric: 'tabular-nums' as const }

// ---------- 组件 ----------

/**
 * 常驻条：只显示“当前动作 + 累计数字”，点一下开合浮层。
 * @param props - 槽位 props。
 */
function ActivityBar(props: SlotProps): JSX.Element {
  // useChat 由会话槽位保证注入；写成同一个条件分支，保证 hook 顺序稳定。
  const snapshot = typeof props.useChat === 'function'
    ? props.useChat((value: unknown) => value)
    : undefined
  const parsed = useMemo(() => collectActivity(snapshot), [snapshot])

  const open = useSyncExternalStore(subscribe, () => panelOpen, () => panelOpen)
  const [tick, setTick] = useState(0)
  const scopeRef = useRef<string | undefined>(props.sessionId)

  useEffect(() => {
    if (scopeRef.current !== props.sessionId) scopeRef.current = props.sessionId
    pushActivity(parsed, props.sessionId)
    setTick(value => value + 1)
  }, [parsed, props.sessionId])

  useEffect(() => {
    inConversation = true
    emit()
    return () => {
      inConversation = false
      emit()
    }
  }, [])

  // tick 变化时重算：entries 是模块级数组，React 认不出引用变化。
  const stats = useMemo(() => summarize(entries), [entries.length, tick])
  const running = useMemo(() => currentEntry(entries), [entries.length, tick])

  const label = running !== undefined
    ? describeEntry(running)
    : entries.length === 0 ? '还没有工具调用' : '空闲'

  return (
    <button
      type="button"
      style={barStyle}
      onClick={togglePanel}
      title={open ? '收起技能医生活动面板' : '看看模型正在调用哪些技能和工具'}
      aria-expanded={open}
    >
      <span aria-hidden="true">🩺</span>
      <span style={{ flex: 'none', fontWeight: 600 }}>技能医生</span>
      <span aria-hidden="true" style={mutedStyle}>·</span>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      <span style={{ flex: 1 }} />
      <span style={{ ...mutedStyle, flex: 'none' }}>
        {stats.skills} 技能 · {stats.plugin} 插件 · {stats.tools} 工具
      </span>
    </button>
  )
}

/** 一条活动。 */
function ActivityRow(props: { readonly entry: ActivityEntry }): JSX.Element {
  const { entry } = props
  const highlight = entry.kind === 'plugin'
  return (
    <li style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, lineHeight: 1.6 }}>
      <span
        aria-hidden="true"
        style={{
          flex: 'none',
          width: 6,
          height: 6,
          borderRadius: '50%',
          marginTop: 6,
          background: entry.done ? KIND_COLOR[entry.kind] : 'transparent',
          boxShadow: entry.done
            ? 'none'
            : `inset 0 0 0 1.5px ${KIND_COLOR[entry.kind]}, 0 0 0 3px rgba(88,166,255,0.18)`,
        }}
      />
      <span
        style={{
          minWidth: 0,
          wordBreak: 'break-word',
          color: highlight ? KIND_COLOR.plugin : 'inherit',
          opacity: entry.done ? 0.75 : 1,
        }}
      >
        {describeEntry(entry)}
      </span>
      {entry.kind === 'plugin' ? (
        <span style={{ ...mutedStyle, flex: 'none', fontSize: 10 }}>本插件</span>
      ) : null}
      {entry.done ? null : <span style={{ ...mutedStyle, flex: 'none', fontSize: 10 }}>执行中</span>}
    </li>
  )
}

/** 浮层：挂在 body 上，避开槽位容器的 overflow 裁剪。 */
function ActivityOverlay(): JSX.Element | null {
  const open = useSyncExternalStore(subscribe, () => panelOpen, () => panelOpen)
  const active = useSyncExternalStore(subscribe, () => inConversation, () => inConversation)
  const [, tick] = useState(0)

  useEffect(() => {
    const listener = (): void => tick(value => value + 1)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  if (!open || !active) return null

  const stats = summarize(entries)
  const visible = recent(entries, MAX_VISIBLE)
  const hidden = entries.length - visible.length

  return (
    <div
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 96,
        transform: 'translateX(-50%)',
        width: 'min(440px, calc(100vw - 32px))',
        maxHeight: 340,
        display: 'flex',
        flexDirection: 'column',
        background: TOKEN.surface,
        backdropFilter: 'blur(40px) saturate(1.5)',
        WebkitBackdropFilter: 'blur(40px) saturate(1.5)',
        boxShadow: `0 0 0 0.5px ${TOKEN.borderStrong}, 0 3px 8px rgba(0,0,0,0.04), 0 0 20px rgba(0,0,0,0.05)`,
        borderRadius: TOKEN.radiusLg,
        color: TOKEN.label,
        pointerEvents: 'auto',
        zIndex: 9999,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 14px',
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        <span aria-hidden="true">🩺</span>
        <span>技能医生 · 活动</span>
        <span style={{ flex: 1 }} />
        <span style={{ ...mutedStyle, fontWeight: 400 }}>
          {stats.skills} 技能 · {stats.plugin} 插件 · {stats.tools} 工具
        </span>
        <button
          type="button"
          onClick={closePanel}
          title="关闭"
          aria-label="关闭活动面板"
          style={{
            flex: 'none',
            padding: '2px 8px',
            fontSize: 11,
            borderRadius: TOKEN.radius,
            border: `1px solid ${TOKEN.border}`,
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            opacity: 0.8,
          }}
        >
          ✕
        </button>
      </div>

      <div style={{ height: 1, background: TOKEN.border, opacity: 0.6 }} />

      <div style={{ overflowY: 'auto', padding: '10px 14px 12px' }}>
        {visible.length === 0 ? (
          <div style={{ fontSize: 12, opacity: 0.65, lineHeight: 1.7 }}>
            还没有工具调用。
            <br />
            模型读技能（`skill` 工具）或调用任何工具时，会实时出现在这里。
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
            {visible.map(entry => (
              <ActivityRow key={entry.callId} entry={entry} />
            ))}
          </ul>
        )}
      </div>

      <div
        style={{
          padding: '6px 14px 10px',
          fontSize: 10,
          opacity: 0.55,
          borderTop: `1px solid ${TOKEN.border}`,
          lineHeight: 1.6,
        }}
      >
        只显示最近 {MAX_VISIBLE} 条{hidden > 0 ? `，另有 ${hidden} 条更早的没展开` : ''}。
        更早于会话窗口的调用读不到；工具属于哪个插件 dsh 没有暴露，所以这里只能显示工具名。
      </div>
    </div>
  )
}

/** 把浮层挂到 body；重复调用无副作用。 */
function ensureOverlay(): void {
  if (overlayMounted || typeof document === 'undefined') return
  const host = document.createElement('div')
  host.id = OVERLAY_HOST_ID
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9998;'
  document.body.appendChild(host)
  createRoot(host).render(<ActivityOverlay />)
  overlayMounted = true
}

/**
 * 插件入口。宿主按 `dsh.client.inject` 先把 slots 服务注进来，再调 apply。
 * @param ctx - 客户端上下文。
 */
export function apply(ctx: { slots: { inject: (name: string, fn: () => void) => void; register: (options: Record<string, unknown>, component: unknown) => void } }): void {
  ensureOverlay()
  ctx.slots.inject('conversation.input.dock', () => {
    ctx.slots.register({ name: 'conversation.input.dock', id: BAR_ID, order: 60 }, ActivityBar)
  })
}

/** 客户端侧依赖的服务。 */
export const inject = ['slots'] as const
