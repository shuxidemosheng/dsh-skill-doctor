/**
 * 宿主侧斜杠命令：`/doctor`、`/scope`、`/followup`、`/rewrite`。
 *
 * 为什么需要它：客户端面板只能往输入框塞纯文本，做不出那种"蓝色命令 chip"——
 * 那需要 `conversation` 服务（第三方拿不到，硬声明会让整块面板不加载）。
 * 而 dsh 的命令系统是**宿主侧**的公开扩展点（官方 `/goal`、`/compact` 都这么做），
 * 注册后用户输入 `/` 就能在列表里看到，选中即成为原生命令节点（蓝色 chip），
 * 后面继续写参数即可——正是想要的交互。
 *
 * 命令 handler 直接在宿主执行诊断并把结果作为会话流里的一个节点输出，
 * **不经过模型**：省一轮往返，也不会因为模型改写而丢章节。
 *
 * 注册是"尽力而为"：服务探测不到、或名字被占用，只记一条 warn，
 * 绝不让插件加载失败（工具必须照常可用）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from './config.js'
import {
  buildBaseline,
  currentMetaOf,
  diffBaseline,
  loadBaseline,
  recordPathOf,
  saveBaseline,
  type BaselineDiff,
} from './baseline.js'
import { clusterFindings } from './clusters.js'
import { profileNameOf } from './profile-name.js'
import { collectRuntimeSkills } from './runtime.js'
import { scanRoots } from './scanner/fs-scan.js'
import { scanProfile } from './plugins/scan.js'
import { lintSkills } from './scanner/scan.js'
import { analyzeTruncation, extractTriggers, triggerLabel } from './tools/report.js'
import { renderRewriteWorksheet } from './tools/rewrite.js'
import type { SkillLintResult } from './types.js'

/** 一条命令的静态描述。 */
export interface CommandSpec {
  /** 命令名，必须匹配 `/^[a-z][a-z0-9_-]*$/`（宿主校验，中文名会被拒）。 */
  readonly name: string
  /** 命令列表里显示的一句话。 */
  readonly description: string
  /** 输入提示（选中命令后输入框里的占位符）。 */
  readonly hint: string
  /** 执行体：返回可直接展示的纯文本。 */
  readonly run: (input: string) => Promise<string>
}

/** 体检结果的分档。 */
type Tier = 'broken' | 'high' | 'low' | 'info' | 'ok'

/**
 * 判断一个技能落在哪一档。
 *
 * 分档只为"先看什么"服务，所以取最严重的那一档：有错误就是坏，其次看
 * 简介被截断后有没有丢触发说法（影响大），再看只是截断（影响小）。
 */
function tierOf(result: SkillLintResult, limit: number): Tier {
  if (result.errors > 0) return 'broken'
  const truncation = analyzeTruncation(result.skill.description, limit)
  if (truncation.level === 'high') return 'high'
  if (truncation.level === 'low') return 'low'
  if (result.infos > 0) return 'info'
  return 'ok'
}

/**
 * 纯文本体检摘要。
 *
 * 命令的输出是会话流里的一个节点，不渲染 Markdown 表格，所以这里刻意用
 * 缩进列表而不是表格——按纯文本也能读。完整版（含逐条处方）仍在会话里
 * 让模型跑 `skill_doctor` 拿。
 * @param results - 全部技能结果。
 * @param limit - 简介长度上限。
 * @param scopedTo - 用户点名的范围；给了就在标题里说明，避免误读成全量。
 */
