/** skill_doctor：结论优先的单技能诊断 / 多技能体检。 */
import { basename } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-working-directory'
import { currentMetaOf, diffBaseline, expandHome, loadBaseline, type BaselineDiff } from '../baseline.js'
import type { ResolvedConfig } from '../config.js'
import { collectRuntimeSkills } from '../runtime.js'
import { scanRoots } from '../scanner/fs-scan.js'
import { duplicateFindingsBySkill } from '../scanner/checks/duplicates.js'
import { filterSkills, lintSkill, lintSkills } from '../scanner/scan.js'
import { readDshVersion } from '../version-check.js'
import { renderDoctorMarkdown, renderLintJson, renderLintMarkdown } from './report.js'

/**
 * 读病历并算出复诊差值；任何失败都降级为「没有对比」，不影响体检本身。
 * @returns diff 与展示标签；读不到病历时返回 missing 提示。
 */
async function followUp(
  config: ResolvedConfig,
  result: Awaited<ReturnType<typeof lintSkills>>,
): Promise<{ diff?: BaselineDiff; label?: string; missing?: string }> {
  if (config.baseline === undefined) return {}
  const path = expandHome(config.baseline)
  const baseline = await loadBaseline(path)
  if (baseline === undefined) return { missing: path }
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
      + 'If a baseline record (saved once by the CLI via --save) is configured under config key `baseline`, the report opens with a follow-up comparison against it: what improved, what is untouched, what regressed. '
      + 'Use this first when a skill does not appear, does not respond, or seems ignored. It only reads files and never changes or executes a skill. '
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
      const reportOptions = {
        maxDescriptionLength: config.maxDescriptionLength,
        dshVersion: await readDshVersion(),
        ...await followUp(config, result),
      }
      return args.format === 'json'
        ? renderLintJson(result, reportOptions)
        : renderLintMarkdown(result, reportOptions)
    },
  })
}
