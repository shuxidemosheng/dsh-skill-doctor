/**
 * 中文候选：给输入框的 `/` 菜单加一组「技能医生」条目。
 *
 * 为什么能绕开"命令名只能是英文"的限制：
 * dsh 输入框里有**两套**斜杠机制，长得一样（都是蓝色），但约束不同：
 *   1. **命令（command）**——`ctx.commands.register({name})`。
 *      名字被 `/^[a-z][a-z0-9_-]*$/` 限死，chip 文字直接取 name，
 *      且只有内置命令有中文词条（`/plan`→「计划」）。第三方拿不到。
 *   2. **引用源（input trigger source）**——`ctx.inputTriggers.registerSource(src)`。
 *      技能（`@`/`/` 后面的技能名）走的就是这条。它只要求 `(trigger, name)` 唯一，
 *      **候选的名字、描述、显示文本全由插件给**，所以中文完全合法。
 *
 * 所以这里注册一个引用源：菜单里显示中文（体检/复诊/改写…），选中后输入框里
 * 就是 `/复诊 ` 这样一段被识别为引用的蓝色 token；提交时再用 `codec.serialize`
 * 把它换成真正的合法命令（`/followup`），dsh 解析后由插件在宿主执行。
 *
 * 显示中文、执行英文——两条机制各取所长。
 */

/** 一条中文候选。 */
export interface DoctorCandidate {
  /** 菜单与输入框里显示的名字（中文，可以带空格之外的任意字符）。 */
  readonly name: string
  /** 面板按钮上的文字（比 name 更完整，例如「复诊对比」）。 */
  readonly label: string
  /** 菜单右侧的说明。 */
  readonly description: string
  /** 提交时替换成哪条斜杠命令；没有则用 `fallback` 的自然语言。 */
  readonly command?: string
  /** 没有命令时提交给模型的自然语言。 */
  readonly fallback?: string
}

/**
 * 六条候选，与面板上的六个功能一一对应（顺序也一致）。
 *
 * 名字刻意短：它在输入框里等同"标签"，长了就退化成句子。
 */
export const DOCTOR_CANDIDATES: readonly DoctorCandidate[] = [
  { name: '体检', label: '体检全部', description: '全部技能体检：模型能不能看到、会不会选中', command: 'doctor' },
  { name: '查目录', label: '只看目录', description: '只体检这个目录（后面接路径）', command: 'scope' },
  { name: '改写', label: '改写工单', description: '简介改写工单（后面接技能名）', command: 'rewrite' },
  { name: '复诊', label: '复诊对比', description: '和上次病历对比：好了多少、坏在哪', command: 'followup' },
  { name: '诊断', label: '诊断一个', description: '诊断单个技能（后面接技能名）', fallback: '诊断这个技能：' },
  { name: '会诊', label: '插件会诊', description: '插件冲突 + 技能链路交叉检查', fallback: '插件会诊：查冲突' },
]

/** 引用源的注册名（`(trigger, name)` 唯一，撞了会抛）。 */
export const SOURCE_NAME = 'skill-doctor'

