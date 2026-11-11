/**
 * 功能模式（chips）：面板上的七个按钮。
 *
 * 数据源是 `source.ts` 的 `DOCTOR_CANDIDATES`——菜单里的中文候选与面板按钮
 * 必须一一对应，分成两份数据迟早会漂移。
 *
 * 点按钮往输入框写的是**中文 token**（`/复诊 `），不是英文命令：
 * dsh 的输入框检测（detectTrigger）只找最近的 `/`、query 允许任意字符，
 * 所以我们注册的引用源能把它认出来并渲染成引用样式；提交时再由 codec
 * 换成合法命令（`/followup`）执行。显示中文、执行英文。
 *
 * 纯数据 + 纯函数，面板与测试共用。
 */
import { DOCTOR_CANDIDATES } from './source.js'

/** 一个可选的功能模式。 */
export interface ModeChip {
  readonly id: string
  /** 按钮上的字，尽量短。 */
  readonly label: string
  /** 点选后写进输入框的文本；末尾留空格，方便用户续写参数。 */
  readonly template: string
  /** 对应的斜杠命令名（不含斜杠）；没有命令的走自然语言。 */
  readonly command?: string
}

/** 七个模式：覆盖插件的全部入口，顺序与菜单一致（按使用频率）。 */
export const MODES: readonly ModeChip[] = DOCTOR_CANDIDATES.map(candidate => ({
  id: candidate.name,
  label: candidate.label,
  // 落 ASCII token 而不是中文名：中文名匹配不上 chip 正则，只能是白色文本。
  template: `/${candidate.token} `,
  command: candidate.token,
}))

/** 按 id 取模板；未知 id 返回 undefined（面板自己不发明模式）。 */
export function templateOf(id: string): string | undefined {
  return MODES.find(mode => mode.id === id)?.template
}
