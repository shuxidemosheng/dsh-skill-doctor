/** 运行时技能收集：把 ctx.skills 的 snapshot/get 归一化成 SkillInput。 */
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'
import type { ResolvedConfig } from './config.js'
import type { SkillInput, WinnerInfo } from './types.js'
import { stem } from './scanner/text.js'

/**
 * 查 registry 视图时的参数。
 * 单独抽出来，是为了让「只取获胜者」的路径也能复用同一套 lookup，
 * 不至于在 roots / extraRoots 分支里手写一份不一样的 cwd/scope 组装。
 */
export interface LookupOptions {
  readonly cwd?: string
  readonly scope?: unknown
  readonly signal?: AbortSignal
}

/** 运行时收集参数。 */
export interface CollectOptions extends LookupOptions {
  readonly config: ResolvedConfig
}

/** 一次收集的结果：待查技能 + registry 判定的同名获胜者。 */
export interface RuntimeSnapshot {
  readonly skills: SkillInput[]
  /** key 是技能名；snapshot 已按名去重，所以里面的每一项天然就是获胜者。 */
  readonly winners: ReadonlyMap<string, WinnerInfo>
}

function directoryNameOf(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  return basename(path).toLowerCase() === 'skill.md' ? basename(dirname(path)) : stem(path)
}

async function readRaw(path: string | undefined, maxFileBytes: number): Promise<string | undefined> {
  if (path === undefined) return undefined
  try {
    if ((await stat(path)).size > maxFileBytes) return undefined
    return await readFile(path, 'utf8')
  } catch {
    // 远端/虚拟/不可读路径：跳过文件级检查，运行时逻辑检查仍可用。
    return undefined
  }
}

function toInput(
  summary: SkillSummary,
  definition: SkillDefinition | undefined,
  raw: string | undefined,
): SkillInput {
  return {
    name: summary.name,
    description: summary.description,
    ...summary.whenToUse === undefined ? {} : { whenToUse: summary.whenToUse },
    content: definition?.content ?? '',
    ...definition?.metadata === undefined ? {} : { metadata: definition.metadata },
    ...summary.path === undefined ? {} : { path: summary.path },
    provider: summary.provider,
    source: summary.source,
    invocation: summary.invocation,
    ...summary.resourceBase === undefined ? {} : { resourceBase: summary.resourceBase },
    ...raw === undefined ? {} : { raw },
    ...directoryNameOf(summary.path) === undefined ? {} : { directoryName: directoryNameOf(summary.path) },
  }
}

/**
 * 从一次 snapshot 里抽出「每个技能名对应的获胜者」。
 *
 * 为什么 snapshot 就能代表胜负：dsh 的 registry 在 collect 阶段按 rank 裁决
 * 同名候选，snapshot() 返回的 skills 已按名去重，剩下的就是当前真正生效的那份。
 * 因此不需要再调 ctx.skills.get()（那只是按名字取正文，不参与裁决）。
 *
 * `complete === false` 表示这次视图不完整（provider 还没就绪等），此时不能
 * 声称谁胜出，返回空 Map 让下游走「候选」措辞。
 */
function winnersFrom(summaries: readonly SkillSummary[], complete: boolean): Map<string, WinnerInfo> {
  const winners = new Map<string, WinnerInfo>()
  if (!complete) return winners
  for (const summary of summaries) {
    winners.set(summary.name, {
      name: summary.name,
      provider: summary.provider,
      source: summary.source,
      ...summary.path === undefined ? {} : { path: summary.path },
    })
  }
  return winners
}

/**
 * 收集当前视图内的技能，并同时带回获胜者信息。
 *
 * 这里刻意只调一次 snapshot：原来的 collectRuntimeSkills 本来就要调它拿技能，
 * 顺手在同一个返回值里带出 winners，避免为了「来源与遮蔽」再多一次 registry 往返。
 * winners 基于**未过滤**的 snapshot —— 胜负是 registry 视角，与本插件自己的
 * includeProviders / excludeProviders 报告过滤无关，过滤只影响本次展示哪些技能。
 *
 * 单个技能加载失败不会中断其他技能。
 * @param ctx - Cordis 上下文（需 skills 服务）。
 * @param options - cwd/scope/signal 与解析后的配置。
 */
export async function collectRuntimeSkillsWithWinners(
  ctx: Context,
  options: CollectOptions,
): Promise<RuntimeSnapshot> {
  // lookup 必须内联构造：写成返回 Record<string, unknown> 的辅助函数会丢掉
  // cwd/scope/signal 的精确类型，snapshot() 的参数是强类型的，过不了 tsc。
  const lookup = {
    ...options.cwd === undefined ? {} : { cwd: options.cwd },
    ...options.scope === undefined ? {} : { scope: options.scope as never },
    ...options.signal === undefined ? {} : { signal: options.signal },
  }
  const snapshot = await ctx.skills.snapshot(lookup)
  const winners = winnersFrom(snapshot.skills, snapshot.complete !== false)
  const skills: SkillInput[] = []
  for (const summary of snapshot.skills) {
    if (options.config.includeProviders.length > 0
      && !options.config.includeProviders.includes(summary.provider)) continue
    if (options.config.excludeProviders.includes(summary.provider)) continue

    let definition: SkillDefinition | undefined
    try {
      definition = await ctx.skills.get(summary.name, lookup)
    } catch {
      definition = undefined
    }
    const raw = await readRaw(summary.path, options.config.maxFileBytes)
    skills.push(toInput(summary, definition, raw))
  }
  return { skills, winners }
}

/**
 * 兼容原有调用点的薄包装：只要技能列表，不关心获胜者。
 * 保持返回 Promise<SkillInput[]>，所以既有调用方一行都不用改。
 */
export async function collectRuntimeSkills(ctx: Context, options: CollectOptions): Promise<SkillInput[]> {
  return (await collectRuntimeSkillsWithWinners(ctx, options)).skills
}

/**
 * 只取获胜者，不收集技能正文。
 *
 * 用于 roots / extraRoots 这类**直接扫文件**的路径：那里没有调用
 * collectRuntimeSkills，但同名遮蔽仍需要 registry 的裁决结果。
 * 失败一律降级为空 Map —— 拿不到 registry 视图时报告只能写「候选」，
 * 绝不能编造一个胜出者，也不能让快照探测失败拖垮整次体检。
 */
export async function collectWinners(ctx: Context, options: LookupOptions): Promise<Map<string, WinnerInfo>> {
  const lookup = {
    ...options.cwd === undefined ? {} : { cwd: options.cwd },
    ...options.scope === undefined ? {} : { scope: options.scope as never },
    ...options.signal === undefined ? {} : { signal: options.signal },
  }
  try {
    const snapshot = await ctx.skills.snapshot(lookup)
    return winnersFrom(snapshot.skills, snapshot.complete !== false)
  } catch {
    return new Map<string, WinnerInfo>()
  }
}
