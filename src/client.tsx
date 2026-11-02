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
import { MODES, templateOf, type ModeChip } from './modes.js'
import {
  collectActivity,
  currentEntry,
  describeEntry,
  emptyUsage,
  loadUsage,
  mergeActivity,
  recent,
  recordSession,
  recordSkillLoad,
  saveUsage,
  clampPanelPosition,
  clearPanelPosition,
  isInteractiveTarget,
  loadPanelPosition,
  savePanelPosition,
  skillLoadNames,
  summarize,
  topSkills,
  usageSummary,
  type ActivityEntry,
  type PanelPosition,
  type UsageRecord,
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
/** 当前选中的功能模式；null 表示没选。 */
let activeMode: string | null = null
/** 点 chip 之后的反馈（写入成功 / 已复制 / 失败原因），显示在条上一行。 */
let modeFeedback: string | null = null
let panelOpen = false
let panelTab: 'activity' | 'usage' | 'modes' = 'modes'
let inConversation = false
let overlayMounted = false

/** 客户端 ctx（apply 时存下来），chips 需要它去拿会话输入 API。 */
let clientCtx: unknown

/** 浮层位置；undefined = 默认居中偏下（首次使用/用户双击复位后）。 */
let panelPos: PanelPosition | undefined
/** 拖动中的临时状态（不参与渲染，只给事件处理用）。 */
let dragState: { startX: number; startY: number; originX: number; originY: number } | undefined

/** 跨会话使用统计；apply 时从 localStorage 载入，之后随调用累加。 */
let usage: UsageRecord = emptyUsage()
/** 已计入统计的 callId；换会话清空（快照里的 callId 不会跨会话重复）。 */
const countedCallIds = new Set<string>()

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

/** localStorage 的安全取用；宿主环境禁了就退化为“本次会话的统计”。 */
function storageOf(): Storage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage
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
  const known = new Set(countedCallIds)
  const merged = changedScope ? [...next] : mergeActivity(entries, next)
  if (merged.length === entries.length && merged.every((entry, index) => entry === entries[index])) return
  entries = merged

  // 跨会话统计：只数“第一次见到”的调用，同一 callId 在窗口里反复出现不重复计。
  let changedUsage = false
  if (changedScope && scope !== '' && usage.sessions[scope] !== true) {
    usage = recordSession(usage, scope)
    changedUsage = true
  }
  const fresh = merged.filter(entry => !known.has(entry.callId))
  for (const entry of fresh) countedCallIds.add(entry.callId)
  for (const name of skillLoadNames(fresh)) {
    usage = recordSkillLoad(usage, name, sessionId)
    changedUsage = true
  }
  if (changedUsage) saveUsage(storageOf(), usage)
  emit()
}

let currentScope: string | undefined

/**
 * 把模板送进输入框。
 *
 * 两条路：
 *  1. 会话输入 API（`ctx.sessions.scope(id).get('conversation').input.for(scope).insertText`），
 *     官方语音插件用的是这条路——但第三方插件是否拿得到未经验证；
 *  2. 退化：写剪贴板 + 明确提示，用户 Cmd/Ctrl+V 即可。
 * 无论哪条路，模板文字都会显示在反馈行里，用户不会"点了没反应"。
 */
function applyMode(chip: ModeChip, sessionId: string | undefined, ctx?: unknown): void {
  activeMode = chip.id
  const result = insertText(chip.template, sessionId, ctx)
  modeFeedback = result === 'service'
    ? `已填入输入框：${chip.label}`
    : result === 'dom'
      ? `已填入输入框（DOM 方式）：${chip.label}`
      : `已复制到剪贴板（${chip.label}）：粘贴到输入框即可`
  if (result === 'none') copyToClipboard(chip.template)
  emit()
}

/**
 * 把文本送进输入框，按优先级尝试三条路，返回实际生效的那条。
 *
 * 1. `service`：会话控制器服务（官方插件同款）。需要宿主把服务注入进来，
 *    我们声明的是 `slots`，所以第三方插件这条路可能拿不到——实测验证。
 * 2. `dom`：直接对输入框元素派发编辑命令。面板和输入框在同一个 document 里，
 *    不依赖任何私有 API；只对 contenteditable / textarea 生效。
 * 3. `none`：两者都不可用，退化为剪贴板。
 */
function insertText(text: string, sessionId: string | undefined, ctx: unknown): 'service' | 'dom' | 'none' {
  if (tryServiceInsert(text, sessionId, ctx)) return 'service'
  if (tryDomInsert(text)) return 'dom'
  return 'none'
}

