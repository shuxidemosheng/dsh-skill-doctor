/** 正文 token 预算检查。 */
import type { ResolvedConfig } from '../../config.js'
import type { Finding, SkillInput } from '../../types.js'
import { estimateTokens } from '../text.js'

/** 估算正文 token；超过预算时给 warn。 */
export function checkBudget(skill: SkillInput, config: ResolvedConfig): Finding[] {
  const tokens = estimateTokens(skill.content)
  if (tokens <= config.maxBodyTokens) return []
  return [{
    rule: 'SD007',
    severity: 'warn',
    message: `正文估算约 ${tokens} tokens，超过预算 ${config.maxBodyTokens}；模型一旦用上这个技能，这些内容会整段塞进上下文，挤掉别的信息。`,
    file: skill.path,
    suggestion: '把长参考资料挪到 references/ 里让模型按需读取，或者把技能拆成几个小的。',
  }]
}
