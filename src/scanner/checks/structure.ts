/** 结构类检查：frontmatter、name、description、正文、invocation、编码。 */
import type { ResolvedConfig } from '../../config.js'
import type { Finding, SkillInput } from '../../types.js'
import { parseFrontmatter } from '../frontmatter.js'
import { isEffectivelyEmpty, lineOf } from '../text.js'

/** 与官方 @deepseek-ai/dsh-skill 的 kebab-case 文法一致；本地复制避免打包注册表闭包。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 官方 invocation 解析接受的宽松布尔拼写。 */
function isLenientBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return true
  if (value === 1 || value === 0) return true
  if (typeof value !== 'string') return false
  return /^(true|false|yes|no|on|off)$/i.test(value)
}

/** 结构类检查入口。raw 不存在时只做运行时可达的检查。 */
export function checkStructure(skill: SkillInput, config: ResolvedConfig): Finding[] {
  const findings: Finding[] = []
  const raw = skill.raw
  const parsed = raw === undefined ? undefined : parseFrontmatter(raw)
  const file = skill.path

  if (raw !== undefined && raw.startsWith('\uFEFF')) {
    findings.push({
      rule: 'SD013',
      severity: 'info',
      message: '文件开头有一个看不见的编码标记（BOM），可能让第一行的 --- 认不出来，技能就读不到文件头。',
      file,
      line: 1,
      suggestion: '用编辑器另存为“无 BOM 的 UTF-8”。',
    })
  }

  if (raw !== undefined && raw.includes('\r\n')) {
    findings.push({
      rule: 'SD014',
      severity: 'info',
      message: '文件用的是 Windows 换行符（CRLF）。一般能正常读，但跨平台编辑时容易变成混着两种换行。',
      file,
      suggestion: '统一改成 LF 更稳妥。',
    })
  }

  if (parsed?.error !== undefined) {
    findings.push({
      rule: 'SD001',
      severity: 'error',
      message: parsed.error,
      file,
      line: 1,
      suggestion: '首行写独立 ---，YAML 对象结束后再写一条独立 ---。',
    })
  }

  if (!SKILL_NAME.test(skill.name)) {
    findings.push({
      rule: 'SD002',
      severity: 'error',
      message: `技能名 "${skill.name}" 里有不允许的字符；这种名字可能让 dsh 加载不了这个技能。`,
      file,
      line: raw === undefined ? undefined : lineOf(raw, 'name:'),
      suggestion: '只使用小写字母、数字和单个连字符，例如 code-review。',
    })
  } else if (skill.directoryName !== undefined && skill.directoryName !== skill.name) {
    findings.push({
      rule: 'SD002',
      severity: 'warn',
      message: `技能名 "${skill.name}" 和文件夹名 "${skill.directoryName}" 不一样。dsh 认文件头里的 name，一般不影响使用；但如果别的工具按文件夹名找技能，就可能对不上。`,
      file,
      line: raw === undefined ? undefined : lineOf(raw, 'name:'),
      suggestion: '如果你没有特意这么写，建议把文件夹名改成和技能名一致。',
    })
  } else if (skill.name.length > 64) {
    findings.push({
      rule: 'SD011',
      severity: 'info',
      message: `技能名有 ${skill.name.length} 个字符，偏长，输入 /命令 时不好记也不好补全。`,
      file,
      suggestion: '缩短一点，控制在 64 字符以内。',
    })
  }

  // frontmatter 本身坏了时，SD001 已经说明问题；不再用空 description 重复刷屏。
  if (parsed === undefined || parsed.error === undefined) {
    const description = (parsed?.data.description !== undefined
      ? typeof parsed.data.description === 'string' ? parsed.data.description : String(parsed.data.description)
      : skill.description).trim()

    if (description.length === 0) {
      findings.push({
        rule: 'SD003',
        severity: 'error',
        message: '简介是空的。模型只能靠简介判断要不要用这个技能，空的等于告诉它“别用”。',
        file,
        line: raw === undefined ? undefined : lineOf(raw, 'description:'),
        suggestion: '写一句具体的触发场景，例如“当需要审查 TypeScript 类型错误时使用”。',
      })
    } else if (description.length > config.maxDescriptionLength) {
      findings.push({
        rule: 'SD004',
        severity: 'warn',
        message: `简介有 ${description.length} 字，超过 ${config.maxDescriptionLength} 字上限，后面 ${description.length - config.maxDescriptionLength} 字模型看不到。`,
        file,
        line: raw === undefined ? undefined : lineOf(raw, 'description:'),
        suggestion: `把最关键的触发词挪到前 ${config.maxDescriptionLength} 字以内，细节移到正文。`, 
      })
    } else if (description.length < 20) {
      findings.push({
        rule: 'SD005',
        severity: 'warn',
        message: `简介只有 ${description.length} 字，太笼统，模型很难判断什么时候该用。`,
        file,
        line: raw === undefined ? undefined : lineOf(raw, 'description:'),
        suggestion: '补上具体场景：解决什么问题、用户会怎么说。',
      })
    }
  }

  const body = parsed?.body ?? skill.content
  if (isEffectivelyEmpty(body)) {
    findings.push({
      rule: 'SD006',
      severity: 'error',
      message: '技能正文是空的，只有标题或分隔线；模型加载后没有任何可执行的指令。',
      file,
      line: parsed?.bodyLineOffset,
      suggestion: '在标题下写可执行的步骤、约束或示例。',
    })
  }

  if (parsed !== undefined && parsed.error === undefined) {
    const data = parsed.data
    for (const key of ['disable-model-invocation', 'user-invocable'] as const) {
      const value = data[key]
      if (value !== undefined && !isLenientBoolean(value)) {
        findings.push({
          rule: 'SD010',
          severity: 'warn',
          message: `开关 "${key}" 填的是 ${JSON.stringify(value)}，dsh 只认 true 或 false，所以这个值会被忽略。`,
          file,
          line: lineOf(raw ?? '', key),
          suggestion: '改成 true 或 false；也接受 1/0、yes/no、on/off。',
        })
      }
    }
    for (const legacy of ['disableModelInvocation', 'modelInvocable', 'userInvocable'] as const) {
      if (data[legacy] !== undefined) {
        findings.push({
          rule: 'SD010',
          severity: 'warn',
          message: `文件头里写的 ${legacy} 是旧写法，dsh 不认这个字段名，设了也不生效。`,
          file,
          line: lineOf(raw ?? '', legacy),
          suggestion: '改成带连字符的写法：disable-model-invocation / user-invocable。',
        })
      }
    }
  }

  return findings
}
