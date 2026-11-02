/**
 * e2e 用例矩阵。
 *
 * 每个用例只描述“怎么跑”和“通过标准”，真正的执行在 e2e-headless.mjs 里。
 * 断言原则：只断言结构（工具名、入参、状态、固定产品文案、JSON 形状），
 * 绝不断言模型措辞 —— 模型有随机性，断措辞会天天红。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as fx from './fixtures.mjs'

/** 真实技能根，可用 E2E_SKILL_ROOT 覆盖。 */
// 默认扫当前用户的 Claude 技能目录；不写死某个人的路径，别人克隆后也能直接跑。
export const REAL_SKILL_ROOT = process.env.E2E_SKILL_ROOT ?? join(homedir(), '.claude', 'skills')

/** 单技能诊断的标准任务文本：明确工具名、明确 JSON 入参、要求原样输出。 */
function doctorTask(args, extra = '') {
  return `Use the skill_doctor tool exactly once with arguments ${JSON.stringify(args)}. ${extra} `
    + 'Then output the complete tool result verbatim, without summarizing or editing it. Do not use any other tool.'
}

export const CASES = [
  // ---------- A 真实运行时冒烟 ----------
  {
    id: 'A1',
    group: 'A',
    title: '无工具空跑：模型不调用任何工具，会话正常结束',
    task: 'Reply with the single word pong and nothing else. Do not call any tool.',
    setup: async () => ({ skillDirs: [REAL_SKILL_ROOT] }),
    expect: { exitCode: 0, noToolCall: true, finalIncludes: ['pong'] },
  },
  {
    id: 'A2',
    group: 'A',
    title: '单技能诊断：skill_doctor{name}',
    task: doctorTask({ name: 'nature-citation' }),
    setup: async () => ({ skillDirs: [REAL_SKILL_ROOT] }),
    expect: {
      exitCode: 0,
      tool: 'skill_doctor',
      inputMatch: { name: 'nature-citation' },
      resultIncludes: ['结论：', '模型看到的信息', '## 技术细节（可跳过）'],
    },
  },
  {
    id: 'A3',
    group: 'A',
    title: '多技能诊断：技能数与 CLI 基线一致',
    task: doctorTask({}),
    setup: async () => ({ skillDirs: [REAL_SKILL_ROOT] }),
    expect: {
      exitCode: 0,
      tool: 'skill_doctor',
      resultIncludes: ['一共检查了'],
      /**
       * 运行时视图 ⊇ 目录扫描结果。dsh 自己还带 bundled 虚拟技能（例如
       * provider=windows-acl 的诊断技能），目录里根本不存在，所以不能要求两边数量相等；
       * 只要求“目录里的技能一个都不少”。
       */
      custom: async ({ resultText, cliNames }) => {
        const match = /一共检查了\s*(\d+)\s*个技能/.exec(resultText ?? '')
        if (match === null) return ['结果里没有“一共检查了 N 个技能”']
        if (cliNames === undefined || cliNames.length === 0) return ['CLI 基线拿不到技能名，无法比对']
        const runtime = Number(match[1])
        if (runtime < cliNames.length) {
          return [`运行时只有 ${runtime} 个技能，少于目录里的 ${cliNames.length} 个`]
        }
        const missing = cliNames.filter(name => !String(resultText).includes(`\`${name}\``))
        return missing.length === 0 ? [] : [`运行时报告里缺少这些目录技能：${missing.join(', ')}`]
      },
    },
  },
  {
    id: 'A4',
    group: 'A',
    title: '逐条规则模式：skill_lint{name}',
    task: `Use the skill_lint tool exactly once with arguments ${JSON.stringify({ name: 'nature-citation' })}. `
      + 'Then output the complete tool result verbatim. Do not use any other tool.',
    setup: async () => ({ skillDirs: [REAL_SKILL_ROOT] }),
    expect: {
      exitCode: 0,
      tool: 'skill_lint',
      resultIncludes: ['Skill Doctor'],
    },
  },
  {
    id: 'A5',
    group: 'A',
    title: '解释模式：skill_explain{name}',
    task: `Use the skill_explain tool exactly once with arguments ${JSON.stringify({ name: 'nature-citation' })}. `
      + 'Then output the complete tool result verbatim. Do not use any other tool.',
    setup: async () => ({ skillDirs: [REAL_SKILL_ROOT] }),
    expect: {
      exitCode: 0,
      tool: 'skill_explain',
      resultIncludes: ['provider: filesystem', 'SKILL.md'],
    },
  },
  {
    id: 'A6',
    group: 'A',
    title: 'JSON 输出：skill_doctor{name, format:"json"}',
    task: doctorTask({ name: 'nature-citation', format: 'json' },
      'The result is JSON; keep it inside a fenced code block.'),
    setup: async () => ({ skillDirs: [REAL_SKILL_ROOT] }),
    expect: {
      exitCode: 0,
      tool: 'skill_doctor',
      inputMatch: { format: 'json' },
      jsonResult: true,
    },
  },

  {
    id: 'A7',
    group: 'A',
    title: '插件冲突体检：plugin_doctor',
    task: 'Use the plugin_doctor tool exactly once with arguments {"profile":"headless"}. '
      + 'Then output the complete tool result verbatim. Do not use any other tool.',
    setup: async () => ({ skillDirs: [REAL_SKILL_ROOT] }),
    expect: {
      exitCode: 0,
      tool: 'plugin_doctor',
      inputMatch: { profile: 'headless' },
      // headless 模板不挂 plugin-inventory，所以「运行时状态」这一节必然是降级文案；
      // 只要章节在、且不谎报，就算通过。桌面端才会真正读到 fiberPhase。
      resultIncludes: ['插件体检', '结论：', '运行时状态'],
    },
  },

  {
    id: 'A8',
    group: 'A',
    title: '展示形态：报告章节必须原样存活，不许模型私自摘编',
    // 两代缺陷：①早期报告被 ``` 包成原始文本；②0.7.0 实测模型把报告重新摘编成
    // 自己的表格，处方/校准/技术细节全被丢掉——工具结果本来就是完整报告，
    // 要求原样透传。这里断言关键章节存活 + 无围栏。
    task: '用 skill_doctor 查一下 nature-citation，然后把体检报告直接展示给我看。',
    setup: async () => ({ skillDirs: [REAL_SKILL_ROOT] }),
    expect: {
      exitCode: 0,
      tool: 'skill_doctor',
      custom: async ({ finalText }) => {
        const text = String(finalText ?? '')
        const failures = []
        if (text.includes('```')) failures.push('最终回答里出现了代码块围栏（```），报告被当成原始文本贴出来了')
        if (!text.includes('结论')) failures.push('最终回答里没有结论段')
        // 摘编检测：报告的二级标题是报告骨架，模型自己重写表格时一定会丢。
        // 单技能报告固定有 4 个二级标题（模型看到的信息/被切掉的部分/需要处理的问题/技术细节）。
        const headings = [...text.matchAll(/^## .+$/gm)].length
        if (headings < 3) failures.push(`最终回答只有 ${headings} 个二级标题，报告章节被模型摘编掉了（应原样透传）`)
        if (!text.includes('技术细节')) failures.push('「技术细节」章节丢失：模型没有原样透传报告')
        if (!text.includes('模型看到的信息')) failures.push('「模型看到的信息」章节丢失：模型没有原样透传报告')
        return failures
      },
    },
  },

  // ---------- B 边界与异常 ----------
  {
    id: 'B1',
    group: 'B',
    title: '空技能根：0 个技能也不崩',
    task: doctorTask({}),
    setup: async () => ({ skillDirs: [await fx.emptyRoot()] }),
    // dsh 自带 bundled 虚拟技能，空目录也不会真的“0 个技能”；
    // 这里只要求不崩、能出报告，且不把空目录误报成有问题。
    expect: {
      exitCode: 0,
      tool: 'skill_doctor',
      resultIncludes: ['一共检查了'],
      resultExcludes: ['用不了（有错误）：1', 'SD001'],
    },
  },
  {
    id: 'B2',
    group: 'B',
    title: '只有子目录没有 SKILL.md：不误报 SD001',
    task: doctorTask({}),
    setup: async () => ({ skillDirs: [await fx.rootWithoutSkillFiles()] }),
    expect: {
      exitCode: 0,
      tool: 'skill_doctor',
      resultIncludes: ['一共检查了'],
      resultExcludes: ['SD001', 'just-a-folder'],
    },
  },
  {
    id: 'B3',
    group: 'B',
    title: '简介 800 字：给出截断位置与影响',
    task: doctorTask({ name: 'long-desc' }),
    setup: async () => ({ skillDirs: [await fx.longDescriptionRoot(800)] }),
    expect: {
      exitCode: 0,
      tool: 'skill_doctor',
      resultIncludes: ['前 500', '被切掉的部分', '影响'],
    },
  },
  {
    id: 'B4',
    group: 'B',
    title: 'BOM + CRLF：编码规则在真实运行时可见',
    task: doctorTask({}),
    setup: async () => ({ skillDirs: [await fx.bomCrlfRoot()] }),
    // 用例名说的是“可见”，断言就必须验到可见：这两条是 info 级，
    // 曾经掉进分组裂缝——正文完全看不到，只出现在文末技术细节里。
    expect: {
      exitCode: 0,
      tool: 'skill_doctor',
      resultIncludes: ['一共检查了', '处方：', '能自动修'],
      resultExcludes: ['SD001'],
    },
  },
  {
    id: 'B5',
    group: 'B',
    title: '两个 root 同名技能：提示可能被覆盖',
    // extraRoots 依赖 setup 建出来的临时目录，所以 task 用函数形式，等 setup 完成后再拼。
    task: async ({ extra }) => doctorTask({ name: 'dup-demo', extraRoots: extra.dupRoots }),
    setup: async () => {
      const [a, b] = await fx.duplicateRoots()
      return { skillDirs: [a], extra: { dupRoots: [a, b] } }
    },
    expect: { exitCode: 0, tool: 'skill_doctor', resultIncludes: ['同名'] },
  },
  {
    id: 'B6',
    group: 'B',
    title: '只读技能文件：能体检，且文件不被改写',
    task: doctorTask({ name: 'readonly-skill' }),
    setup: async () => {
      const prepared = await fx.readonlyRoot()
      return { skillDirs: [prepared.root], watchFiles: [prepared.file] }
    },
    expect: { exitCode: 0, tool: 'skill_doctor', resultIncludes: ['结论：'] },
  },
  {
    id: 'B7',
    group: 'B',
    title: '中文技能名：dsh 不收录，只能靠 extraRoots 报出来',
    // 观测到：非 kebab-case 的技能在 snapshot 里根本不存在，运行时视图看不到它。
    // 所以这里显式用 extraRoots 指回同一目录，验证“能看到并给出通俗提示”这条兜底路径。
    task: async ({ skillDirs }) => doctorTask({ extraRoots: skillDirs }),
    setup: async () => ({ skillDirs: [await fx.chineseNameRoot()] }),
    expect: { exitCode: 0, tool: 'skill_doctor', resultIncludes: ['技能名'] },
  },
  {
    id: 'B8',
    group: 'B',
    title: 'extraRoots 用 ~ 展开',
    task: doctorTask({ extraRoots: ['~/.claude/skills'] }),
    setup: async () => ({ skillDirs: [await fx.emptyRoot()] }),
    expect: {
      exitCode: 0,
      tool: 'skill_doctor',
      // ~ 展开成功时，即便主视图为空，也应能扫到真实技能并出现在同名/数量里
      custom: async ({ resultText }) => (/一共检查了\s*[1-9]/.test(resultText ?? '')
        ? []
        : ['extraRoots 的 ~ 没有被展开：主视图为空时结果里没有扫到任何技能']),
    },
  },
  {
    id: 'B9',
    group: 'B',
    title: '未知技能名（json）：found=false + available 数组',
    task: doctorTask({ name: 'no-such-skill-xyz', format: 'json' }),
    setup: async () => ({ skillDirs: [REAL_SKILL_ROOT] }),
    expect: {
      exitCode: 0,
      tool: 'skill_doctor',
      custom: async ({ resultText }) => {
        const json = extractJson(resultText ?? '')
        if (json === undefined) return ['结果里没有可解析的 JSON']
        if (json.found !== false) return [`found 期望 false，实际 ${String(json.found)}`]
        return Array.isArray(json.available) ? [] : ['available 不是数组']
      },
    },
  },
  {
    id: 'B10',
    group: 'B',
    title: '非法 config：插件自禁用，但不阻断会话',
    // 期望插件降级为 warn；实际 warn 在 headless 下看不到（见缺陷清单 D3），
    // 所以这里断言“会话正常结束 + 工具确实不可用”，把告警缺失单独记一条。
    task: 'Use the skill_doctor tool exactly once with no arguments. If the tool does not exist, reply exactly NO_TOOL. Otherwise reply DONE.',
    setup: async () => ({ skillDirs: [REAL_SKILL_ROOT], doctorConfig: { maxDescriptionLength: 'abc' } }),
    expect: { exitCode: 0, noToolCall: true, finalIncludes: ['NO_TOOL'] },
  },
  {
    id: 'B11',
    group: 'B',
    title: '工具名冲突：确定性让位（桩 ctx，不接模型）',
    kind: 'stub',
    setup: async () => ({}),
    expect: { stubOk: true },
  },

  // ---------- C 性能 ----------
  {
    id: 'C1',
    group: 'C',
    title: '性能基线：29 个真实技能',
    task: doctorTask({}),
    setup: async () => ({ skillDirs: [REAL_SKILL_ROOT] }),
    expect: { exitCode: 0, tool: 'skill_doctor', resultIncludes: ['一共检查了'] },
  },
  {
    id: 'C2',
    group: 'C',
    title: '性能：200 个合成技能',
    task: doctorTask({}),
    setup: async () => ({ skillDirs: [await fx.syntheticRoot(200)] }),
    // 运行时视图比目录多一个 dsh 自带 bundled 技能，所以是 201；只校验“不少于”。
    expect: {
      exitCode: 0,
      tool: 'skill_doctor',
      custom: async ({ resultText }) => countAtLeast(resultText, 200),
    },
  },
  {
    id: 'C3',
    group: 'C',
    title: '性能：500 个合成技能',
    task: doctorTask({}),
    setup: async () => ({ skillDirs: [await fx.syntheticRoot(500)] }),
    // 500 技能时 tool_result 事件会被运行时投影截断（truncated=true），
    // 模型实际拿到的仍是全文（最终回答里有完整报告），所以这里只看计数下界。
    expect: {
      exitCode: 0,
      tool: 'skill_doctor',
      custom: async ({ resultText, finalText }) => {
        const fromResult = countAtLeast(resultText, 500)
        if (fromResult.length === 0) return []
        // 事件被截断时退回最终回答里找计数。
        return countAtLeast(finalText, 500)
      },
    },
  },

  // ---------- D 模型可用性 ----------
  {
    id: 'D1',
    group: 'D',
    title: '可用性：直接指令',
    task: 'Use the skill_doctor tool on the skill named nature-citation, then summarize the verdict in one sentence.',
    setup: async () => ({ skillDirs: [REAL_SKILL_ROOT] }),
    expect: { exitCode: 0, tool: 'skill_doctor' },
  },
  {
    id: 'D2',
    group: 'D',
    title: '可用性：显式 JSON 参数',
    task: 'Call skill_doctor with {"name":"nature-citation"} and tell me whether it is usable.',
    setup: async () => ({ skillDirs: [REAL_SKILL_ROOT] }),
    expect: { exitCode: 0, tool: 'skill_doctor' },
  },
  {
    id: 'D3',
    group: 'D',
    title: '可用性：中文口语，不点名工具',
    task: '帮我看看 nature-citation 这个技能，为什么模型好像老是不主动用它？用技能体检工具查一下。',
    setup: async () => ({ skillDirs: [REAL_SKILL_ROOT] }),
    expect: { exitCode: 0, tool: 'skill_doctor' },
  },
  {
    id: 'D5',
    group: 'D',
    title: '范围：用户点名目录时只查该目录，并如实声明范围',
    // 回归：真实用户说"查 D://...//test-skills"，模型没传范围参数，
    // 工具只能把该目录追加进来，结果扫了 42 个技能——报告与提问不符。
    task: '只体检 ~/.claude/skills 这个目录下的技能，不要看别的地方。',
    setup: async () => ({ skillDirs: [REAL_SKILL_ROOT] }),
    expect: {
      exitCode: 0,
      tool: 'skill_doctor',
      custom: async ({ finalText }) => {
        const text = String(finalText ?? '')
        const failures = []
        if (!text.includes('本次只检查了指定范围')) {
          failures.push('报告没有声明"只检查指定范围"：模型很可能没传 roots，扫了全量技能')
        }
        return failures
      },
    },
  },
  {
    id: 'D4',
    group: 'D',
    title: '可用性：改写工单——诊断之后直接给改写材料，不越权写文件',
    task: 'nature-citation 的简介太长了，用技能体检工具的改写模式给我出一份改写工单。',
    setup: async () => ({ skillDirs: [REAL_SKILL_ROOT] }),
    expect: {
      exitCode: 0,
      tool: 'skill_doctor',
      custom: async ({ finalText }) => {
        const text = String(finalText ?? '')
        const failures = []
        if (!text.includes('改写工单')) failures.push('最终回答里没有改写工单')
        if (!text.includes('确认')) failures.push('工单没有要求用户确认——模型不得跳过确认直接写文件')
        return failures
      },
    },
  },
]


/** 断言报告里的技能数不少于 n（运行时视图还会多出 bundled 技能）。 */
function countAtLeast(text, n) {
  const match = /一共检查了\s*(\d+)\s*个技能/.exec(String(text ?? ''))
  if (match === null) return ['结果里没有“一共检查了 N 个技能”']
  const count = Number(match[1])
  return count >= n ? [] : [`报告只统计了 ${count} 个技能，少于期望的 ${n}`]
}

/** 从可能包含 Markdown 代码块的文本里抠出第一个 JSON 对象。 */
export function extractJson(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/** 按 id 或分组筛选用例。 */
export function selectCases({ ids = [], groups = [] } = {}) {
  return CASES.filter(item =>
    (ids.length === 0 || ids.includes(item.id))
    && (groups.length === 0 || groups.includes(item.group)))
}
