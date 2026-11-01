/** plugin_doctor：检查当前 profile 里已安装的插件之间有没有结构性冲突。 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from '../config.js'
import { renderPluginJson, renderPluginMarkdown } from '../plugins/report.js'
import { profileNameOf } from '../profile-name.js'
import { probeRuntime, summarizeRuntime } from '../plugins/runtime.js'
import { scanProfile } from '../plugins/scan.js'

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
      + 'Also use it for cross-layer symptoms: when skills suddenly disappear or shrink, a plugin patch may have changed the skill catalogue config — the consultation section lists every bundle touchpoint on the skill chain. '
      + 'It only reads profile files and runtime state; it never changes, enables or loads a plugin. Two things it cannot tell you: which plugin registered a given tool name (the registry has no owner field), and why a plugin failed (the inventory projects the fiber phase but not the error). '
      + 'The tool result is already a complete Markdown report: reply with it verbatim (at most one short lead-in sentence); do not summarize or rebuild it as your own tables. Never paste it inside a code block.',
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
