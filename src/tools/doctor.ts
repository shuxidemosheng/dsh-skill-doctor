/** skill_doctor：结论优先的单技能诊断 / 多技能体检。 */
import { basename } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-working-directory'
import {
  autoRecordPath,
  buildBaseline,
  currentMetaOf,
  diffBaseline,
  expandHome,
  loadBaseline,
  saveBaseline,
  type BaselineDiff,
} from '../baseline.js'
import type { ResolvedConfig } from '../config.js'
import { profileNameOf } from '../profile-name.js'
import { collectRuntimeSkills } from '../runtime.js'
import { scanRoots } from '../scanner/fs-scan.js'
import { duplicateFindingsBySkill } from '../scanner/checks/duplicates.js'
import { filterSkills, lintSkill, lintSkills } from '../scanner/scan.js'
import { readDshVersion } from '../version-check.js'
import { renderRewriteBatch, renderRewriteWorksheet } from './rewrite.js'
import { renderDoctorMarkdown, renderLintJson, renderLintMarkdown, type ReportOptions } from './report.js'

/** 病历路径的解析：`auto` 用 profile 专属的默认路径，其余按用户给的路径展开。 */
function recordPathOf(config: ResolvedConfig, ctx: Context): string | undefined {
  if (config.baseline === undefined) return undefined
  return config.baseline === 'auto'
    ? autoRecordPath(profileNameOf(ctx) ?? 'default')
    : expandHome(config.baseline)
}

/**
 * 病历读侧：读旧病历并算出复诊差值；任何失败都降级为「没有对比」，不影响体检本身。
 * @returns diff 与展示标签；配了病历但读不到时返回 missing 提示。
 */
async function followUp(
  config: ResolvedConfig,
  path: string,
  result: Awaited<ReturnType<typeof lintSkills>>,
): Promise<{ diff?: BaselineDiff; label?: string; missing?: string; firstRecord?: boolean }> {
  const baseline = await loadBaseline(path)
  // auto 模式下第一次跑没有旧病历：不是异常，是"第一次建档"，渲染时要说明白。
  if (baseline === undefined) {
    return config.baseline === 'auto' ? { firstRecord: true } : { missing: path }
  }
  return {
    diff: diffBaseline(baseline, result, currentMetaOf(config)),
    label: `\`${basename(path)}\`（${baseline.savedAt.slice(0, 10)} 存档）`,
  }
}

/**
 * 组装 skill_doctor 工具。
 * @param ctx - 插件上下文（skills / workingDirectory）。
 * @param config - 解析后的插件配置。
 */
