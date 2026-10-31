/** 可疑指令模式（启发式，只提示不下结论）。 */
import type { Finding, SkillInput } from '../../types.js'
import { lineOf } from '../text.js'

interface Pattern {
  readonly re: RegExp
  readonly label: string
}

const PATTERNS: readonly Pattern[] = [
  { re: /ignore\s+(all\s+)?(previous|above|prior)\s+instructions?/i, label: '忽略前置指令' },
  { re: /disregard\s+(all\s+)?(previous|above|prior)\s+(instructions?|rules?)/i, label: '忽略前置规则' },
  { re: /(system|developer)\s+(prompt|message)\b/i, label: '引用系统/开发者提示' },
  { re: /https?:\/\/[^\s]{0,80}(token|secret|api[_-]?key|credential|password)/i, label: '外部 URL + 凭证' },
  { re: /(\.ssh|\.aws|\.env\b|id_rsa)/i, label: '敏感路径名' },
  { re: /[A-Za-z0-9+/]{200,}={0,2}/, label: '长 base64 块' },
]

const HIDDEN = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/

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
