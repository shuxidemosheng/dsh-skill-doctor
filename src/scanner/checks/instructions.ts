/**
 * 可疑指令模式（SD012，启发式，只提示不下结论）。
 *
 * 这一条规则刻意保持 `warn`：下面所有模式都是**结构特征**，不是语义判断。
 * 一个教人用 curl 的技能、一份从网页复制来的正文、一段带终端转义的日志，
 * 都可能命中。把任何一条升成 error 都会让 `--warn-as-error` 在 CI 里挂掉
 * 一堆正常技能，也会让 baseline 误判「新冒出来一个」。
 *
 * 命中只回答「这里有肉眼容易滑过去的东西，值得看一眼」，不回答「这是恶意的」。
 */
import type { Finding, SkillInput } from '../../types.js'
import { lineOf } from '../text.js'

interface Pattern {
  readonly re: RegExp
  readonly label: string
}

export const PATTERNS: readonly Pattern[] = [
  { re: /ignore\s+(all\s+)?(previous|above|prior)\s+instructions?/i, label: '忽略前置指令' },
  { re: /disregard\s+(all\s+)?(previous|above|prior)\s+(instructions?|rules?)/i, label: '忽略前置规则' },
  { re: /(system|developer)\s+(prompt|message)\b/i, label: '引用系统/开发者提示' },
  { re: /https?:\/\/[^\s]{0,80}(token|secret|api[_-]?key|credential|password)/i, label: '外部 URL + 凭证' },
  { re: /(\.ssh|\.aws|\.env\b|id_rsa)/i, label: '敏感路径名' },
  { re: /[A-Za-z0-9+/]{200,}={0,2}/, label: '长 base64 块' },
  // 下面两条是「让藏起来的东西显形」。它们没有任何正当的文本用途：
  // 裸 ESC 是终端转义序列的起点（可改写屏幕上显示的内容），
  // Unicode 标签字符区 U+E0000–U+E007F 的唯一用途就是承载不可见文本。
  // 注意 `\uFEFF`（BOM）不在这里：它是合法编码标记，由 SD013 单独处理，
  // 且已包含在下面的 HIDDEN 里，重复加只会多一条 finding。
  { re: /\u001B/, label: '裸 ESC 控制字符（终端转义注入）' },
  { re: /[\u{E0000}-\u{E007F}]/u, label: '不可见 Unicode 标签字符' },
]

/** 零宽与双向控制符：现有规则，已覆盖 bidi（U+202A–U+202E / U+2066–U+2069）。 */
export const HIDDEN = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/

/**
 * 「下载后直接执行」这一族管道写法。
 *
 * 只匹配管道形态，不匹配普通的 `curl URL` 取数据 —— 后者是正常技能里常见的
 * 示例。一个技能里同时出现好几种时只报**一条**，避免同一个根因刷出 6 条
 * 告警，把共性问题聚类搞乱。
 */
export const REMOTE_EXEC: readonly Pattern[] = [
  { re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b/, label: '下载内容管道进 shell' },
  { re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?python[0-9.]*\b/, label: '下载内容管道进 python' },
  { re: /\bbase64\s+(?:-d|--decode)\b[^\n|]*\|\s*(?:ba|z|k)?sh\b/, label: 'base64 解码后管道进 shell' },
  { re: /\beval\s+["']?\$\(\s*(?:curl|wget)\b/, label: 'eval 执行下载结果' },
  { re: /\/dev\/tcp\//, label: '通过 /dev/tcp 建立原始连接' },
]

/** 对正文做启发式检查；命中不等于恶意，需人工判断。 */
export function checkInstructions(skill: SkillInput): Finding[] {
  const findings: Finding[] = []
  const text = skill.content

  for (const pattern of PATTERNS) {
    const match = text.match(pattern.re)
    if (match === null) continue
    findings.push({
      rule: 'SD012',
      severity: 'warn',
      message: `正文里出现了可疑写法（${pattern.label}）。这只是模式匹配，可能误报，但值得看一眼它想让模型做什么。`,
      file: skill.path,
      line: lineOf(text, match[0]),
      suggestion: '人工确认这个技能的来源和意图；命中不等于恶意。',
    })
  }

  // 远程执行管道单独一组：命中即停，一个技能最多多一条 SD012。
  for (const pattern of REMOTE_EXEC) {
    const match = text.match(pattern.re)
    if (match === null) continue
    findings.push({
      rule: 'SD012',
      severity: 'warn',
      message: `正文里有「下载后直接执行」的写法（${pattern.label}）。教人用 curl 的技能也会命中，确认一下上下文即可。`,
      file: skill.path,
      line: lineOf(text, match[0]),
      suggestion: '人工确认这个技能的来源和意图；命中不等于恶意。',
    })
    break
  }

  const hidden = text.match(HIDDEN)
  if (hidden !== null) {
    findings.push({
      rule: 'SD012',
      severity: 'warn',
      message: '正文里有看不见的零宽或方向控制字符，常被用来藏文字，正常写作几乎用不到。',
      file: skill.path,
      line: lineOf(text, hidden[0]),
      suggestion: '在编辑器中显示不可见字符并确认来源。',
    })
  }

  return findings
}