export function buildDoctorTool(ctx: Context, config: ResolvedConfig): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'skill_doctor',
    description: 'Diagnose DeepSeek Harness skills in one screen. With a skill name, returns a verdict (usable / model-invisible / description truncated / broken), the exact catalog entry the model sees, ranked reasons, and copyable fixes. Without a name, returns a grouped report: which skills need fixing, which descriptions get truncated, which have other warnings, and which are healthy. '
      + 'The multi-skill report also groups findings by root cause (many skills hitting one rule is usually one template) and states which dsh version its thresholds were calibrated against. '
      + 'With config key `baseline` set to `auto` (recommended: the record is maintained automatically per profile) or to a file path written by the CLI via --save, the report opens with a follow-up comparison against the last checkup — what improved, what is untouched, what regressed — and the current state is stored back as the new record. '
      + 'With `rewrite: true`, return a description-rewrite worksheet (constraints + verbatim visible/cut text + extracted triggers + a skeleton draft) instead of a diagnosis; the model fills in the copy, the user confirms before anything is written — never write the draft yourself and never skip the confirmation. '
      + 'Use this first when a skill does not appear, does not respond, or seems ignored. It never changes or executes a skill; the only file it writes is its own record JSON, and only when `baseline` is configured. '
      + 'The tool result is already a complete, user-ready Markdown report: reply with it verbatim (at most one short lead-in sentence of your own). '
      + 'Do NOT summarize it, do NOT rebuild it as your own tables, and do NOT drop sections — the prescription lines, the follow-up comparison, the calibration note and the technical appendix are part of the diagnosis, not decoration. '
      + 'Never paste it inside a code block or quote it as raw text.',
    parameters: {
      name: { type: 'string', description: 'Diagnose one skill by exact name; omit for a grouped report of every visible skill.' },
      extraRoots: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional skill roots to scan for duplicate/shadowed names (supports ~).',
      },
      rewrite: {
        type: 'boolean',
        description: 'Return a description-rewrite worksheet instead of a diagnosis: hard constraints, the verbatim visible and cut description, extracted trigger phrases and a deterministic skeleton draft. With `name`: one worksheet for that skill. Without `name`: compact worksheets for every description-truncated skill, grouped by shared name prefix (one template draft beats N per-skill drafts). The model fills in the copy, the user confirms before anything is written — this tool itself never writes.',
      },
      format: {
        type: 'string',
        enum: ['markdown', 'json'],
        description: 'Output format; defaults to markdown.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const cwd = exec.agent === undefined
        ? undefined
        : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const skills = await collectRuntimeSkills(ctx, {
        ...cwd === undefined ? {} : { cwd },
        ...exec.agent === undefined ? {} : { scope: exec.agent },
        signal: exec.signal,
        config,
      })
      if (args.extraRoots !== undefined && args.extraRoots.length > 0) {
        const extra = await scanRoots(args.extraRoots, config.maxFileBytes)
        skills.push(...extra.skills)
      }

      // 改写工单模式：产出材料，不做复诊读写，也不改任何状态。
      // 工具描述里写明了：模型填稿、用户确认后才写入，本工具自身绝不写。
      if (args.rewrite === true) {
        if (args.name !== undefined) {
          const skill = skills.find(item => item.name === args.name)
          if (skill === undefined) {
            const available = skills.slice(0, 10).map(item => item.name)
            return [
              `# 简介改写工单：\`${args.name}\``,
              '',
              '当前视图里没有这个技能，出不了工单。',
              available.length > 0
                ? `现在能看到的技能（前 10 个）：${available.join('、')}`
                : '当前视图里一个技能都没有。',
            ].join('\n')
          }
          const linted = await lintSkill(skill, config)
          return renderRewriteWorksheet(linted, config.maxDescriptionLength).join('\n')
        }
        const linted = await lintSkills(skills, config)
        return renderRewriteBatch(linted.results, config.maxDescriptionLength).join('\n')
      }

      if (args.name !== undefined) {
        const skill = skills.find(item => item.name === args.name)
        if (skill === undefined) {
          const available = skills.slice(0, 10).map(item => item.name)
          if (args.format === 'json') {
            return JSON.stringify({ name: args.name, found: false, available }, null, 2)
          }
          return [
            `# 技能体检：\`${args.name}\``,
            '',
            '**结论：当前视图里没有这个技能。**',
            '',
            '常见原因：',
            '- 名字写错了：技能名区分大小写，只能用小写字母、数字和连字符。',
            '- 技能不在当前工作目录能看到的范围里，可以用 `extraRoots` 指过去。',
            '- 技能文件读不出来（比如文件头格式不对），所以没被加载。',
            '',
            available.length > 0
              ? `现在能看到的技能（前 10 个）：${available.join('、')}`
              : '当前视图里一个技能都没有。',
          ].join('\n')
        }

        // 单技能模式也要做同名检测：extraRoots 里可能还有同名副本，
        // 用户按提示加了这个参数却看不到“可能被覆盖”，就会误以为没问题。
        const duplicates = duplicateFindingsBySkill(filterSkills(skills, config))
        const result = await lintSkill(skill, config, duplicates.get(skill) ?? [])
        const reportOptions = {
          maxDescriptionLength: config.maxDescriptionLength,
          // 读磁盘上的 runtime.json，失败也只是“没有这一项”，不影响体检。
          dshVersion: await readDshVersion(),
        }
        if (args.format === 'json') {
          return renderLintJson({
            results: [result],
            errors: result.errors,
            warnings: result.warnings,
            infos: result.infos,
            ok: result.ok,
          }, reportOptions)
        }
        return renderDoctorMarkdown(result, reportOptions)
      }

      const result = await lintSkills(skills, config)
      const recordPath = recordPathOf(config, ctx)
      // 命令式构建而不是对象字面量里连续 async spread：
      // esbuild 对 `...(cond ? {} : await f())` 后跟另一个 async spread 的降级
      // 曾把先展开的键丢掉（tsc 产物正常、vitest 里丢失），不赌这个。
      type Writable<T> = { -readonly [K in keyof T]: T[K] }
      const reportOptions = {
        maxDescriptionLength: config.maxDescriptionLength,
        dshVersion: await readDshVersion(),
      } as Writable<ReportOptions>
      if (recordPath !== undefined) {
        const follow = await followUp(config, recordPath, result)
        if (follow.diff !== undefined && follow.label !== undefined) {
          reportOptions.baselineDiff = follow.diff
          reportOptions.baselineLabel = follow.label
        } else if (follow.missing !== undefined) {
          reportOptions.baselineMissing = follow.missing
        } else if (follow.firstRecord === true) {
          reportOptions.baselineFirstRecord = true
        }
        // 医生每次问诊都会更新病历：本次体检完，把新状态写回同一路径。
        // 写失败只降级成提示（下次对比的还是旧病历），绝不让体检本身失败。
        const saved = await saveRecord(recordPath, config, result)
        if (saved !== undefined) reportOptions.recordSaved = saved
      }
      return args.format === 'json'
        ? renderLintJson(result, reportOptions)
        : renderLintMarkdown(result, reportOptions)
    },
  })
}

/**
 * 把本次体检写回病历文件；失败返回 undefined（不抛）。
 * 只写这一份我们生成的 JSON，路径来自用户显式配置（`baseline`）——
 * 技能文件本身依然一个字节都不碰。
 */
async function saveRecord(
  path: string,
  config: ResolvedConfig,
  result: Awaited<ReturnType<typeof lintSkills>>,
): Promise<string | undefined> {
  try {
    await saveBaseline(path, buildBaseline(result, currentMetaOf(config)))
    return path
  } catch {
    return undefined
  }
}
