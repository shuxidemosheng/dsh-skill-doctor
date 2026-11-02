/**
 * 功能模式（chips）：点一下选中一种用法，模板直接进输入框。
 *
 * 为什么用"模板填入"而不是"按钮直接执行"：客户端面板跑在 webview 里，
 * 调不到宿主侧的工具（工具属于 agent 循环）；能确定性操作的是输入框。
 * 所以交互设计成"选功能 → 补内容 → 回车"，用户仍然走一次模型，
 * 但不用记提示词，也不会点错功能。
 *
 * 纯数据 + 纯函数，面板与测试共用。
 */

/** 一个可选的功能模式。 */
export interface ModeChip {
  readonly id: string
  /** 按钮上的字，尽量短。 */
  readonly label: string
  /** 点选后写进输入框的模板；末尾留空格或冒号，方便用户续写。 */
  readonly template: string
}

/**
 * 六个模式：覆盖插件的全部入口，顺序按使用频率。
 *
 * 模板刻意写得短——它只是"这句话的开头"，用户接着补路径或技能名。
 * 曾经写成整句（"用技能体检工具体检一下所有技能，把报告完整给我看。"），
 * 用户反馈像在念提示词、太啰嗦；短标签的语义靠工具描述兜住即可。
 */
export const MODES: readonly ModeChip[] = [
  { id: 'checkup', label: '体检全部', template: '技能体检' },
  { id: 'scoped', label: '只看目录', template: '体检这个目录：' },
  { id: 'single', label: '诊断一个', template: '诊断这个技能：' },
  { id: 'rewrite', label: '改写工单', template: '简介改写工单：' },
  { id: 'followup', label: '复诊对比', template: '技能复诊：和上次对比' },
  { id: 'consult', label: '插件会诊', template: '插件会诊：查冲突' },
]

/** 按 id 取模板；未知 id 返回 undefined（面板自己不发明模式）。 */
export function templateOf(id: string): string | undefined {
  return MODES.find(mode => mode.id === id)?.template
}