export function plainCheckup(
  results: readonly SkillLintResult[],
  limit: number,
  scopedTo?: readonly string[],
  heading = '技能体检',
): string {
  if (results.length === 0) {
    return scopedTo === undefined || scopedTo.length === 0
      ? '没有找到技能。确认工作目录，或换个目录再试。'
      : `在指定范围里没有找到技能：${scopedTo.join('、')}`
  }

  const tiers: Record<Tier, number> = { broken: 0, high: 0, low: 0, info: 0, ok: 0 }
  for (const result of results) tiers[tierOf(result, limit)] += 1

  const lines: string[] = []
  const scope = scopedTo === undefined || scopedTo.length === 0 ? '' : `（只查 ${scopedTo.join('、')}）`
  lines.push(`${heading} · ${results.length} 个技能${scope}`)
  lines.push(
    `⛔ 用不了 ${tiers.broken} · ⚠️ 影响大 ${tiers.high} · 💡 影响小 ${tiers.low}`
    + ` · 💡 其他 ${tiers.info} · ✅ 正常 ${tiers.ok}`,
  )

  // 共性问题优先：13 个同名技能命中同一条规则，是一个根因不是 13 个问题。
  const clusters = clusterFindings(results)
  if (clusters.length > 0) {
    lines.push('', '共性问题（先改这里最划算）')
    for (const cluster of clusters.slice(0, 3)) {
      const prefix = cluster.commonPrefix === undefined ? '' : `；名字都以 ${cluster.commonPrefix}- 开头，多半同一套模板`
      lines.push(`· ${cluster.plainTitle}：${cluster.count} 个（占 ${Math.round(cluster.share * 100)}%）${prefix}`)
    }
  }

  // 影响大的逐个点名，附"被切掉的触发说法"——这是模型不选它的直接原因。
  const urgent = results
    .filter(result => tierOf(result, limit) === 'high')
    .sort((a, b) => b.skill.description.length - a.skill.description.length)
  if (urgent.length > 0) {
    lines.push('', `模型看不到部分触发说法（${urgent.length} 个）`)
    for (const result of urgent.slice(0, 6)) {
      const truncation = analyzeTruncation(result.skill.description, limit)
      const triggers = truncation.newTriggers
        .map(trigger => triggerLabel(trigger, 30))
        .filter(label => label.length > 0)
        .slice(0, 3)
      const detail = triggers.length === 0 ? '被切掉的部分里疑似有触发说法' : `被切掉：${triggers.join('、')}`
      lines.push(`· ${result.skill.name}（${result.skill.description.length} 字）${detail}`)
    }
    if (urgent.length > 6) lines.push(`· …还有 ${urgent.length - 6} 个`)
  }

  if (tiers.broken > 0) {
    lines.push('', '用不了的（先修这些）')
    for (const result of results.filter(item => item.errors > 0).slice(0, 5)) {
      lines.push(`· ${result.skill.name}：${result.findings.filter(f => f.severity === 'error').map(f => f.message).slice(0, 2).join('；')}`)
    }
  }

  lines.push('', '需要带处方的完整报告：在会话里说「体检技能」；想直接改简介：/rewrite <技能名>')
  return lines.join('\n')
}

/**
 * 纯文本复诊对比。
 * @param diff - 差值结果。
 * @param label - 上次病历的展示标签（文件名 + 存档日）。
 */
export function plainFollowUp(diff: BaselineDiff, label: string): string {
  const lines = [`技能复诊 · 对照上次（${label}）`]
  const describe = (delta: { plainTitle: string; before: number; after: number }): string =>
    `${delta.plainTitle} ${delta.before} → ${delta.after}`

  if (diff.improved.length > 0) lines.push(`✅ 好转：${diff.improved.map(describe).join('；')}`)
  if (diff.regressed.length > 0) {
    const named = diff.regressed
      .map(delta => {
        const skills = diff.regressedSkills[delta.rule] ?? []
        return skills.length === 0 ? describe(delta) : `${describe(delta)}（${skills.join('、')}）`
      })
      .join('；')
    lines.push(`⚠️ 变差：${named}`)
  }
  if (diff.unchanged.length > 0) lines.push(`⏸ 还没动：${diff.unchanged.map(describe).join('；')}`)
  if (diff.newSkills.length > 0) lines.push(`🆕 新扫到：${diff.newSkills.slice(0, 8).join('、')}`)
  if (diff.goneSkills.length > 0) lines.push(`🗑 不见了：${diff.goneSkills.slice(0, 8).join('、')}`)

  lines.push('', `整体：问题总数 ${diff.totalBefore} → ${diff.totalAfter}。`)
  if (diff.metaWarning !== undefined) lines.push(`注意：${diff.metaWarning}`)
  return lines.join('\n')
}

