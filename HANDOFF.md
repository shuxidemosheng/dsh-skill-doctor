# dsh-skill-doctor 交接说明

> 这份文件是给下一个会话/接手人的完整上下文。读完后应能直接继续开发，不需要重新调研市场或猜测设计意图。
>
> 最后更新：2026-10-31（0.3.0：新增 plugin_doctor），版本 0.3.0。

---

## 0. 一句话

`dsh-skill-doctor` 是 dsh 技能的**可见性诊断工具**：检查模型能不能看到、会不会选中一个技能；当技能简介被截断时，指出被切掉了哪些触发词、影响大不大、应该怎么改。

它不是技能市场、不是安装器、不是安全扫描器，也还不是“技能效果 A/B 评测器”。

---

## 1. 当前状态

| 项 | 状态 |
|---|---|
| 项目目录 | `D:\AIcoding\dsh-skill-doctor` |
| 版本 | `0.3.0`（npm 已发布 0.2.0，0.3.0 待发布） |
| npm 包名 | `dsh-skill-doctor`（已确认可用，尚未发布） |
| CLI bin | `dsh-skill-lint` |
| git | **尚未 `git init` / commit** |
| 测试 | 41 passed（5 个 spec 文件） |
| e2e（真实 dsh） | 22 个用例：A 7/7、B 11/11、C 3/3、D 3/3 |
| 构建 | `lib/index.js`、`lib/cli.js` 正常 |
| smoke | `smoke ok` |
| Mimosa 深度扫描 | 0 findings，scanId `scan-2026-10-28T09-59-40.211Z-e776b4c3fa06` |
| desktop profile | 已安装为 `link:D:/AIcoding/dsh-skill-doctor`，**需要重启桌面端才加载** |
| web profile | 已安装为 `link:D:/AIcoding/dsh-skill-doctor` |
| headless profile | 已安装为 `link:D:/AIcoding/dsh-skill-doctor`，用于真实 dsh 测试 |

---

## 1.5 0.3.0 新增：plugin_doctor（插件冲突体检）

需求原话：“可以检测 DSH 上已安装的插件是否冲突？”

- 新工具 `plugin_doctor({ profile?, format? })`，只读，返回人话报告。
- 数据源全部是磁盘：`$DSH_HOME/profiles/<p>/package.json`（bundles 顺序 + dependencies spec）、
  每个 bundle 的 `node_modules/<name>/package.json` 与 `cordis.patch.yml`。
- 四条规则：PL001 重复 bundle（warn）、PL002 两个插件 insert 同一条目（warn）、
  PL003 两个插件改同一条目（warn，后加载覆盖前面的）、PL004 启用了没包（error）/ 装了没启用（info）。
- 包来源三分：`profile`（node_modules 里可读）/ `shipped`（`@deepseek-ai/*`，在 app.asar 内）/
  `missing`。**shipped 不能算缺失**，这是第一版最大的误报来源，已修。
- 明确查不到：运行时工具名被两个插件同时注册（注册表不暴露归属）；shipped 插件的 patch 读不到，
  所以条目冲突只在 profile 插件之间比对。报告里写明了这两条，不猜。
- 代码：`src/plugins/scan.ts`（解析+规则）、`src/plugins/report.ts`（渲染）、`src/tools/plugin.ts`（工具）。
  CLI 加 `--plugins --profile <name>`（不依赖 dsh 运行时），有 error 级冲突时退出码 1。
- 测试：`tests/plugins.spec.ts` 6 条（含 PL002/PL003 正例、shipped 不误报、profile 不存在）；
  e2e 新增 A7（真实 dsh 里调用 plugin_doctor）。
- 真实数据：desktop profile 10 个 bundle（7 本地 + 3 自带），没有条目冲突；headless 3 个（1 本地 + 2 自带）。
- 版本从 0.2.0 → 0.3.0，package 描述同步。

## 2. 用户最新的明确要求（已实现，保留作验收依据）

