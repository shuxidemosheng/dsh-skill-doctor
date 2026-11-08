/** skill_doctor：结论优先的单技能诊断 / 多技能体检。 */
import { basename } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-working-directory'
import {
  buildBaseline,
  currentMetaOf,
  diffBaseline,
  expandHome,
  loadBaseline,
  recordPathOf as recordPathFor,
  saveBaseline,
  type BaselineDiff,
} from '../baseline.js'
import type { ResolvedConfig } from '../config.js'
import type { SkillInput, WinnerInfo } from '../types.js'
import { profileNameOf } from '../profile-name.js'
import { collectRuntimeSkillsWithWinners, collectWinners } from '../runtime.js'
import { scanRoots, scanSkillFile } from '../scanner/fs-scan.js'
import { duplicateFindingsBySkill } from '../scanner/checks/duplicates.js'
import { filterSkills, lintSkill, lintSkills } from '../scanner/scan.js'
import { readDshVersion } from '../version-check.js'
import { FIXABLE_RULES, planFixes } from '../fixer/plan.js'
import { applyFixes, type Verify } from '../fixer/apply.js'
import { setDescription as writeDescription } from '../fixer/description.js'
import { renderRewriteBatch, renderRewriteWorksheet } from './rewrite.js'
import { renderDoctorMarkdown, renderLintJson, renderLintMarkdown, type ReportOptions } from './report.js'
import { buildProvenance } from './provenance.js'