/** 路线 1：通过注入的会话服务写入。 */
function tryServiceInsert(text: string, sessionId: string | undefined, ctx: unknown): boolean {
  try {
    const holder = ctx as {
      sessions?: { scope?: (id: string) => unknown }
      conversation?: { input?: { for?: (s: unknown) => { insertText?: (t: string, span?: unknown) => boolean } } }
      get?: (name: string) => unknown
    } | undefined
    if (holder === undefined) return false
    const sessions = holder.sessions ?? (holder.get?.('sessions') as { scope?: (id: string) => unknown } | undefined)
    if (sessions === undefined || typeof sessions.scope !== 'function' || sessionId === undefined) return false
    const scope = sessions.scope(sessionId) as {
      get?: (name: string) => unknown
      conversation?: unknown
    } | undefined
    const conversation = (scope?.conversation
      ?? scope?.get?.('conversation')
      ?? holder.conversation) as {
      input?: { for?: (s: unknown) => { insertText?: (t: string, span?: unknown) => boolean } }
    } | undefined
    const api = conversation?.input?.for?.(scope)
    const insert = api?.insertText
    if (typeof insert !== 'function') return false
    return insert.call(api, text) === true
  } catch {
    return false
  }
}

/**
 * 路线 2：直接操作输入框 DOM。
 *
 * 只碰"看起来像输入框"的元素：contenteditable 或 textarea，且必须可见。
 * 用 beforeinput 派发更贴近浏览器原生编辑，编辑器（如 Lexical）通常能识别；
 * 识别不了再退回 execCommand——两者都是标准 DOM 行为，不改宿主结构。
 */
function tryDomInsert(text: string): boolean {
  if (typeof document === 'undefined') return false
  const candidates = [...document.querySelectorAll<HTMLElement>('[contenteditable="true"], textarea')]
    .filter(node => node.offsetParent !== null && !node.closest(`#${OVERLAY_HOST_ID}`))
    .filter(node => !(node as HTMLTextAreaElement).readOnly)
  const target = candidates[candidates.length - 1]
  if (target === undefined) return false
  try {
    target.focus()
    if (target instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(target, `${target.value}${text}`)
      target.dispatchEvent(new Event('input', { bubbles: true }))
      return target.value.endsWith(text)
    }
    const before = target.textContent ?? ''
    // 连点同一个 chip 时不要再叠一遍：已经以这段模板结尾就当作已完成。
    if (before.endsWith(text)) return true
    const event = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    })
    // dispatchEvent 返回 false 表示监听器调用了 preventDefault——编辑器已接管这次插入。
    // 不能再补 execCommand：之前正是"先派发、再补一刀"导致模板重复两次。
    const notPrevented = target.dispatchEvent(event)
    if (!notPrevented) return true
    if ((target.textContent ?? '') !== before) return true
    document.execCommand('insertText', false, text)
    return true
  } catch {
    return false
  }
}

/** 剪贴板兜底；环境不支持时静默（反馈行里仍然有完整模板可复制）。 */
function copyToClipboard(text: string): void {
  try {
    void navigator.clipboard?.writeText(text)
  } catch {
    /* 无剪贴板权限：模板已经显示在反馈行里 */
  }
}

function togglePanel(): void {
  panelOpen = !panelOpen
  emit()
}

function switchTab(tab: 'activity' | 'usage' | 'modes'): void {
  panelTab = tab
  emit()
}

function closePanel(): void {
  if (!panelOpen) return
  panelOpen = false
  emit()
}

/** 开始拖动：记录起点与面板当前位置，指针捕获保证移出面板也能收到 move。 */
function startDrag(event: {
  button: number
  clientX: number
  clientY: number
  pointerId: number
  currentTarget: HTMLElement
  target: unknown
  preventDefault: () => void
}): void {
  if (event.button !== 0) return
  // 按在按钮/输入框上不启动拖动：否则标题栏捕获指针，按钮的 click 收不到。
  if (isInteractiveTarget(event.target)) return
  const panel = event.currentTarget.parentElement
  if (panel === undefined || panel === null) return
  const rect = panel.getBoundingClientRect()
  dragState = {
    startX: event.clientX,
    startY: event.clientY,
    originX: rect.left,
    originY: rect.top,
  }
  event.currentTarget.setPointerCapture?.(event.pointerId)
  event.preventDefault()
}