> “该插件给出的检测报告能否更加通俗易懂，而不是用一些专业性太强的语言。”

**状态：已完成（2026-10-28）。** 报告改为两段式：第一屏全人话，规则 ID / provider / model-invocable 收进文末“技术细节（可跳过）”。实现方式：

- `src/tools/report.ts` 新增 `style: 'plain' | 'technical'`；`skill_doctor` 走 plain，`skill_lint` 强制 technical。
- 每条 finding 统一渲染成“小标题 + 现在 + 怎么改”，人话标题来自 `RULES[x].plainTitle`。
- check 里的 message 文案整体改为中文人话（含具体数字），SD001 的英文解析错误由 `plainMessage()` 翻译。
- 测试新增“第一屏不得出现 SDxxx / provider: / model-invocable”断言（`firstScreen()` 辅助函数）。

下面的术语表和示例保留，作为下次改文案的判断标准。

### 2.1 术语替换建议

| 现在 | 改成 |
|---|---|
| `description` | “给模型看的简介（description）” 首次提；之后用“简介” |
| `frontmatter` | “文件头（`---` 之间的部分）” 首次提；之后用“文件头” |
| `provider` | “来源” |
| `model-invocable: yes/no` | “模型能不能自动用：能 / 不能” |
| `user-invocable` | “能不能用 `/名字` 手动调用” |
| `SD004` | 先写人话：“简介太长，模型只能看到前 500 字”；规则 ID 放括号里或文末 |
| `截断影响：高` | “影响：大。模型看不到这些关键词，可能不会用这个技能” |
| `resource reference` | “技能里提到的文件” |
| `kebab-case` | “只能用小写字母、数字和连字符” |
| `provider: filesystem` | “来源：本地文件” |

### 2.2 目标输出示例

```text
结论：这个技能能用，但模型只能看到简介的前 500 字。

模型实际看到的简介：
  "Add strict Nature/CNS citations ... Cell Press, …"

被切掉的部分里有这些关键词：
  分段引用、自动给出引用、Nature系列引用、CNS及子刊、支撑文献、补引用

影响：大。
  模型可能不知道你什么时候想用它，因为你说的这些词它看不到。

建议：
  把这几句移到简介开头，例如：
  "当用户说「分段引用」「自动给出引用」「找支撑文献」时使用。"
  改完再跑一次，确认“影响”变成“小”。
```

### 2.3 验收标准

- 不懂 dsh 内部概念的人，读前 10 行就能知道：这个技能有没有问题、问题是什么、下一步做什么。
- 第一屏不出现 `SDxxx`、`provider`、`model-invocable`、`frontmatter` 这些词；规则 ID 和技术字段放到末尾“技术细节”或 `verbose` 模式。
- 每条 finding 都包含“会发生什么”和“怎么改”，不能只有规则名。
- 现有测试断言会需要同步修改（目前断言了“结论：✅”“模型目录条目”“检查了 2 个技能”等字符串）。

---

## 3. 为什么选这个方向（决策历史，避免重新讨论）

已经排除的方向：

- **插件安装安全审查**：awesome 列表 Security 分类 203 条，其中约 38 条直接相关，头部产品（ateen18、dushaobindoudou、BotonJ 等）已经很完整，红海。
- **模型能力体检**：用户已经会选模型，也会看排行榜/测评；信息型工具价值不足。
- **完成前强制跑测试**：用户认为现在的模型基本会自己跑测试，痛点不成立。
- **其余通用方向**：UI/主题、会话导出、Memory、成本仪表盘、MCP 管理器、WSL 微工具都过度饱和。

选择 `dsh-skill-doctor` 的理由：

- 在 catalog 描述里搜 `skill lint/test/validate/eval/quality/debug`，直接命中为 0。
- Skill 分类 263 个插件、30 天 40 万下载；`dsh-skill-explorer` 12.9 万、`dsh-skills-manager` 12.8 万，说明用户基数存在。
- 和用户已有的 `dsh-skill-compat-plus`（挂载 Claude/Codex/ZCode 技能）能形成产品线。
- 技术难度低：只读 `ctx.skills` 和本地 `SKILL.md`，不需要 native 代码、不需要执行技能。

