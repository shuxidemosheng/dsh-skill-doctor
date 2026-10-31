/** 运行时技能收集：把 ctx.skills 的 snapshot/get 归一化成 SkillInput。 */
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'
import type { ResolvedConfig } from './config.js'
import type { SkillInput } from './types.js'
import { stem } from './scanner/text.js'

/** 运行时收集参数。 */
export interface CollectOptions {
  readonly cwd?: string
  readonly scope?: unknown
  readonly signal?: AbortSignal
  readonly config: ResolvedConfig
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
 * 收集当前视图内的技能。单个技能加载失败不会中断其他技能。
 * @param ctx - Cordis 上下文（需 skills 服务）。
 * @param options - cwd/scope/signal 与解析后的配置。
 */
export async function collectRuntimeSkills(ctx: Context, options: CollectOptions): Promise<SkillInput[]> {
  const lookup = {
    ...options.cwd === undefined ? {} : { cwd: options.cwd },
    ...options.scope === undefined ? {} : { scope: options.scope as never },
    ...options.signal === undefined ? {} : { signal: options.signal },
  }
  const snapshot = await ctx.skills.snapshot(lookup)
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
  return skills
}
