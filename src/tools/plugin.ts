/** plugin_doctor：检查当前 profile 里已安装的插件之间有没有结构性冲突。 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from '../config.js'
import { renderPluginJson, renderPluginMarkdown } from '../plugins/report.js'
import { scanProfile } from '../plugins/scan.js'

/**
 * 从上下文里取当前 profile 名。
 *
 * dsh 用 `profileContext` 服务暴露 profile（见官方 profile 模板里的
 * `ctx.get('profileContext')?.name`）。拿不到就退回 desktop，并在报告里
 * 明确写了分析的是哪个 profile，避免看错对象。
 */
function profileNameOf(ctx: Context): string | undefined {
  const lookup = (ctx as unknown as { get?: (name: string) => unknown }).get
  if (typeof lookup !== 'function') return undefined
  const value = lookup.call(ctx, 'profileContext') as { name?: unknown } | undefined
  return typeof value?.name === 'string' ? value.name : undefined
}

/**
 * 组装 plugin_doctor 工具。
 * @param ctx - 插件上下文（只用来读 profile 名）。
 * @param _config - 解析后的配置；目前插件体检没有可调参数。
 */
export function buildPluginTool(ctx: Context, _config: ResolvedConfig): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'plugin_doctor',
    description: 'Check the installed DeepSeek Harness plugins in a profile for structural conflicts: the same loader entry inserted or patched by two plugins, a bundle listed twice, a dependency that is installed but not enabled, or an enabled bundle whose package is missing. '
      + 'Use it when a plugin\'s tool does not show up, when two plugins seem to fight over the same setting, or after installing several plugins. '
      + 'It only reads profile files; it never changes or loads a plugin. It cannot see runtime tool-name collisions, because the tool registry does not expose which plugin registered a name.',
    parameters: {
      profile: { type: 'string', description: 'Profile to inspect (defaults to the profile this session runs in).' },
      format: { type: 'string', enum: ['markdown', 'json'], description: 'Output format; defaults to markdown.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const profile = args.profile ?? profileNameOf(ctx) ?? 'desktop'
      const report = await scanProfile(profile)
      return args.format === 'json' ? renderPluginJson(report) : renderPluginMarkdown(report)
    },
  })
}