当前产品定位要守住：**诊断工具**，不要扩成管理器、安全扫描器或大而全的评测平台。

---

## 4. 代码结构

```text
src/
  index.ts              # Cordis 入口：name / inject / apply
  config.ts             # 严格配置 + withRuleFilter
  runtime.ts            # ctx.skills.snapshot/get -> SkillInput
  cli.ts                # dsh-skill-lint
  scanner/
    frontmatter.ts      # YAML 切分/解析（maxAliasCount=100）
    rules.ts            # 15 条规则元数据（SD001-SD015）
    scan.ts             # 编排 + 规则覆盖 + 阈值过滤
    fs-scan.ts          # 本地 root/单技能扫描；跳过 _ 开头目录
    text.ts             # token 估算/行号/空正文判定
    checks/
      structure.ts      # frontmatter/name/description/body/invocation/编码
      budget.ts         # SD007 正文 token 预算
      resources.ts      # SD008/SD015 资源引用
      instructions.ts   # SD012 可疑指令启发式
      duplicates.ts     # SD009 同名遮蔽
  tools/
    doctor.ts           # skill_doctor（结论优先）
    lint.ts             # skill_lint（verbose/CI）
    explain.ts          # skill_explain（兼容保留）
    report.ts           # Markdown/JSON 渲染
tests/                  # 31 个测试 + fixtures
scripts/smoke.mjs       # 构建产物 + 打桩 ctx
cordis.patch.yml
README.md / README.en.md
```

### 关键行为

- `ctx.skills.snapshot({ cwd, scope, signal })` 拿当前视图的获胜技能。
- `ctx.skills.get(name, ...)` 拿完整正文，确认真的能加载。
- 本地 `SKILL.md` 只读；远端/虚拟技能自动跳过文件级检查。
- `extraRoots` 用于扫描外部目录（Claude/Codex/ZCode）和同名候选。
- 不执行技能脚本、不修改文件、不发网络请求。
- 配置非法时 `warn + return`，不阻断会话创建。
- 工具名冲突时先 `ctx.tools.get()`，单个让位。
- 绝不 `export default`。

---

## 5. 规则与报告逻辑现状

15 条规则：SD001–SD015，详见 `src/scanner/rules.ts` 和 README。

当前报告已经做的改进：

- 报告分两种风格：`plain`（默认，人话）与 `technical`（规则 ID 前置，CI 用）。`skill_lint` 固定 technical。
- `skill_doctor` 单技能：结论 + 模型实际看到的简介 + 被切掉的说法 + 影响大/小 + 怎么改 + 文末技术细节。
- `skill_doctor` 多技能：“先修这些 / 模型看不到触发说法 / 影响不大 / 其他小问题 / 没问题”五段，技术附录只列有命中的技能。
- finding 文案全部中文化，标题用 `RULES[x].plainTitle`，正文统一“现在 + 怎么改”。
- 截断影响启发式：从被截断部分提取引号短语和 `Use when/用于/触发` 等触发句；如果出现新的触发短语 → 影响高。
- 已修误报：
  - `scripts/make_<template>.py` 占位符不再误报；
  - `references/editorial criteria and processes.md` 带空格文件名；
  - 绝对路径 `...\scripts\check-deps.mjs` 不再当技能内引用；
  - `_references` 等 `_` 开头目录跳过；
  - name 与目录名不一致从 error 降为 warn。

仍然要注意：

- 截断影响是启发式，可能误判“Do not use for...”为负面/正面；已经排除 `Do not use for`，但中文“不要用于”等仍需测试。
- token 估算是近似值（ASCII ≈ 4 字符/token，CJK ≈ 0.75 token/字符）。
- 同名检测只扫 `extraRoots`，结论标注“候选”。
- 行号对 body 级 finding 使用 raw 文件定位，已修正；仍可能有近似。

