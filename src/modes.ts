/**
 * 功能模式（chips）：点一下把"一句话"送进输入框。
 *
 * 两种投递方式，按 dsh 的能力分：
 *  1. 有对应斜杠命令的（体检/目录/改写/复诊）——插入 `/命令 ` 本身。
 *     命令由插件在宿主执行，不经过模型，快且不会被改写。
 *  2. 没有命令的（单技能诊断/插件会诊）——插入一句中文自然语言，走模型。
 *
 * 为什么 chip 显示的是英文命令名：dsh 的命令名被 `/^[a-z][a-z0-9_-]*$/` 限死，
 * 中文名注册会被拒；输入框里那个蓝色 chip 的文字直接取命令名（只有内置命令
 * 才有 `token.<name>` 中文词条，见 dsh-client-ui-commands 的字典），第三方插件
 * 拿不到本地化。所以「/复诊」这种中文 chip 在当前 dsh 上做不到，不是措辞问题。
 *
 * 纯数据 + 纯函数，面板与测试共用。
 */

/** 一个可选的功能模式。 */
export interface ModeChip {
  readonly id: string
  /** 按钮上的字，尽量短。 */
  readonly label: string
  /** 点选后写进输入框的文本；末尾留空格或冒号，方便用户续写。 */
  readonly template: string
  /** 对应的斜杠命令名（不含斜杠）；有命令时输入框里会出现蓝色命令 chip。 */
  readonly command?: string
}

/**
 * 六个模式：覆盖插件的全部入口，顺序按使用频率。
 *
 * 能走命令的优先走命令——少一轮模型往返，也不会因为模型转述而丢章节。
 */
export const MODES: readonly ModeChip[] = [
  { id: 'checkup', label: '体检全部', template: '/doctor ', command: 'doctor' },
  { id: 'scoped', label: '只看目录', template: '/scope ', command: 'scope' },
  { id: 'rewrite', label: '改写工单', template: '/rewrite ', command: 'rewrite' },
  { id: 'followup', label: '复诊对比', template: '/followup ', command: 'followup' },
  { id: 'single', label: '诊断一个', template: '诊断这个技能：' },
  { id: 'consult', label: '插件会诊', template: '插件会诊：查冲突' },
]

/** 按 id 取模板；未知 id 返回 undefined（面板自己不发明模式）。 */
export function templateOf(id: string): string | undefined {
  return MODES.find(mode => mode.id === id)?.template
}
