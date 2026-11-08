/** 纯文本工具：token 估算、行号定位、正文有效性、来源路径脱敏。 */
import { homedir } from 'node:os'

/**
 * 粗略 token 估算：ASCII 约 4 字符/token，非 ASCII（CJK 等）约 0.75 token/字符。
 * 只用于预算告警，不承诺与任何 provider 的 tokenizer 一致。
 */
export function estimateTokens(text: string): number {
  let ascii = 0
  let nonAscii = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) ascii++
    else nonAscii++
  }
  return Math.ceil(ascii / 4 + nonAscii * 0.75)
}

/** 返回 needle 首次出现的 1-based 行号；找不到返回 undefined。 */
export function lineOf(text: string, needle: string): number | undefined {
  const index = text.indexOf(needle)
  if (index < 0) return undefined
  let line = 1
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) line++
  }
  return line
}

/** 正文是否“只有标题/分隔线/空行”，没有可执行指令。 */
export function isEffectivelyEmpty(body: string): boolean {
  const meaningful = body
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .filter(line => !/^#{1,6}\s/.test(line))
    .filter(line => !/^(-{3,}|\*{3,}|_{3,})$/.test(line))
    .filter(line => !/^<!--[\s\S]*-->$/.test(line))
  return meaningful.length === 0
}

/** 取文件名主干：`foo.md` → `foo`，`SKILL.md` 的父目录由调用方处理。 */
export function stem(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath
  return base.replace(/\.md$/i, '')
}


/**
 * 把技能的来源路径折叠成人能读、又不泄露本机信息的写法。
 *
 * 「来源与遮蔽」视图要显示技能来自哪个根目录，但报告会被贴到社区、日志和
 * 会话里，绝不能把用户主目录或工作区根目录的绝对路径原样带出去。
 * 规则（按顺序）：
 *   1. 在用户主目录下 -> 前缀换成 `~`；
 *   2. 在传入的项目根下 -> 前缀换成 `<项目>`；
 *   3. 其余绝对路径（例如 ad-hoc 扫描的盘符路径）-> 只保留最后两段目录名。
 * 第 3 条故意丢掉盘符与用户名：两个不同根都叫 `skills` 时仍有区分度，
 * 又不会把开发机的目录结构带出去。
 */
export function formatProvenancePath(input: string | undefined, cwd?: string): string {
  if (input === undefined || input.length === 0) return '(无本地路径)'
  const normalized = input.replace(/\\/g, '/').replace(/\/+$/, '')
  const home = homedir().replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalized === home || normalized.startsWith(`${home}/`)) {
    return `~${normalized.slice(home.length)}`
  }
  if (cwd !== undefined) {
    const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
    if (normalized === root || normalized.startsWith(`${root}/`)) {
      return `<项目>${normalized.slice(root.length)}`
    }
  }
  const parts = normalized.split('/').filter(part => part.length > 0)
  // 去掉 Windows 盘符段（例如 'D:'），连盘符也不写进报告。
  if (/^[A-Za-z]:$/.test(parts[0] ?? '')) parts.shift()
  return parts.slice(-2).join('/') || '(未知)'
}

/**
 * 路径比较前统一分隔符与末尾斜杠。
 * 不做大小写折叠：macOS / Linux 上大小写敏感，强行 lowercase 会把两个不同
 * 目录误判成同一个。SD009 与「来源与遮蔽」视图必须共用同一套比较口径，
 * 否则两处会给出互相矛盾的胜负结论。
 */
export function comparablePath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}