---

## 6. 真实 dsh 测试环境（重要）

### 6.0 2026-10-31 更新：headless 走官方账号通道，不需要本地网关

7863 那个 `wb2api` 网关的程序已不在工作区（`D://AIcoding//wb2api//` 不存在，无进程、无启动脚本），不要再去启动它。
headless 模板默认把 `credentials`、`authorization`、`deepseek-account` 三行都 `disabled: true`；在 `--patch` 里重新打开即可用
官方账号通道（`provider: deepseek-account`，模型 `deepseek-flash`），凭据直接读 `~/.dsh/.credentials.yaml` 里已登录的
`deepseek-account-platform/default` 授权：

```yaml
- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'
  disabled: false
- id: authorization
  name: '@deepseek-ai/dsh-authorization'
  disabled: false
- id: deepseek-account
  name: '@deepseek-ai/dsh-deepseek-account-platform'
  disabled: false
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config: { provider: deepseek-account, model: deepseek-flash }
```

这些都已经固化进 `scripts/e2e-headless.mjs`（`--provider account`，默认）。两个坑：
- 启动器 flag 必须排在第一个 app flag 前面：`--profile headless --patch X --json -`，顺序错了会报 `unknown option '--patch'`。
- patch 里 Windows 路径写在双引号中时必须转义反斜杠，否则 YAML 报 `expected hexadecimal character`。

### 6.1 旧的网关方案（仅作历史记录）

桌面端读的是 `desktop` profile，不是 `web`；CLI 无法直接 boot `desktop`（`profile "desktop" is managed exclusively by the Electron application`）。真实功能测试使用 `headless` profile：

```text
C:\Users\fenghaoyu\.dsh\profiles\headless
bundles: @deepseek-ai/dsh-base, @deepseek-ai/dsh-headless, dsh-skill-doctor
```

因为 headless 默认 provider 没有凭据，测试时使用一个临时 patch：

```text
C:\Users\fenghaoyu\AppData\Local\Temp\dsh-headless-provider.yml
```

内容要点：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: openai-completions
    model: cn:deepseek-v4.1-flash
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      openai-completions:
        displayName: openai-completions
        apiKeyEnv: OPENAI_COMPLETIONS_API_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:7863/v1
        models:
          - id: cn:deepseek-v4.1-flash
            name: DeepSeek V4.1 Flash
            contextWindow: 1000000
            maxTokens: 8192
```

临时 PowerShell 脚本：

```text
C:\Users\fenghaoyu\AppData\Local\Temp\run-dsh-headless.ps1
```

它从 `~/.dsh/.credentials.yaml` 的 `refs` 读取 `OPENAI_COMPLETIONS_API_KEY`，再运行：

```powershell
& 'D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' `
  --profile headless `
  --patch 'C:\Users\fenghaoyu\AppData\Local\Temp\dsh-headless-provider.yml' `
  $Task
```

典型测试调用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  "C:\Users\fenghaoyu\AppData\Local\Temp\run-dsh-headless.ps1" `
  -Task "Use the skill_doctor tool exactly once with arguments {""extraRoots"":[""C:/Users/fenghaoyu/.claude/skills""]}. Then output the complete tool result verbatim, without summarizing or editing. Do not use any other tool."
```

### 安全注意

- **不要**把临时 patch、临时脚本或 `~/.dsh/.credentials.yaml` 提交到仓库。
- 会话记录中曾出现 `OPENAI_COMPLETIONS_API_KEY` 的值；如果这份记录要给他人看，建议轮换该 key。交接文档里不要写 key。
- 本地 gateway 在 `http://127.0.0.1:7863/v1`，需要 `OPENAI_COMPLETIONS_API_KEY`。

### 真实测试结果（2026-10-28）

扫描 `C:/Users/fenghaoyu/.claude/skills`：

