/**
 * dsh-skill-doctor —— 插件页安装门禁（独立的组件行）。
 *
 * 这是 cordis.patch.yml 第三行 `id: skill-doctor-gate` 对应的模块入口，只做一件事：
 * 包装 plugin-manager 服务上的 `installBundle`，在写入 profile 之前审一遍 tarball。
 * 四个体检工具与斜杠命令在 src/index.ts（第一行），外部技能来源在
 * src/compat-entry.ts（第二行），三行在插件页上各有独立开关。
 *
 * 为什么拆成独立一行：
 * 门禁的价值是拦住误装，但它同时会挡住「明知有风险、仍要装」的场景。
 * 拆成独立组件后，遇到这种情况在插件页把它关掉即可安装，装完再打开——
 * 不需要改配置文件、不需要重启、也不必卸载整个插件。
 *
 * 关闭即放行，靠的是 registerInstallGate 内部用 `ctx.effect` 注册的还原函数：
 * 行被关掉时该 fiber 卸载，effect 执行，`installBundle` 立刻恢复成原方法。
 *
 * 纪律（与 src/index.ts、src/compat-entry.ts 一致）：
 * - 绝不 export default（Loader 的 unwrapExports 会折叠模块并丢掉 inject）；
 * - 不把 `pluginManager` 写进 inject —— 它是宿主内部服务，硬注入会让 CLI 与
 *   老版本 dsh 上整行加载失败。registerInstallGate 内部用 `ctx.get(name, false)`
 *   软探测，探测不到就只记一行 info；
 * - apply 内绝不让异常冒出去：门禁装不上不该影响任何其它组件行。
 */
import type { Context } from '@deepseek-ai/cordis'
import { registerInstallGate } from './plugins/gate.js'

/** Cordis 模块名。与 patch 里的 id 保持一致，便于在宿主日志里定位。 */
export const name = 'skill-doctor-gate'

/**
 * 依赖 `pluginManager` 服务。
 *
 * **这一条不能省。** 没有 inject 声明时，fiber 不等任何依赖，apply 会在
 * `plugin-manager` 注册之前就跑完——它自身 `inject = ['loader', 'profileContext']`，
 * 注册得比绝大多数插件晚。此时 `ctx.get('pluginManager', false)` 返回 undefined
 * （cordis 的 get 在 store 里没有该 key 时就是 undefined），门禁走静默降级分支，
 * 结果是插件页安装完全不受约束，而且日志里只有一行 info，看起来像「已启用」。
 *
 * 0.18.0 就是这个状态：代码、patch、组件行都对，但门禁在真实环境里从未生效。
 * 排查记录：apply 时 `manager typeof=undefined`，加上 inject 后变成 `object`
 * 且 `wrapped installBundle ok` 紧接着出现。
 *
 * 声明 inject 后 cordis 会等服务就绪再 apply，服务卸载时也会正确 dispose，
 * 恰好是门禁想要的语义。代价是老版本 dsh 若没有该服务名，这一行不加载——
 * 但门禁本来就是独立组件行，失效只影响它自己，不牵连体检那两行。
 */
export const inject = ['pluginManager'] as const

/**
 * @param ctx - Cordis 上下文。没有 config —— 组件开关本身就是唯一的开关。
 */
export function apply(ctx: Context): void {
  try {
    registerInstallGate(ctx, 'block')
  } catch (error) {
    // 包装失败只降级：记一行 warn，绝不阻断这一行之外的任何东西。
    ctx.logger.warn(
      `skill-doctor-gate: install gate unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
