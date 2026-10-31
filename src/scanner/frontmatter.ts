/** SKILL.md frontmatter 切分与 YAML 解析。 */
import { parse as parseYaml } from 'yaml'

/** 解析结果；error 非空表示 frontmatter 缺失或损坏。 */
export interface ParsedFrontmatter {
  /** 解析出的 YAML 对象；解析失败时为空对象。 */
  readonly data: Record<string, unknown>
  /** frontmatter 之后的正文。 */
  readonly body: string
  /** 正文第一行的 1-based 行号（用于 finding 定位）。 */
  readonly bodyLineOffset: number
  /** 解析失败原因；成功时为 undefined。 */
  readonly error?: string
}

/**
 * 切分并解析 frontmatter。
 *
 * 与官方 local provider 的边界一致：首行必须是独立的 `---`，
 * 结束行也必须是独立的 `---`；中间必须是 YAML 对象。
 * CRLF 会被接受，BOM 由 lint 单独报告但不阻止解析。
 * @param raw - 原始 SKILL.md 文本。
 * @returns 解析结果；失败时 data 为空、body 为原文。
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const withoutBom = raw.startsWith('\uFEFF') ? raw.slice(1) : raw
  const text = withoutBom.replace(/\r\n/g, '\n')
  const lines = text.split('\n')

  if (lines[0] !== '---') {
    return { data: {}, body: text, bodyLineOffset: 1, error: 'missing frontmatter: the first line must be ---' }
  }

  let closing = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      closing = i
      break
    }
  }
  if (closing < 0) {
    return { data: {}, body: text, bodyLineOffset: 1, error: 'unterminated frontmatter: no closing --- line' }
  }

  const yamlText = lines.slice(1, closing).join('\n')
  let parsed: unknown
  try {
    // 限制 YAML alias 数量，避免恶意的 alias/merge 膨胀。
    parsed = parseYaml(yamlText, { maxAliasCount: 100 })
  } catch (error) {
    return {
      data: {},
      body: lines.slice(closing + 1).join('\n'),
      bodyLineOffset: closing + 2,
      error: `invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      data: {},
      body: lines.slice(closing + 1).join('\n'),
      bodyLineOffset: closing + 2,
      error: 'frontmatter must be a YAML mapping (key: value)',
    }
  }

  return {
    data: parsed as Record<string, unknown>,
    body: lines.slice(closing + 1).join('\n'),
    bodyLineOffset: closing + 2,
  }
}