```text
30 个技能：0 需要修复 / 13 描述会被截断 / 1 其他提示 / 16 正常
影响高（7）：nature-citation、nature-writing、nature-polishing、nature-reader、nature-data、nature-response、nature-paper2ppt
影响低（6）：nature-figure、nature-paper-card、nature-paper-to-patent、nature-academic-search、nature-statistics、nature-reviewer
其他提示（1）：researchwrite（name 与目录名不一致）
```

`nature-citation` 单技能输出已验证：956 字符，模型只看前 500，截断部分包含“分段引用/自动给出引用/…”等 6 个触发短语，影响高。

---

### 6.2 真实 e2e 结果（2026-10-31，headless + 官方账号通道）

命令：`node scripts/e2e-headless.mjs --group A,B,C --timeout 240`（另有 D 组 3 个用例单独跑）

| 组 | 结果 | 覆盖 |
|---|---|---|
| A 冒烟 | 6/6 | 无工具空跑、单技能、多技能、skill_lint、skill_explain、format=json |
| B 边界 | 11/11 | 空根、无 SKILL.md、800 字简介、BOM+CRLF、双 root 同名、只读文件、中文名、`~` 展开、未知技能、非法 config、工具名冲突 |
| C 性能 | 3/3 | 29 / 200 / 500 个技能 |
| D 可用性 | 3/3 | 直接指令、显式 JSON 参数、中文口语（不点名工具） |

性能（工具段 = `tool_call` 到 `tool_result` 的间隔，单次）：

| 技能数 | 工具段 | CLI 基线 | 模型侧报告 |
|---|---|---|---|
| 29（真实） | 56ms | 137ms | 3.4KB |
| 200（合成） | 185–198ms | ~200ms | 7.8KB（事件被 8KiB 投影截断） |
| 500（合成） | 404–446ms | ~340ms | 12.9KB（`final` 全量） |

放大 ≤1.4×，没有 O(N²)；`ctx.skills.get` 串行在当前量级可以接受。

本轮发现并修掉的缺陷：

- **D1（P1）单技能模式忽略 extraRoots 的同名检测**：`skill_doctor{name, extraRoots}` 曾输出“没问题”。
  根因 `src/tools/doctor.ts` 单技能分支只调 `lintSkill(skill, config)`，没传 `duplicateFindingsBySkill`。
  修法：新增 `filterSkills()`（`src/scanner/scan.ts`），单技能分支先算同名再 lint。回归：B5 + 单测。
- **D2（P2）dsh 自带虚拟技能混进用户技能统计**：空目录也显示“1 个技能”。
  修法：`src/tools/report.ts` 识别无本地路径的技能，统计里注明“其中 N 个是 dsh 自带”，清单里标“（dsh 自带）”。回归：单测 + B1/B2。

记录但未改（已写进 README 已知限制）：

- **D3** 非法 config 时插件自禁用，`ctx.logger.warn` 在 headless 下完全不可见（无 stderr、无事件、`~/.dsh/logs` 不存在）。
- **D4** 500 技能报告 12.9KB；`--json` 的 `tool_result` 被 8KiB 投影截断（`truncated:true`），模型侧仍是全文。
- **D5** 非 kebab-case 技能不进 snapshot，运行时视图看不到，只能靠 `extraRoots` 扫目录。

桌面端目视尚未做（需要完全退出并重开桌面端加载新 `lib/`）。

## 7. 下一步任务

### P0（用户最新要求）

1. ~~把报告改成通俗语言~~ — 已完成，见第 2 节。
2. ~~技术细节移到末尾~~ — 已完成（`## 技术细节（可跳过）`）。
3. ~~同步修改测试断言~~ — 已完成，32 passed。
4. ~~更新 README 的示例输出~~ — 已完成（README.md / README.en.md）。
5. 剩余：用 headless 真实 dsh 跑一次单技能 + 多技能。**当前被环境阻塞**：本地 gateway `127.0.0.1:7863` 未监听，headless 报 `TRANSPORT: Connection error`。gateway 起来后按第 6 节命令复跑；桌面端需完全退出重开才会加载新构建。

### P1（可选）

