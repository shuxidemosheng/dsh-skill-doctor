/** skill_explain：解释一个技能为什么出现/没出现、为什么没被模型选中。 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import type { ResolvedConfig } from '../config.js'
import { scanRoots } from '../scanner/fs-scan.js'
import { estimateTokens } from '../scanner/text.js'
import { renderExplainJson, renderExplainMarkdown } from './report.js'
import type { ExplainInfo } from './report.js'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * 组装 skill_explain 工具。
 * @param ctx - 插件上下文（skills / workingDirectory）。
 * @param config - 解析后的插件配置。
 */
export function buildExplainTool(ctx: Context, config: ResolvedConfig): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'skill_explain',
    description: 'Explain one skill: which provider/source/path won, whether it is model- and user-invocable, its description length and body token estimate, whether ctx.skills.get can actually load it, and the likely reason it is missing or ignored. '
      + 'Use it when a skill does not appear in the available-skills catalog, does not respond to /name, or seems shadowed by another provider.',
    parameters: {
      name: { type: 'string', required: true, description: 'Exact skill name to explain.' },
      extraRoots: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional roots to scan for same-name candidates (supports ~).',
      },
      format: {
        type: 'string',
        enum: ['markdown', 'json'],
        description: 'Output format; defaults to markdown.',
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
      const lookup = {
        ...cwd === undefined ? {} : { cwd },
        ...exec.agent === undefined ? {} : { scope: exec.agent as never },
        signal: exec.signal,
      }
      const snapshot = await ctx.skills.snapshot(lookup)
      const summary = snapshot.skills.find(skill => skill.name === args.name)

      const roots = [...config.extraRoots, ...(args.extraRoots ?? [])]
      const candidates = roots.length === 0
        ? []
        : (await scanRoots(roots, config.maxFileBytes)).skills
          .filter(skill => skill.name === args.name)
          .map(skill => skill.path ?? `${skill.provider}:${skill.name}`)

      if (summary === undefined) {
        const notes = [
          '技能不在当前 registry 视图中，可能原因：cwd 不对、provider 发现失败、frontmatter 解析失败、或名字不合法。',
          '用 skill_lint 检查同名文件，或确认 extraRoots 是否指向正确的技能目录。',
        ]
        const info: ExplainInfo = {
          name: args.name,
          found: false,
          notes,
          ...candidates.length === 0 ? {} : { sameNameCandidates: candidates },
        }
        return args.format === 'json' ? renderExplainJson(info) : renderExplainMarkdown(info)
      }

      let definition: SkillDefinition | undefined
      let loadError: string | undefined
      try {
        definition = await ctx.skills.get(args.name, lookup)
      } catch (error) {
        loadError = error instanceof Error ? error.message : String(error)
      }

      const body = definition?.content ?? ''
      const bodyTokens = estimateTokens(body)
      const notes: string[] = []
      if (!summary.invocation.modelInvocable) {
        notes.push('disable-model-invocation=true：不会出现在模型技能目录，模型不会自动选择它。')
      }
      if (!summary.invocation.userInvocable) {
        notes.push('user-invocable=false：不会出现在 /命令 列表。')
      }
      if (summary.description.length > config.maxDescriptionLength) {
        notes.push(`description 长度 ${summary.description.length} 超过上限 ${config.maxDescriptionLength}，目录渲染会截断。`)
      }
      if (bodyTokens > config.maxBodyTokens) {
        notes.push(`正文估算 ${bodyTokens} tokens，超过预算 ${config.maxBodyTokens}。`)
      }
      if (summary.path === undefined) {
        notes.push('虚拟技能（provider 未提供文件路径），只能做逻辑检查，无法做文件级 lint。')
      }
      if (!SKILL_NAME.test(summary.name)) {
        notes.push('名字不是 kebab-case，provider 可能在发现阶段拒绝或需要 slug 化。')
      }
      if (definition === undefined) {
        notes.push(loadError === undefined
          ? 'registry 列出了它，但 ctx.skills.get 返回 undefined；provider 可能已失效或候选已被替换。'
          : `registry 列出了它，但加载失败：${loadError}`)
      }

      const metadataKeys = definition?.metadata === undefined ? [] : Object.keys(definition.metadata)
      const info: ExplainInfo = {
        name: summary.name,
        found: true,
        provider: summary.provider,
        source: summary.source,
        ...summary.path === undefined ? {} : { path: summary.path },
        modelInvocable: summary.invocation.modelInvocable,
        userInvocable: summary.invocation.userInvocable,
        descriptionLength: summary.description.length,
        descriptionPreview: summary.description.slice(0, 200),
        ...summary.whenToUse === undefined ? {} : { whenToUse: summary.whenToUse },
        bodyChars: body.length,
        bodyTokens,
        loaded: definition !== undefined,
        ...summary.resourceBase === undefined ? {} : { resourceBaseKind: summary.resourceBase.kind },
        metadataKeys,
        notes,
        ...candidates.length === 0 ? {} : { sameNameCandidates: candidates },
      }
      return args.format === 'json' ? renderExplainJson(info) : renderExplainMarkdown(info)
    },
  })
}
