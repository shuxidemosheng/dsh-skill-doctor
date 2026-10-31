/** plugin_doctor：检查当前 profile 里已安装的插件之间有没有结构性冲突。 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from '../config.js'
import { renderPluginJson, renderPluginMarkdown } from '../plugins/report.js'
import { probeRuntime, summarizeRuntime } from '../plugins/runtime.js'
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
    description: 'Check the installed DeepSeek Harness plugins in a profile, on disk and at runtime: structural conflicts (the same loader entry inserted or patched by two plugins, a bundle listed twice, a dependency installed but not enabled, an enabled bundle whose package is missing) plus whether each bundle actually started (a bundle whose fiber phase is failed never provides its tools). '
      + 'Use it when a plugin\'s tool does not show up, when two plugins seem to fight over the same setting, or after installing several plugins. '
      + 'It only reads profile files and runtime state; it never changes, enables or loads a plugin. Two things it cannot tell you: which plugin registered a given tool name (the registry has no owner field), and why a plugin failed (the inventory projects the fiber phase but not the error). '
      + 'The report is Markdown: show it to the user as Markdown, never inside a code block.',
    parameters: {
      profile: { type: 'string', description: 'Profile to inspect (defaults to the profile this session runs in).' },
      format: { type: 'string', enum: ['markdown', 'json'], description: 'Output format; defaults to markdown.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const profile = args.profile ?? profileNameOf(ctx) ?? 'desktop'
      // 两件事互不依赖：磁盘扫描是本地 IO，运行时探测可能要跨进程。
      // 并行跑，且探测在任何失败情况下都只降级、不抛错。
      const [report, snapshot] = await Promise.all([
        scanProfile(profile),
        probeRuntime(ctx, exec),
      ])
      const runtime = summarizeRuntime(snapshot, report.bundles)
      return args.format === 'json'
        ? renderPluginJson(report, runtime)
        : renderPluginMarkdown(report, runtime)
    },
  })
}
