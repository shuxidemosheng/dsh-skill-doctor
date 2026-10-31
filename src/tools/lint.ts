/** skill_lint：在当前会话视图内检查技能。 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { ResolvedConfig } from '../config.js'
import { withRuleFilter } from '../config.js'
import { scanRoots } from '../scanner/fs-scan.js'
import { lintSkills } from '../scanner/scan.js'
import { collectRuntimeSkills } from '../runtime.js'
import { renderLintJson, renderLintMarkdown } from './report.js'

/**
 * 组装 skill_lint 工具。
 * @param ctx - 插件上下文（skills / workingDirectory）。
 * @param config - 解析后的插件配置。
 */
export function buildLintTool(ctx: Context, config: ResolvedConfig): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'skill_lint',
    description: 'Lint DeepSeek Harness skills visible to this session: frontmatter, kebab-case name, description length, body token budget, missing resource references, invalid invocation booleans, shadowed duplicate names, and heuristic risky-instruction patterns. '
      + 'Use it before trusting a third-party skill, after editing a SKILL.md, or when a skill seems not to work. '
      + 'It only reads files; it never changes or executes a skill.',
    parameters: {
      name: { type: 'string', description: 'Lint one skill by exact name; omit to lint every visible skill.' },
      provider: { type: 'string', description: 'Only lint skills from this provider.' },
      rules: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only run these rule ids (e.g. ["SD003","SD004"]); omit to run every enabled rule.',
      },
      severity: {
        type: 'string',
        enum: ['info', 'warn', 'error'],
        description: 'Minimum severity to report; defaults to the plugin config (info).',
      },
      extraRoots: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional skill roots to scan for duplicate/shadowed names (supports ~).',
      },
      format: {
        type: 'string',
        enum: ['markdown', 'json'],
        description: 'Report format; defaults to markdown.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const cwd = exec.agent === undefined
        ? undefined
        : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const skills = await collectRuntimeSkills(ctx, {
        ...cwd === undefined ? {} : { cwd },
        ...exec.agent === undefined ? {} : { scope: exec.agent },
        signal: exec.signal,
        config,
      })
      if (args.extraRoots !== undefined && args.extraRoots.length > 0) {
        const extra = await scanRoots(args.extraRoots, config.maxFileBytes)
        skills.push(...extra.skills)
      }

      const filtered = skills.filter(skill =>
        (args.name === undefined || skill.name === args.name)
        && (args.provider === undefined || skill.provider === args.provider))
      if (args.name !== undefined && filtered.length === 0) {
        return `skill_lint: no skill named "${args.name}" in the current view. Try skill_explain for a diagnosis, or pass extraRoots.`
      }

      const result = await lintSkills(filtered, withRuleFilter(config, args.rules, args.severity))
      // skill_lint 是逐条规则的 verbose / CI 模式：规则 ID 直接前置，方便对照配置和基线。
      const reportOptions = { maxDescriptionLength: config.maxDescriptionLength, style: 'technical' as const }
      return args.format === 'json'
        ? renderLintJson(result, reportOptions)
        : renderLintMarkdown(result, reportOptions)
    },
  })
}