/** 病历路径的解析：`auto` 用 profile 专属的默认路径，其余按用户给的路径展开。 */
function recordPathOf(config: ResolvedConfig, ctx: Context): string | undefined {
  return recordPathFor(config.baseline, profileNameOf(ctx))
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
      + 'When the user names a directory, pass it as `roots` so the report covers exactly that scope; omitting it checks every skill visible to the session. Use this first when a skill does not appear, does not respond, or seems ignored. By default it only reads files; it writes in exactly three cases, each with backup and rollback: its own record JSON when `baseline` is configured, the description line when called with `setDescription` (only after the user confirmed that exact text), and byte-level BOM/CRLF when called with `fix: true`. It never rewrites semantic content on its own. '
      + 'The tool result is already a complete, user-ready Markdown report: reply with it verbatim (at most one short lead-in sentence of your own). '
      + 'Do NOT summarize it, do NOT rebuild it as your own tables, and do NOT drop sections — the prescription lines, the follow-up comparison, the calibration note and the technical appendix are part of the diagnosis, not decoration. '
      + 'Never paste it inside a code block or quote it as raw text.',
    parameters: {
      name: { type: 'string', description: 'Diagnose one skill by exact name; omit for a grouped report of every visible skill.' },
      extraRoots: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional skill roots to scan for duplicate/shadowed names (supports ~). Additive: session skills stay in the report.',
      },
      roots: {
        type: 'array',
        items: { type: 'string' },
        description: 'Restrict the check to these directories or SKILL.md files (supports ~). PASS THIS whenever the user names a directory ("check D:////skills") — without it the scan covers every skill visible to the session and the report will not match what was asked. Scoped reports say so in the header.',
      },
      rewrite: {
        type: 'boolean',
        description: 'Return a description-rewrite worksheet instead of a diagnosis: hard constraints, the verbatim visible and cut description, extracted trigger phrases and a deterministic skeleton draft. With `name`: one worksheet for that skill. Without `name`: compact worksheets for every description-truncated skill, grouped by shared name prefix (one template draft beats N per-skill drafts). The model fills in the copy, the user confirms before anything is written — this tool itself never writes.',
      },
      setDescription: {
        type: 'string',
        description: 'Write this exact text as the skill\'s description (requires `name`). Call it ONLY after the user explicitly confirmed the draft; the tool refuses multiline or over-limit text, replaces only the frontmatter description line with YAML-safe quoting, backs up to .bak, and rolls back if the re-scan does not match. It never invents or edits the copy itself.',
      },
      fix: {
        type: 'boolean',
        description: 'Apply the byte-exact fixes (BOM / CRLF only, requires `name`) to that skill file: plan, write with .bak, re-scan and roll back on any new error. Semantic problems are never touched.',
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
      // 两种范围语义必须分开：roots = 只查这些（用户点名了目录），
      // extraRoots = 在会话可见技能之外再补充（查同名遮蔽时用）。
      const scopedTo = args.roots !== undefined && args.roots.length > 0 ? args.roots : undefined
      let skills: SkillInput[]
      // registry 判定的同名获胜者。文件扫描路径没有现成的 snapshot，需要补一次；
      // 拿不到就降级为「候选」，绝不臆测谁生效。
      let winners: ReadonlyMap<string, WinnerInfo> | undefined
      let scopeIssues: readonly string[] = []
      if (scopedTo !== undefined) {
        const scanned = await scanRoots(scopedTo, config.maxFileBytes)
        skills = [...scanned.skills]
        scopeIssues = scanned.issues
        winners = await collectWinners(ctx, {
          ...cwd === undefined ? {} : { cwd },
          ...exec.agent === undefined ? {} : { scope: exec.agent },
          signal: exec.signal,
        })
      } else {
        // 一次 snapshot 同时产出技能与获胜者，不额外增加 registry 往返。
        const collected = await collectRuntimeSkillsWithWinners(ctx, {
          ...cwd === undefined ? {} : { cwd },
          ...exec.agent === undefined ? {} : { scope: exec.agent },
          signal: exec.signal,
          config,
        })
        skills = collected.skills
        winners = collected.winners
      }
      if (args.extraRoots !== undefined && args.extraRoots.length > 0) {
        const extra = await scanRoots(args.extraRoots, config.maxFileBytes)
        skills.push(...extra.skills)
      }

      // 改写工单模式：只产出材料，不写任何文件。
      // 用户确认草稿之后，再带 setDescription 调一次才算写入。
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

      // 写入路径：默认只读，但用户确认草稿后不该逼他开终端。
      // 两个参数都要 name，且只写“用户给的那一行”或“字节级编码修复”，见工具描述。
      if (args.setDescription !== undefined || args.fix === true) {
        if (args.name === undefined) {
          return [
            '# 写入需要指定技能',
            '',
            '`setDescription` 与 `fix` 都必须配合 `name` 使用——批量写技能文件风险太大，',
            '批量修复请用 CLI：`dsh-skill-lint <root> --fix --apply`。',
          ].join('\n')
        }
        const target = skills.find(item => item.name === args.name)
        if (target === undefined) {
          return `# 未写入：\`${args.name}\`\n\n当前视图里没有这个技能，先确认名字（区分大小写）。`
        }
        if (target.path === undefined) {
          return `# 未写入：\`${args.name}\`\n\n这是 dsh 自带的虚拟技能，没有本地文件，改不了。`
        }
        return args.setDescription !== undefined
          ? await writeDescriptionOutcome(target, args.setDescription, skills, config)
          : await fixOutcome(target, config)
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
        const duplicates = duplicateFindingsBySkill(filterSkills(skills, config), winners)
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

      const result = await lintSkills(skills, config, winners)
      const recordPath = recordPathOf(config, ctx)
      // 命令式构建而不是对象字面量里连续 async spread：
      // esbuild 对 `...(cond ? {} : await f())` 后跟另一个 async spread 的降级
      // 曾把先展开的键丢掉（tsc 产物正常、vitest 里丢失），不赌这个。
      type Writable<T> = { -readonly [K in keyof T]: T[K] }
      const reportOptions = {
        maxDescriptionLength: config.maxDescriptionLength,
        dshVersion: await readDshVersion(),
      } as Writable<ReportOptions>
      // 视图从**过滤后**的结果派生，保证与报告里展示的技能集合一致。
      const provenance = buildProvenance(result.results.map(item => item.skill), winners, cwd)
      if (provenance !== undefined) reportOptions.provenance = provenance
      if (scopedTo !== undefined) reportOptions.scopedTo = scopedTo
      if (scopeIssues.length > 0) reportOptions.scopeIssues = scopeIssues
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

/**
 * 工具侧写 description：复用 CLI 的确定性写入（备份 / 复验 / 回滚 / 块标量拒绝）。
 * 内容只来自调用参数——工具不生成、不改写文案。
 */
async function writeDescriptionOutcome(
  skill: SkillInput,
  draft: string,
  skills: readonly SkillInput[],
  config: ResolvedConfig,
): Promise<string> {
  const outcome = await writeDescription({
    skillName: skill.name,
    draft,
    candidates: skills,
    config,
    apply: true,
  })
  const lines = [
    outcome.status === 'applied'
      ? `# 已写入 description：\`${outcome.skillName}\``
      : `# 未写入：\`${outcome.skillName}\``,
    '',
  ]
  if (outcome.status !== 'applied') {
    lines.push(outcome.error ?? '写入失败（原因未知）。', '')
    if (outcome.file.length > 0) lines.push(`目标文件：${outcome.file}`, '')
    return lines.join('\n')
  }
  lines.push(
    `- 文件：${outcome.file}`,
    `- 长度：${outcome.beforeLength} → ${outcome.afterLength} 字（上限 ${config.maxDescriptionLength}）`,
    '- 备份：同目录 `.bak`（内容不满足预期时可整体还原）',
    '- 复验：重扫后 description 与草稿一致，错误数未增加',
    '',
    `下一步：重跑 \`skill_doctor { name: "${outcome.skillName}" }\`，复诊对比里应看到这条好转。`,
    '',
  )
  return lines.join('\n')
}

/**
 * 工具侧确定性修复：只用 planFixes 的可修规则（BOM / CRLF），并复用 CLI 同一套复验。
 * 语义问题一律不碰——这也是 fix 参数只接受布尔值、没有“修什么”选项的原因。
 */
async function fixOutcome(skill: SkillInput, config: ResolvedConfig): Promise<string> {
  const linted = await lintSkill(skill, config)
  const plan = await planFixes([linted], FIXABLE_RULES)
  if (plan.targets.length === 0) {
    const why = plan.skips.length > 0
      ? plan.skips.map(skip => `- ${skip.rule}：${skip.reason}`).join('\n')
      : '- 没有命中可自动修的规则（只修 BOM 与 CRLF）。'
    return [`# 没有可自动修的内容：\`${skill.name}\``, '', why, '', '语义问题只能人工改，见体检报告的处方。'].join('\n')
  }

  const errorsBefore = linted.errors
  const verify: Verify = async target => {
    const rescanned = await scanSkillFile(target.file, config.maxFileBytes)
    if (rescanned === undefined) return ['修复后这个文件读不出来了']
    const after = await lintSkill(rescanned, config)
    const problems: string[] = []
    const remaining = [...new Set(
      after.findings.filter(item => item.rule === 'SD013' || item.rule === 'SD014').map(item => item.rule),
    )]
    if (remaining.length > 0) problems.push(`修完仍然命中 ${remaining.join('、')}`)
    if (after.errors > errorsBefore) problems.push(`修完出现了新的错误（${errorsBefore} → ${after.errors}）`)
    return problems
  }

  const outcomes = await applyFixes(plan.targets, verify)
  const lines = [`# 自动修复：\`${skill.name}\``, '']
  for (const outcome of outcomes) {
    if (outcome.status === 'applied') {
      lines.push(`- ✅ 已修复：${outcome.target.rules.join('、')}（备份 ${outcome.backup ?? '.bak'}）`)
    } else if (outcome.status === 'rolled-back') {
      lines.push(`- ⛔ 已回滚：${outcome.target.rules.join('、')} — ${outcome.problems.join('；')}`)
    } else {
      lines.push(`- ⛔ 未写入：${outcome.error ?? '未知原因'}`)
    }
  }
  lines.push('', `下一步：重跑 \`skill_doctor { name: "${skill.name}" }\` 确认这几条已消失。`, '')
  return lines.join('\n')
}