/** 去掉可能带的 `/` 前缀，取候选名。 */
function candidateOf(ref: string): DoctorCandidate | undefined {
  const bare = ref.replace(/^\//u, '').trim()
  return DOCTOR_CANDIDATES.find(candidate => candidate.name === bare)
}

/**
 * 提交时的模型/命令文本。
 *
 * chip 提交前会被替换成这段文字，然后 dsh 解析整行：以 `/` 开头且是已注册命令
 * 就走命令（插件在宿主直接执行），否则作为普通消息交给模型。
 * @param ref - 引用 id（`/复诊` 这种）。
 */
export function serializeRef(ref: string): string {
  const candidate = candidateOf(ref)
  if (candidate === undefined) return ref
  if (candidate.command !== undefined) return `/${candidate.command} `
  return candidate.fallback ?? candidate.name
}

/** 注册引用的最小接口（只用到 registerSource）。 */
interface TriggerSourceHost {
  registerSource?: (source: unknown) => (() => void) | undefined
}

/**
 * 组装引用源对象。
 *
 * 字段语义（照 dsh-client-ui-skill 的实现）：
 *   - `trigger` / `name`：`(trigger, name)` 唯一，决定菜单分组。
 *   - `candidates`：输入 `/xxx` 时给出候选项（名字 + 说明）。
 *   - `lexicon`：已经打出来的 token 里哪些算引用——没有它，手打的 `/复诊`
 *     不会被识别，只有从菜单选才行。
 *   - `subscribeLexicon`：目录变化时通知编辑器刷新（我们的是静态表，空实现）。
 *   - `openReference`：点 chip 时打开源文件；我们没源文件，返回 false。
 *   - `onPick`：选中候选后往输入框写什么。写 `/名字 ` 让 detect 认出它是引用。
 *   - `codec.serialize`：提交前把 chip 换成真正的文本（这里是合法命令）。
 */
function buildSource(): Record<string, unknown> {
  return {
    // 与技能、命令共用 `/`：菜单会按来源分组，互不覆盖。
    trigger: '/',
    name: SOURCE_NAME,
    // 排在技能（2）之后，避免把最常用的技能挤下去。
    order: 8,
    candidates: async (_session: unknown, { query }: { query: string }) => {
      const keyword = query.trim()
      return DOCTOR_CANDIDATES
        .filter(candidate => keyword.length === 0
          || candidate.name.includes(keyword)
          || candidate.description.includes(keyword))
        .map(candidate => ({ name: candidate.name, description: candidate.description }))
    },
    // 已经打出来的 `/复诊` 也要能被识别成引用（不只是从菜单选）。
    lexicon: () => DOCTOR_CANDIDATES.map(candidate => candidate.name),
    subscribeLexicon: () => () => {},
    // 没有可打开的源文件，点 chip 不做事。
    openReference: () => false,
    onPick: ({ candidate }: { candidate: { name: string } }) => ({ text: `/${candidate.name} ` }),
    codec: { serialize: async (ref: string) => serializeRef(ref) },
  }
}

/**
 * 把「技能医生」注册成输入框的一个引用源。
 *
 * 服务通过 `ctx.get('inputTriggers')` 探测而不是写进 `inject`：注入是**必需**
 * 语义，名字不对或服务缺失会让整个客户端插件不 apply（面板直接消失）。
 * 探测失败只是没有这组候选，面板与命令照常。
 * @param ctx - 客户端插件上下文。
 * @returns 是否注册成功（测试与日志用）。
 */
export function registerTriggerSource(ctx: unknown): boolean {
  const holder = ctx as {
    get?: (name: string) => unknown
    effect?: (fn: () => unknown, label?: string) => unknown
    inject?: (deps: string[], fn: (scope: { inputTriggers?: TriggerSourceHost }) => void) => unknown
  } | undefined
  if (holder === undefined) return false

  /**
   * 装一个 source，并用 effect 绑定注销。
   *
   * 单独抽出来是因为它可能被两条路径调用：直接探测（服务已就绪）或
   * cordis 的运行时等待（服务稍后才出现）。
   */
  const mount = (host: TriggerSourceHost | undefined): boolean => {
    if (host === undefined || typeof host.registerSource !== 'function') return false
    try {
      const dispose = host.registerSource(source)
      if (typeof holder.effect === 'function' && typeof dispose === 'function') {
        holder.effect(() => dispose, 'skill-doctor: trigger source')
      }
      return true
    } catch {
      // (trigger, name) 已被占用（例如插件被加载两次）：不阻断任何东西。
      return false
    }
  }

  const source = buildSource()

  // 首选运行时等待：客户端插件的 apply 常常早于 input-trigger 服务挂载，
  // 直接 get 会拿到 undefined 而永久放弃。ctx.inject 只影响这次回调的时机，
  // 不会把服务写进插件的必需依赖，所以服务缺失时面板照常、只是没有这组候选。
  if (typeof holder.inject === 'function') {
    try {
      let mounted = false
      holder.inject(['inputTriggers'], scope => {
        mounted = mount(scope.inputTriggers)
      })
      if (mounted) return true
      // 回调可能稍后执行；只要 inject 调用本身没抛，就认为"已安排"。
      return true
    } catch {
      /* 落到下面的直接探测 */
    }
  }

  if (typeof holder.get !== 'function') return false
  let host: TriggerSourceHost | undefined
  try {
    host = holder.get('inputTriggers') as TriggerSourceHost | undefined
  } catch {
    host = undefined
  }
  return mount(host)
}
