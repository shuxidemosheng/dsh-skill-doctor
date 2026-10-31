/**
 * dsh-skill-doctor —— 技能体检。
 *
 * 模型工具：
 *   skill_doctor  —— 技能体检（结论优先）
 *   skill_lint    —— 静态 lint（frontmatter/name/description/体积/引用/遮蔽/可疑指令）
 *   skill_explain —— 解释一个技能为什么没出现、没被模型选中、或加载失败
 *   plugin_doctor —— 已安装插件之间的结构性冲突（抢同一条目、重复安装、装了没启用）
 *
 * CLI：`dsh-skill-lint`，给技能作者和 CI 用。
 *
 * 纪律：
 *  - 绝不 export default（Loader 的 unwrapExports 会折叠模块并丢掉 inject）；
 *  - apply() 内不做 IO；配置非法时 warn + return，绝不阻断会话创建；
 *  - 工具名撞车时先查 ctx.tools.get，确定性让位；
 *  - 只读技能文件，不执行技能里的脚本，不修改任何文件。
 *
 * @module dsh-skill-doctor
 */
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from './config.js'
import type { Config } from './config.js'
import { buildDoctorTool } from './tools/doctor.js'
import { buildExplainTool } from './tools/explain.js'
import { buildLintTool } from './tools/lint.js'
import { buildPluginTool } from './tools/plugin.js'
import { TOOL_NAMES } from './tool-names.js'

export const name = 'skill-doctor'

/** 宿主服务依赖：工具注册、技能注册表、会话工作目录。 */
export const inject = ['tools', 'skills', 'workingDirectory'] as const

/** 本插件注册的工具名（与 tools 数组顺序一致）；定义在 tool-names.ts，供运行时体检复用。 */

/**
 * 注册技能体检工具。
 * @param ctx - 携带 tools / skills / workingDirectory 的 Cordis 上下文。
 * @param config - patch 行里的 config。
 */
export function apply(ctx: Context, config: Config | undefined): void {
  let resolved
  try {
    resolved = resolveConfig(config)
  } catch (error) {
    ctx.logger.warn(
      `skill-doctor disabled: invalid config: ${error instanceof Error ? error.message : String(error)}`,
    )
    return
  }

  const tools = [
    buildDoctorTool(ctx, resolved),
    buildLintTool(ctx, resolved),
    buildExplainTool(ctx, resolved),
    buildPluginTool(ctx, resolved),
  ]
  for (const [index, tool] of tools.entries()) {
    const toolName = TOOL_NAMES[index]!
    if (ctx.tools.get(toolName) !== undefined) {
      ctx.logger.warn(`skill-doctor: tool "${toolName}" is already registered — skipping it`)
      continue
    }
    ctx.tools.register(tool)
  }
}
