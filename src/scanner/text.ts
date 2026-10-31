/** 纯文本工具：token 估算、行号定位、正文有效性。 */

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
