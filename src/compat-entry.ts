/**
 * dsh-skill-doctor —— 外部技能来源挂载（独立的组件行）。
 *
 * 这是 cordis.patch.yml 第二行 `id: skill-doctor-compat` 对应的模块入口，
 * 只做一件事：把 Claude Code / Codex / ZCode 的技能目录注册成只读
 * SkillProvider。四个体检工具与斜杠命令在 src/index.ts（第一行），
 * 两行在插件页上各有独立开关，关掉其中一行不影响另一行。
 *
 * 为什么必须拆成两个模块入口：
 * dsh 的「组件行」= patch 里 `- insert:` 下的一个子项，每个子项按 name
 * 加载一个模块并调用它的 apply()。行开关作用于整行的 fiber（卸载/挂载）。
 * 如果把两类能力写在同一个 apply() 里，就只能一起开或一起关，插件页也
 * 只会显示一个组件。拆开后各自有生命周期，才能分别启停。
 *
 * 纪律（与 src/index.ts、上游 compat-plus 一致）：
 * - 绝不 export default（Loader 的 unwrapExports 会折叠模块并丢掉 inject）；
 * - apply() 内同步注册 provider，不做 IO —— 真正的文件扫描发生在 registry
 *   调用 provider.list() 时，由 registry 的 revision 缓存控制频率；
 * - 配置非法、全部来源关闭、provider 撞名都只 warn + return，
 *   绝不阻断会话创建（entry 激活失败会让整个会话创建失败）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { resolveCompatConfig } from './compat/config.js'
import { CompatSkillProvider } from './compat/provider.js'
import type { ConfigInput } from './compat/types.js'

/** Cordis 模块名。与 patch 里的 id 保持一致，便于在宿主日志里定位。 */
export const name = 'skill-doctor-compat'

/** 只需要技能注册表；不依赖 tools / workingDirectory。 */
export const inject = ['skills'] as const

/**
 * @param ctx - 携带 skills 服务的 Cordis 上下文。
 * @param config - 第二行 patch 的 config，直接是 sources / extraDirs /
 *                 slugifyNames 等键（不再嵌套 compat 键）。
 */
export function apply(ctx: Context, config: ConfigInput | undefined): void {
  let resolved
  try {
    // resolveCompatConfig 严格拒绝未知键与错误类型，错误向上抛后由这里降级。
    resolved = resolveCompatConfig(config)
  } catch (error) {
    ctx.logger.warn(
      `skill-doctor-compat disabled: invalid config: ${error instanceof Error ? error.message : String(error)}`,
    )
    return
  }

  // 全部来源关闭时不注册 provider：行本身可能仍是启用状态，但没有技能来源。
  if (!resolved.anySourceEnabled) {
    ctx.logger.warn('skill-doctor-compat disabled: every source is turned off and extraDirs is empty')
    return
  }

  try {
    const provider = new CompatSkillProvider(resolved, ctx.logger)
    // B 方案不带热更新，因此不需要 SkillProviderControl.invalidate()；
    // 改动 SKILL.md 后需要重启 dsh 才会重新发现（list() 结果被 registry 缓存）。
    ctx.skills.registerProvider(() => provider)
  } catch (error) {
    // 典型场景：同 profile 里还启用着 dsh-skill-compat-plus，provider 撞名。
    ctx.logger.warn(
      `skill-doctor-compat not registered: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