/** 命令名 → 输入提示；`<...>` 部分由用户补齐。 */
const COMMAND_META = {
  doctor: { description: '体检所有技能', hint: '[目录，留空=全部]' },
  scope: { description: '只体检一个目录', hint: '<目录或 SKILL.md 路径>' },
  rewrite: { description: '简介改写工单', hint: '<技能名>' },
  followup: { description: '和上次体检对比', hint: '[目录，留空=全部]' },
  why: { description: '查某个技能为什么没被选中', hint: '<技能名>' },
  clash: { description: '查插件有没有改坏技能配置', hint: '[profile 名]' },
} as const

/**
 * 组装四条命令。
 *
 * 每次执行都重新采集技能（不缓存）：技能文件随时会被编辑，
 * 命令输出的价值就在于"此刻"的状态。
 */
export function buildCommands(ctx: Context, config: ResolvedConfig): CommandSpec[] {
  const limit = config.maxDescriptionLength

  /** 采集技能：给了范围就走磁盘，否则用会话可见技能。 */
  const collect = async (input: string): Promise<{ results: SkillLintResult[]; scopedTo?: string[] }> => {
    const roots = input.trim().length === 0 ? [] : [input.trim()]
    const skills = roots.length > 0
      ? (await scanRoots(roots, config.maxFileBytes)).skills
      : await collectRuntimeSkills(ctx, { config })
    const result = await lintSkills(skills, config)
    return roots.length > 0 ? { results: [...result.results], scopedTo: roots } : { results: [...result.results] }
  }

  return [
    {
      name: 'doctor',
      ...COMMAND_META.doctor,
      run: async input => {
        const { results, scopedTo } = await collect(input)
        return plainCheckup(results, limit, scopedTo)
      },
    },
    {
      name: 'scope',
      ...COMMAND_META.scope,
      run: async input => {
        const target = input.trim()
        if (target.length === 0) return '用法：/scope <目录或 SKILL.md 路径>\n例：/scope D:\\AIcoding\\test-skills'
        const scanned = await scanRoots([target], config.maxFileBytes)
        if (scanned.skills.length === 0) {
          const why = scanned.issues.length === 0 ? '' : `\n扫描提示：${scanned.issues.join('；')}`
          return `在 ${target} 里没找到技能（每个技能要自己的 SKILL.md）。${why}`
        }
        const result = await lintSkills(scanned.skills, config)
        return plainCheckup(result.results, limit, [target])
      },
    },
    {
      name: 'followup',
      ...COMMAND_META.followup,
      run: async input => {
        const path = recordPathOf(config.baseline, profileNameOf(ctx))
        if (path === undefined) return '病历功能已关闭（配置 baseline: off），复诊需要它开着。'
        const { results } = await collect(input)
        const result = { results, errors: 0, warnings: 0, infos: 0, ok: true }
        const previous = await loadBaseline(path)
        const meta = currentMetaOf(config)
        if (previous === undefined) {
          await saveBaseline(path, buildBaseline(result, meta))
          return `这是第一次记录病历（${path}）。\n从下次复诊开始，这里会显示和这次的差值。`
        }
        const diff = diffBaseline(previous, result, meta)
        // 先算差值再写回：顺序反了就成了"和自己比"。
        await saveBaseline(path, buildBaseline(result, meta))
        return `${plainFollowUp(diff, `${path.split(/[\\/]/).pop() ?? path}（${previous.savedAt.slice(0, 10)} 存档）`)}\n\n本次结果已存为新病历。`
      },
    },
    {
      name: 'rewrite',
      ...COMMAND_META.rewrite,
      run: async input => {
        const name = input.trim()
        if (name.length === 0) return '用法：/rewrite <技能名>\n例：/rewrite nature-alpha'
        const skills = await collectRuntimeSkills(ctx, { config })
        const target = skills.find(skill => skill.name === name)
        if (target === undefined) {
          const near = skills.map(skill => skill.name).filter(candidate => candidate.includes(name)).slice(0, 5)
          return `没找到技能 ${name}。${near.length === 0 ? '' : `\n相近的：${near.join('、')}`}`
        }
        if (target.description.length <= limit) {
          return `${name} 的简介 ${target.description.length} 字，没有超过 ${limit} 字上限，不需要改写。`
        }
        const linted = await lintSkills([target], config)
        const worksheet = renderRewriteWorksheet(linted.results[0]!, limit)
        return `${worksheet.join('\n')}\n\n写好后用 skill_doctor 工具写入（需要你确认草稿）。`
      },
    },
    {
      name: 'why',
      ...COMMAND_META.why,
      run: async input => {
        const name = input.trim()
        if (name.length === 0) return '用法：/why <技能名>\n例：/why nature-citation'
        const skills = await collectRuntimeSkills(ctx, { config })
        const target = skills.find(skill => skill.name === name)
        if (target === undefined) {
          const near = skills.map(skill => skill.name).filter(candidate => candidate.includes(name)).slice(0, 5)
          return `没找到技能 ${name}。${near.length === 0 ? '' : `\n相近的：${near.join('、')}`}`
        }
        const single = await lintSkills([target], config)
        return plainCheckup(single.results, limit, undefined, `技能诊断 · ${name}`)
      },
    },
    {
      name: 'clash',
      ...COMMAND_META.clash,
      run: async input => {
        const profile = input.trim().length === 0 ? profileNameOf(ctx) ?? 'desktop' : input.trim()
        const report = await scanProfile(profile)
        const lines = [`插件检查 · profile ${profile}`]
        if (report.conflicts.length === 0) {
          lines.push('没有发现冲突。', '（技能目录被插件改掉这类问题看 /doctor；这里只查插件之间的结构性冲突。）')
        } else {
          for (const conflict of report.conflicts.slice(0, 8)) {
            lines.push(`· [${conflict.severity}] ${conflict.title}`, `  ${conflict.detail}`)
          }
          if (report.conflicts.length > 8) lines.push(`· …还有 ${report.conflicts.length - 8} 条`)
        }
        if (report.notes.length > 0) lines.push('', `读不到的东西：${report.notes.slice(0, 3).join('；')}`)
        return lines.join('\n')
      },
    }
  ]
}