- `skill_ab`：同一 prompt 带/不带技能各跑一次，比较输出、token、延迟；需要 `ctx.llm`，可作为“这个技能到底有没有用”的答案。
- 如果想做，先读 `docs/subsystems/llm-streaming.md` 的 `ctx.llm.stream()`、`GenerateOptions`、`StreamChunk`。
- 注意：需要选择 provider/model；当前桌面端本地 gateway 可用 `openai-completions` + `cn:deepseek-v4.1-flash`。

### P2（发布）

- ~~`git init` + 本地 commit~~ 已完成：本地 main 两个提交（43f2b1b、publishConfig）。
- ~~推 GitHub~~ 已完成（2026-10-31）：https://github.com/shuxidemosheng/dsh-skill-doctor 公开仓库，
  远端 main = `ab00206`，tag `v0.2.0`，topics 已设置。
- **推送方式的特殊情况**：本机直连 `github.com:443` 不通（直连超时；WorkBuddy 本地代理对 github.com 返回 502），
  但 `api.github.com` 可直连。所以首次推送与后续补推都走 GitHub Git Data API（gh api 建 blob → tree →
  commit → 更新 ref），没有用 `git push`。后果：本地 commit sha 与远端不一致（内容相同），
  `git fetch/push` 仍然会失败，需要代理恢复后用 `git fetch && git reset --hard origin/main` 对齐。
- `npm pack --dry-run` 已检查：43 个文件、70.9 kB，含 `lib/`、`cordis.patch.yml`、两份 README。
- `package.json` 加了 `publishConfig.registry = https://registry.npmjs.org/`（本机默认是 npmmirror 镜像）。
- **npm publish 未做**：本机 `npm whoami` 未登录，需用户本人 `npm login --registry https://registry.npmjs.org/`
  后执行 `npm publish`（2FA/EOTP）。发布后可核验 `npm view dsh-skill-doctor version`。
- Mimosa deep scan 仍未跑。

---

## 8. 工程纪律（必须遵守）

- 默认中文回答；代码/术语/报错保留英文。
- 代码注释按初学者对待，写清原理；但不要写“这行是干嘛”的废话。
- 绝不 `export default`。
- `apply()` 内配置失败 → `warn + return`，绝不阻断会话创建。
- 工具名冲突 → `ctx.tools.get()` 检查，单个让位。
- 只改与当前任务相关的代码，不顺手重构。
- 不主动创建额外文件；交接文档是用户明确要求。
- 不自动 `git push`、不自动 `npm publish`。
- 不要打印/提交任何密钥；测试脚本只从 `~/.dsh/.credentials.yaml` 读取到环境变量。

---

## 9. 常用命令

```bash
cd /d/AIcoding/dsh-skill-doctor
npm install
npm test
npm run build
npm run smoke

# CLI 真实技能
node lib/cli.js "C:/Users/fenghaoyu/.claude/skills"
node lib/cli.js "C:/Users/fenghaoyu/.claude/skills/nature-citation"
node lib/cli.js "C:/Users/fenghaoyu/.claude/skills" --json

# 本地安装到 profile（link 适合开发迭代）
dsh plugin --profile headless add link:D:\AIcoding\dsh-skill-doctor
dsh plugin --profile desktop add link:D:\AIcoding\dsh-skill-doctor
# desktop 安装后需要完全退出并重开桌面端
```

---

## 10. 接手检查清单

- [ ] 读这份 `HANDOFF.md`
- [ ] `npm test` 确认 31 个测试仍通过
- [ ] 按第 2 节把报告改成通俗语言
- [ ] 更新测试断言 + README
- [ ] `npm run build && npm run smoke`
- [ ] 用 `run-dsh-headless.ps1` 跑一次真实 dsh 单技能 + 多技能
- [ ] 确认 desktop profile 是 `link:` 且版本 0.2.0；提醒用户重启桌面端
- [ ] Mimosa 深度扫描
- [ ] 不要 push / publish，除非用户明确要求
