/**
 * 从上下文里取当前 profile 名（skill_doctor 与 plugin_doctor 共用）。
 *
 * dsh 用 `profileContext` 服务暴露 profile（见官方 profile 模板里的
 * `ctx.get('profileContext')?.name`）。拿不到返回 undefined，由调用方决定
 * 降级方式（plugin_doctor 退回 desktop；病历文件名退回 default）。
 */
import type { Context } from '@deepseek-ai/cordis'

export function profileNameOf(ctx: Context): string | undefined {
  const lookup = (ctx as unknown as { get?: (name: string) => unknown }).get
  if (typeof lookup !== 'function') return undefined
  const value = lookup.call(ctx, 'profileContext') as { name?: unknown } | undefined
  return typeof value?.name === 'string' ? value.name : undefined
}