/** 拖动中：按位移算新位置，并夹进视口（不让面板被拖出屏幕）。 */
function moveDrag(event: { clientX: number; clientY: number; currentTarget: HTMLElement }): void {
  if (dragState === undefined) return
  const panel = event.currentTarget.parentElement
  const size = {
    width: panel?.offsetWidth ?? 440,
    height: panel?.offsetHeight ?? 340,
  }
  panelPos = clampPanelPosition(
    { x: dragState.originX + (event.clientX - dragState.startX), y: dragState.originY + (event.clientY - dragState.startY) },
    { width: typeof window === 'undefined' ? 1280 : window.innerWidth, height: typeof window === 'undefined' ? 800 : window.innerHeight },
    size,
  )
  emit()
}

/** 结束拖动：落库位置，下次打开仍在原处。 */
function endDrag(): void {
  if (dragState === undefined) return
  dragState = undefined
  if (panelPos !== undefined) savePanelPosition(storageOf(), panelPos)
}

/** 双击标题：回到默认位置（居中偏下）并清掉记住的坐标。 */
function resetDrag(): void {
  dragState = undefined
  panelPos = undefined
  clearPanelPosition(storageOf())
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

/** 使用统计页：跨会话累计的技能加载排行。 */
function UsageView(): JSX.Element {
  const summary = usageSummary(usage)
  const top = topSkills(usage, 10)
  return (
    <div>
      {summary.totalLoads === 0 ? (
        <div style={{ fontSize: 12, opacity: 0.65, lineHeight: 1.7 }}>
          还没有统计：模型第一次用 <code>skill</code> 工具读技能后，这里会开始累计。
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 14, fontSize: 11, opacity: 0.75, padding: '2px 0 8px' }}>
            <span>累计加载 <b>{summary.totalLoads}</b> 次</span>
            <span>涉及 <b>{summary.distinctSkills}</b> 个技能</span>
            <span>覆盖 <b>{summary.sessions}</b> 个会话</span>
          </div>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
            {top.map(item => (
              <li
                key={item.name}
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'baseline',
                  fontSize: 12,
                  lineHeight: 1.7,
                }}
              >
                <span
                  style={{
                    flex: 'none',
                    minWidth: 28,
                    textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums',
                    opacity: 0.75,
                  }}
                >
                  {item.loads}
                </span>
                <span style={{ minWidth: 0, wordBreak: 'break-word' }}>{item.name}</span>
                <span style={{ flex: 1 }} />
                <span style={{ ...mutedStyle, flex: 'none', fontSize: 10 }}>
                  {item.lastUsed.length >= 10 ? item.lastUsed.slice(0, 10) : ''}
                </span>
              </li>
            ))}
          </ol>
          {summary.distinctSkills > top.length ? (
            <div style={{ fontSize: 10, opacity: 0.55, padding: '6px 0 0' }}>
              只显示前 {top.length} 名，共 {summary.distinctSkills} 个技能。
            </div>
          ) : null}
        </>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 0 0' }}>
        <span style={{ fontSize: 10, opacity: 0.55, flex: 1, lineHeight: 1.6 }}>
          只统计本机（浏览器存储），不上传。模型直接 read 技能文件不计——读不到归属，宁可少记不记错。
        </span>
        {summary.totalLoads > 0 ? (
          <button
            type="button"
            onClick={() => {
              if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm('清空使用统计？此操作不可恢复。')) return
              usage = emptyUsage()
              saveUsage(storageOf(), usage)
              emit()
            }}
            style={{
              flex: 'none',
              padding: '2px 8px',
              fontSize: 10,
              borderRadius: TOKEN.radius,
              border: `1px solid ${TOKEN.border}`,
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              opacity: 0.7,
            }}
          >
            清空
          </button>
        ) : null}
      </div>
    </div>
  )
}