/** 命令注册表的最小形状；只用到 register。 */
interface CommandRegistry {
  register?: (definition: unknown) => unknown
}

/**
 * 尽力注册命令。
 *
 * 探测用 `ctx.get(name, false)`：第二个参数关掉"必须已注入"的检查，
 * 因此**不需要**把 `commands` 写进 inject——写进去的话，万一该服务缺失，
 * 整个插件（含四个工具）都不会加载，代价太大。
 * @param ctx - 插件上下文。
 * @param config - 解析后的配置。
 */
export function registerCommands(ctx: Context, config: ResolvedConfig): void {
  const lookup = (ctx as unknown as { get?: (name: string, strict?: boolean) => unknown }).get
  let registry: CommandRegistry | undefined
  try {
    registry = typeof lookup === 'function'
      ? lookup.call(ctx, 'commands', false) as CommandRegistry | undefined
      : undefined
  } catch {
    registry = undefined
  }
  if (registry === undefined || typeof registry.register !== 'function') {
    // 不 warn 成错误：老版本 dsh 可能没有命令服务，插件其余部分照常工作。
    ctx.logger.info('skill-doctor: command service not available — slash commands skipped')
    return
  }

  for (const spec of buildCommands(ctx, config)) {
    try {
      registry.register({
        name: spec.name,
        description: spec.description,
        input: { hint: spec.hint },
        handler: async (invocation: { rawInput?: unknown }) => {
          const input = typeof invocation.rawInput === 'string' ? invocation.rawInput : ''
          try {
            return { kind: 'success', text: await spec.run(input) }
          } catch (error) {
            return { kind: 'error', text: `/${spec.name} 执行失败：${error instanceof Error ? error.message : String(error)}` }
          }
        },
      })
    } catch (error) {
      // 名字被别的插件占用等：跳过这一条，不影响其他命令与工具。
      ctx.logger.warn(`skill-doctor: cannot register /${spec.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** 供测试用：命令名清单。 */
export const COMMAND_NAMES = ['doctor', 'scope', 'followup', 'rewrite', 'why', 'clash'] as const
