/** 资源引用检查：references/ scripts/ assets/ 是否存在、是否路径穿越。 */
import { access, stat } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'
import type { Finding, SkillInput } from '../../types.js'
import { lineOf } from '../text.js'

const STRUCTURED = [
  /<((?:references|scripts|assets)\/[^>\n]+)>/g,
  /`((?:references|scripts|assets)\/[^`\n]+)`/g,
  /\]\(((?:references|scripts|assets)\/[^)\n]+)\)/g,
] as const

// 只匹配“相对引用”起点：前面不能是路径分隔符/单词字符，避免把
// `...\web-access-main\scripts\check-deps.mjs` 这类绝对路径当成技能内引用。
const PLAIN = /(?<![\w./\\-])((?:references|scripts|assets)\/[A-Za-z0-9._\-\/]+)/g
const MAX_REFS = 100

function trimRef(ref: string): string {
  return ref.trim().replace(/^['"<]+|['">]+$/g, '').replace(/[),.;:'"`\]]+$/, '')
}

function hasPlaceholder(ref: string): boolean {
  return /[<>{}$*%]/.test(ref)
}

/** 收集所有资源引用；结构化写法（尖括号/反引号/Markdown 链接）优先。 */
function collectRefs(text: string): string[] {
  const refs = new Map<string, true>()

  for (const pattern of STRUCTURED) {
    for (const match of text.matchAll(pattern)) {
      const ref = trimRef(match[1] ?? '')
      if (ref.length === 0 || hasPlaceholder(ref)) continue
      refs.set(ref, true)
    }
  }

  for (const match of text.matchAll(PLAIN)) {
    const ref = trimRef(match[1] ?? '')
    if (ref.length === 0 || hasPlaceholder(ref)) continue
    // 已被结构化写法覆盖（例如 references/foo bar.md 的短前缀）时跳过。
    let covered = false
    for (const existing of refs.keys()) {
      if (existing === ref || existing.startsWith(`${ref} `) || existing.startsWith(`${ref}\t`)) {
        covered = true
        break
      }
    }
    if (!covered) refs.set(ref, true)
  }

  return [...refs.keys()].slice(0, MAX_REFS)
}

/** 找到可用于解析相对引用的本地目录；远端/虚拟技能返回 undefined。 */
function resourceDir(skill: SkillInput): string | undefined {
  if (skill.resourceBase?.kind === 'directory') return skill.resourceBase.path
  if (skill.path !== undefined) return dirname(skill.path)
  return undefined
}

/** 对单个技能做资源引用检查；只读，不执行引用文件。 */
export async function checkResources(skill: SkillInput): Promise<Finding[]> {
  const base = resourceDir(skill)
  if (base === undefined) return []
  try {
    if (!(await stat(base)).isDirectory()) return []
  } catch {
    return []
  }

  const source = skill.raw ?? skill.content
  const findings: Finding[] = []
  for (const ref of collectRefs(skill.content)) {
    const line = lineOf(source, ref)
    if (ref.includes('\\') || ref.startsWith('/')) continue
    if (ref.split('/').includes('..')) {
      findings.push({
        rule: 'SD015',
        severity: 'warn',
        message: `正文里提到的文件 "${ref}" 带 ../，实际指向技能目录外面；这种引用可能读到不该读的文件，也可能直接找不到。`,
        file: skill.path,
        line,
        suggestion: '改成技能目录内的相对路径，不要用 ../。',
      })
      continue
    }

    // 反引号里常是命令行（例如 `python scripts/foo.py set python`）：
    // 先试完整字符串（支持带空格的文件名），再退到第一个 token（真正的路径）。
    const candidates = ref.includes(' ') ? [ref, ref.split(/\s+/)[0]!] : [ref]
    let resolved: string | undefined
    for (const candidate of candidates) {
      try {
        await access(normalize(join(base, candidate)))
        resolved = candidate
        break
      } catch {
        // 继续尝试下一个候选。
      }
    }
    if (resolved === undefined) {
      findings.push({
        rule: 'SD008',
        severity: 'warn',
        message: `正文里提到了 ${candidates.at(-1) ?? ref}，但技能目录里没有这个文件；模型照着做时会找不到它。`,
        file: skill.path,
        line,
        suggestion: '确认文件确实放在技能目录里，或者把路径写对。',
      })
    }
  }
  return findings
}