/** 功能页：六个模式，点一下高亮并把模板送进输入框。 */
function ModesView(props: { readonly sessionId?: string }): JSX.Element {
  const [, tick] = useState(0)
  useEffect(() => {
    const listener = (): void => tick(value => value + 1)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
        {MODES.map(chip => {
          const active = activeMode === chip.id
          return (
            <button
              key={chip.id}
              type="button"
              onClick={() => applyMode(chip, props.sessionId, clientCtx)}
              title={chip.template}
              style={{
                padding: '8px 10px',
                fontSize: 12,
                textAlign: 'left',
                borderRadius: TOKEN.radius,
                border: `1px solid ${active ? KIND_COLOR.skill : TOKEN.border}`,
                background: active ? KIND_COLOR.skill : 'transparent',
                color: active ? '#fff' : 'inherit',
                cursor: 'pointer',
                fontWeight: active ? 600 : 400,
              }}
            >
              {chip.label}
            </button>
          )
        })}
      </div>
      <div style={{ fontSize: 11, opacity: 0.6, lineHeight: 1.6, paddingTop: 8 }}>
        选一个功能 → 模板会进入输入框（拿不到输入框权限时会复制到剪贴板）→ 补上路径或技能名 → 回车。
        <br />
        也可以直接打斜杠命令（选中后是蓝色 chip，由插件自己执行、不经过模型）：
        <code style={{ opacity: 0.85 }}>/doctor</code>、<code style={{ opacity: 0.85 }}>/scope &lt;目录&gt;</code>、<code style={{ opacity: 0.85 }}>/followup</code>、<code style={{ opacity: 0.85 }}>/rewrite &lt;技能名&gt;</code>
      </div>
      {modeFeedback === null ? null : (
        <div style={{ fontSize: 11, paddingTop: 6, lineHeight: 1.6, color: KIND_COLOR.plugin }}>
          {modeFeedback}
        </div>
      )}
    </div>
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
        ...panelPos === undefined
          ? { left: '50%', bottom: 96, transform: 'translateX(-50%)' }
          : { left: panelPos.x, top: panelPos.y },
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
        onPointerDown={event => startDrag(event as unknown as Parameters<typeof startDrag>[0])}
        onPointerMove={event => moveDrag(event as unknown as Parameters<typeof moveDrag>[0])}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={resetDrag}
        title="拖动可移动面板，双击复位"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 14px',
          fontSize: 12,
          fontWeight: 600,
          cursor: dragState === undefined ? 'grab' : 'grabbing',
          userSelect: 'none',
          touchAction: 'none',
        }}
      >
        <span aria-hidden="true" style={{ opacity: 0.45, letterSpacing: 1 }}>⠿</span>
        <span aria-hidden="true">🩺</span>
        <span>技能医生</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => switchTab('modes')}
          style={{
            padding: '2px 8px',
            fontSize: 11,
            borderRadius: TOKEN.radius,
            border: `1px solid ${panelTab === 'modes' ? TOKEN.borderStrong : 'transparent'}`,
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            fontWeight: panelTab === 'modes' ? 600 : 400,
          }}
        >
          功能
        </button>
        <button
          type="button"
          onClick={() => switchTab('activity')}
          style={{
            padding: '2px 8px',
            fontSize: 11,
            borderRadius: TOKEN.radius,
            border: `1px solid ${panelTab === 'activity' ? TOKEN.borderStrong : 'transparent'}`,
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            fontWeight: panelTab === 'activity' ? 600 : 400,
          }}
        >
          活动
        </button>
        <button
          type="button"
          onClick={() => switchTab('usage')}
          style={{
            padding: '2px 8px',
            fontSize: 11,
            borderRadius: TOKEN.radius,
            border: `1px solid ${panelTab === 'usage' ? TOKEN.borderStrong : 'transparent'}`,
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            fontWeight: panelTab === 'usage' ? 600 : 400,
          }}
        >
          使用统计
        </button>
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
        {panelTab === 'modes' ? (
          <ModesView sessionId={currentScope === undefined ? undefined : currentScope} />
        ) : panelTab === 'usage' ? (
          <UsageView />
        ) : visible.length === 0 ? (
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
  clientCtx = ctx
  // 统计与面板位置都是纯客户端状态：宿主注入完成后立刻从 localStorage 恢复。
  usage = loadUsage(storageOf())
  panelPos = loadPanelPosition(storageOf())
  ensureOverlay()
  ctx.slots.inject('conversation.input.dock', () => {
    ctx.slots.register({ name: 'conversation.input.dock', id: BAR_ID, order: 60 }, ActivityBar)
  })
}

/**
 * 客户端依赖的服务。
 *
 * 只声明 `slots`。曾经试过加上 `conversation` / `sessions`（想拿
 * `beginCommand` 做蓝色命令 token），实测**面板直接消失**——cordis 的语义是
 * 注入列表里任一服务缺失就整体不 apply，而这些服务对第三方客户端插件不可见。
 * 结论：输入框只能走 DOM 注入纯文本，命令节点这条路对第三方插件关闭。
 * 不要再往这里加名字，除非先确认该服务真的会被提供。
 */
export const inject = ['slots'] as const
