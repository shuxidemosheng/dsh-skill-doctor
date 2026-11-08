<div align="center">

# dsh-skill-doctor

[English](README.en.md) | 中文

**dsh 的技能与插件体检：告诉模型到底看到了什么、插件到底跑起来没、以及下一步该改哪里。**

[![npm version](https://img.shields.io/npm/v/dsh-skill-doctor)](https://www.npmjs.com/package/dsh-skill-doctor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](package.json)
[![dsh](https://img.shields.io/badge/dsh-%E2%89%A50.2.0--rc.2-4176E6.svg)](https://github.com/deepseek-ai/deepseek-harness)

[亮点](#亮点) | [安装](#安装) | [怎么用](#怎么用) | [面板](#面板) | [四个工具](#四个工具) | [规则](#规则) | [命令行](#命令行) | [外部技能挂载](#外部技能挂载可选第二组件) | [它做不到什么](#它做不到什么) | [故障排查](#故障排查)

</div>

技能坏了通常是**静默的**：不加载、被同名覆盖、description 超长被截断、正文里引用的文件根本不存在——用户只看到“模型不用它”。

`dsh-skill-doctor` 把这些隐性问题变成可读的报告。它不做技能市场，也不做安全扫描器；它只回答一个问题：**这个东西在 dsh 里到底能不能正常工作？**

## 亮点

- **告诉你模型到底看到了什么。** 不是一句“简介超长”，而是把截断后那段原文**原样贴出来**——你一眼就能看出自己的触发词在不在里面。
- **每条问题都给处方。** 🔧 能自动修 / 🖥 一条命令 / ✍️ 只能人工改，三档分得开，不用猜“然后呢”。简介截断还能直接出**改写工单**（触发词骨架 + 字数预算），模型填稿、你确认后写入——诊断到修复不再断链。
- **判断插件是真跑起来了，还是只是装了。** 读运行时 fiber 阶段，`failed` 的插件会被点名；探测不到时明确说“没查到”，而不是当成没问题。
- **会诊：技能和插件交叉看。** “0 个技能”未必是技能坏了——插件报告列出所有动了技能链路的 patch（谁 → 哪个条目 → 哪个键），技能报告在空手而归时反向指向插件层。
- **输入框里就能用，不经过模型。** 打 `/` 有一组中文条目（体检 / 查目录 / 改写 / 复诊 / 诊断 / 会诊），选中即是蓝色 chip，回车直接出结果——快，也不会被模型转述改写。面板上那六个按钮写的是同一组命令。
- **会话里实时看模型在调什么。** 输入框上方常驻一条，模型读了哪个技能、调了哪些工具，一行一条。
- **有病历，能复诊。** 修完 11 个超长简介后再跑一次，报告不该还是一堆“还有 2 个超长”——对照上次存档，它告诉你“好了 11 个、新冒出来 1 个”。默认就开着，不用配置。
- **知道哪些技能模型从来不用。** 面板的「使用统计」按加载次数排行，跨会话累计——静态检查给不出的动态证据。
- **按根因看，不按个数看。** 13 个技能都“简介超长”，如果它们都叫 `nature-*`，那多半是一套模板的问题——报告会把它聚成一条，告诉你改一次顶 13 次。
- **尺子会过期，报告会说明。** “超过 500 字算长”是 dsh 当时的约定，不是常数。报告会把自己按哪个 dsh 版本校准过写出来；版本对不上时，明确提示阈值可能已过期。
- **一个插件，两行组件，可分别开关。** 第二行把 Claude Code / Codex / ZCode 的技能目录挂进 dsh，插件页上独立开关；关掉它不影响体检。诊断仍是主线，挂载是可选的附加能力。
- **CI 里能跑。** `dsh-skill-lint` 不依赖 dsh 运行时，退出码和 `--json` 都准备好了。

## 安装

```bash
dsh plugin --profile <你的profile> add dsh-skill-doctor
```

装的是最新版；想锁定版本就在名字后面加版本号，例如 `@0.14.0`。

0.14.0 起插件页会显示**两个组件行**（体检 / 外部技能挂载），可以分别开关；第二行默认把三家外部技能挂进 dsh，不想要就在插件页关掉，见[外部技能挂载](#外部技能挂载可选第二组件)。

装完**完全退出并重开** dsh（面板等客户端代码只在启动时加载）。

装好后直接在会话里说话就行，不需要记工具名：

> 帮我体检一下技能

## 怎么用

**最快的是斜杠命令**：输入框打 `/`，选一条（菜单是中文的），补上路径或技能名回车——由插件在本地算，不经过模型。下面三个场景则适合直接说话，让模型挑工具。

**「我怀疑某个技能没生效」**

> 解释一下 nature-citation 为什么可能没被模型用上

得到的是：模型实际读到的那 500 字原文 + 被切掉的触发说法 + 影响大不大 + 怎么改。

**「我怀疑某个插件没跑起来」**

> 查一下 desktop profile 的插件有没有冲突

磁盘层面查条目互抢、重复安装、装了没启用；运行时层面查 fiber 阶段，`failed` 的直接点名。

**「我想知道模型刚才在干什么」**

看输入框上方那条面板，或者点开看完整调用流。

## 面板

会话输入框上方常驻一条，点开是本次会话的调用流：

```
🩺 技能医生 · 读入技能 nature-citation      3 技能 · 1 插件 · 12 工具
```

```
🩺 技能医生 · 活动                    3 技能 · 1 插件 · 12 工具   ✕
──────────────────────────────────────────────────────
→ 读入技能 nature-citation
✓ skill_doctor · 29 个技能                        本插件
✓ read · HANDOFF.md
● grep · TODO                                     执行中
──────────────────────────────────────────────────────
只显示最近 20 条。工具属于哪个插件 dsh 没有暴露，只能显示工具名。
```

- **→** 技能加载：模型通过 `skill` 工具读技能，参数里带名字，所以能精确显示读的是哪个
- **绿色 + 「本插件」** 调用本插件自己的工具时标出来
- **●** 还没拿到结果，**✓** 已完成
- 右侧是本次会话累计：技能 / 插件 / 工具各多少次

面板读的是会话当前窗口，**滚出窗口的更早调用看不到**；见过的会攒住，所以累计数字不会倒退。底部写明了这一点。

浮层顶部有「功能 / 活动 / 使用统计」三个标签页。**功能页是入口**：六个按钮（体检全部、只看目录、改写工单、复诊对比、诊断一个、插件会诊），点一下高亮，并把对应的 `/命令 ` 送进输入框——补上路径或技能名回车即可，不用记提示词，也不用记命令名。拿不到输入框权限时自动退化为复制到剪贴板，并在页面上直说。**使用统计是跨会话的**：每个技能被读进上下文的次数、最近使用日期、覆盖的会话数——按加载次数排行的“哪些技能模型从来不用”就是诊断的动态证据。数据只存在本机浏览器存储（localStorage），不上传、不进技能文件，面板里可一键清空；模型直接 `read` 技能文件不计——读不到归属，宁可少记不记错。

## 斜杠命令（客户端最顺手的入口）

装好就有六条命令。输入框打 `/` 会看到一组中文条目，选中即变成蓝色 chip，后面直接写参数、回车出结果——**全程不经过模型**：

| 菜单 | 输入框 | 作用 |
|---|---|---|
| 体检 | `/doctor` | 检查全部技能，看有没有坏、模型能否看到，并把同类问题合并 |
| 查目录 | `/scope <目录>` | 只检查你指定的目录，不看别处 |
| 改写 | `/rewrite <技能名>` | 给简介超长的技能出改写稿，附字数预算和被切掉的触发词 |
| 复诊 | `/followup` | 和上次体检对比，看哪些修好了、哪些又变差了 |
| 诊断 | `/why <技能名>` | 查一个技能为什么没被模型选中，给出具体原因和改法 |
| 会诊 | `/clash` | 检查有没有插件改坏了技能目录配置，导致技能突然消失 |

输出是纯文本（会话流里的一个节点，不渲染 Markdown 表格），所以只写"先看什么"：

```text
技能体检 · 4 个技能（只查 D://skills）
⛔ 用不了 0 · ⚠️ 影响大 3 · 💡 影响小 0 · 💡 其他 0 · ✅ 正常 1

共性问题（先改这里最划算）
· 简介太长，后半段模型看不到：3 个（占 75%）；名字都以 nature- 开头，多半同一套模板

模型看不到部分触发说法（3 个）
· nature-alpha（565 字）被切掉：分段引用、自动给出引用
```

想要带处方的完整报告，仍然在会话里说「体检技能」让模型跑 `skill_doctor`——两条路读的是同一套扫描逻辑。

**为什么菜单是中文、输入框是 ASCII**：菜单那一列由插件提供，没有字符集限制；输入框里把文本渲染成 chip 走的是 dsh 的 `TEXT_REF_RE = /(^|\s)([/@])([\w-]+)/g`，**JS 的 `\w` 只有 `[A-Za-z0-9_]`**，中文名永远匹配不上。所以「中文名 + 蓝色 chip」在当前 dsh 上互斥，这里选了保住 chip。这些 token 由插件注册的**引用源**（`ctx.inputTriggers.registerSource`，技能的 `/名字` 用的就是它）提供，提交时原样交给命令执行。

面板上六个按钮写的就是这六个 token：点「复诊对比」= 输入框出现 `/followup `，补完参数回车即可。

> 如果哪天 dsh 把上面那条正则放宽到 `\p{L}`，把 `src/source.ts` 里候选的 `token` 换成中文即可，其余逻辑不用动。

## 四个工具

| 工具 | 一句话 | 什么时候用 |
|---|---|---|
| `skill_doctor` | 技能体检，结论优先 | 默认先用它 |
| `skill_lint` | 逐条规则，技术口径 | CI、想按规则 ID 排查 |
| `skill_explain` | 解释单个技能为什么不生效 | 已经锁定是哪个技能 |
| `plugin_doctor` | 插件装得对不对 + 跑起来没 | 工具突然不见了 |

### `skill_doctor`

```json
{ "name": "nature-citation" }
```

省略 `name` 就是全体检。范围参数有两种，语义不同：

- `roots`：**只查这些**目录（或直接给某个 `SKILL.md`）。用户点名目录时必须用它，报告开头会写「本次只检查了指定范围」。
- `extraRoots`：在会话可见技能之外**追加**（查同名遮蔽时用），原有技能仍在报告里。

加 `"rewrite": true` 进入**改写工单模式**：不带 `name` 时给所有简介被截断的技能出工单（同前缀的归成模板组，写一份模板 + 各自变量段）；带 `name` 出单技能工单。工单 = 硬约束 + 模型可见/被切原文 + 提取的触发说法 + 确定性骨架——模型填稿、**用户确认后**才写入，写完重跑体检用复诊对比验证闭环。

工单确认之后，写入有两个参数（都必须带 `name`，批量写入不开放，避免一次误改一堆文件）：

```json
{ "name": "nature-citation", "setDescription": "你确认过的那段简介" }
{ "name": "demo-skill", "fix": true }
```

- `setDescription`：只替换 frontmatter 里 description 那一行（JSON 双引号标量，引号/冒号/`#` 安全转义，其余字节与换行符原样保留），写前 `.bak`、写后复验失败自动回滚；块标量写法会明确拒绝，请手动改。**工具不生成也不改写文案**，写的就是你给的那段。
- `fix: true`：只跑可自动修的规则（BOM / CRLF），plan → apply → 复验（重扫、错误数不得变多），失败回滚。

输出顺序固定为「结论 → 证据 → 处方」：

- **结论**：一句话说清能不能用
- **摘要表**：技能、简介长度、截断影响、建议动作
- **模型看到的信息**：模型实际读到的简介**原文**（截到上限为止，不做二次摘要）
- **被切掉的部分**：截断位置 + 被切掉的触发说法 + 影响大/小
- **需要处理的问题**：每条都是「现在什么情况 + 处方」，不写规则名
- **技术细节（可跳过）**：provider、model-invocable、规则 ID 集中在最后

### `skill_lint`

逐条规则的 verbose 模式，规则 ID 直接写在每条前面，按「需要修复 / 描述被截断 / 其他提示 / 正常」分组。

| 参数 | 说明 |
|---|---|
| `name?` | 只查一个技能；省略则查全部 |
| `provider?` | 只看某个 provider |
| `rules?` | 只跑指定规则，例如 `["SD003","SD004"]` |
| `severity?` | `info` / `warn` / `error`，默认跟随配置 |
| `extraRoots?` | 额外扫描的根目录，用于发现同名遮蔽 |
| `format?` | `markdown`（默认）或 `json` |

### `skill_explain`

解释一个技能为什么没出现、没被模型选中、或加载失败：最终获胜的 provider/path、是否 model-invocable、description 长度、`ctx.skills.get` 是否真能加载、同名候选。

### `plugin_doctor`

```json
{ "profile": "desktop" }
```

**磁盘侧**读 profile 的 `package.json` 和每个插件的 `cordis.patch.yml`：

| ID | 级别 | 检查 |
|---|---|---|
| PL001 | warn | 同一个插件在 `dsh.profile.bundles` 里出现多次 |
| PL002 | warn | 两个插件各自 `insert` 同一条目 id（只有一个生效） |
| PL003 | warn | 两个插件改同一条目（后加载的覆盖前面的） |
| PL004 | error/info | 启用了但包不在 / 装了但没启用 |
| PL006 | warn | 插件动了技能链路：禁用技能条目、或关掉默认技能根又不给替代目录 |

**会诊：技能 × 插件交叉。** `skill_doctor` 管技能、`plugin_doctor` 管插件，但真实的故障经常跨两层——
某个插件的 patch 把技能目录改了，技能报告只会显示"0 个技能"，看起来像技能坏了。插件报告的
「会诊」章节把所有会改变"会话里能看到哪些技能"的插件层改动（谁 → 哪个条目 → 哪个键 → 什么值）
摆到一张桌子上；反过来，技能报告在"0 个技能"时也会指向插件层。一个入口、一次交叉判断。

**运行时侧**软探测 `pluginInventory` 拿 fiber 阶段，同时用 `ctx.tools.schemas(exec.agent)` 取当前会话真实的工具列表：

| 证据 | 强度 | 报告怎么说 |
|---|---|---|
| 启用了但 `fiberPhase` 是 `failed` | 确定 | ⛔ 点名，它注册的工具不会出现 |
| 服务不存在 / 超时 | — | 明写“这次没查到”，并强调**这不等于没问题** |
| 本插件工具不在列表里 | 中等 | 💡 并列两种可能：被同名工具占了，或被 agent scope 隐藏 |

`pluginInventory` 只在**桌面端 profile** 挂载，headless 下这一节必然是降级文案。

## 报告长什么样

单技能体检的第一屏（完整报告见下方折叠）：

```text
# 技能体检：`nature-citation`

**结论：能用，但模型只能看到简介的前 500 字；被切掉的正好是你平时叫它用的那些说法。**

| 项目 | 情况 |
|---|---|
| 技能 | `nature-citation` |
| 简介 | 956 字，模型可见前 500 字 |
| 截断影响 | 大（6 个触发说法看不到） |
| 建议动作 | 把触发词移到简介前 500 字以内 |
```

<details>
<summary>展开完整报告（模型看到的信息 / 被切掉的部分 / 处方 / 技术细节）</summary>

```text
## 模型看到的信息

**简介**（模型靠它决定“要不要用这个技能”）：

> Add strict Nature/CNS citations to manuscript text by splitting long passages into
> citable segments, searching only accepted flagship and subjournal titles from Nature
> Portfolio, the AAAS Science family, and Cell Press, filtering by publication time
> range, and exporting one reference-manager-ready output …

共 956 字；模型只能看到前 500 字，剩下 456 字它看不到。
- 模型能自己想到用它：能
- 你能用 `/nature-citation` 手动调用：能
- 正文：3607 字（模型决定用它之后会读全文）

## 被切掉的部分（模型看不到）

> text-to-reference correspondence, "分段引用", "自动给出引用", "Nature系列引用", …

里面有几处“什么时候该用它”的说法，模型完全收不到：

- “分段引用”
- “自动给出引用”
- “Nature系列引用”
- “CNS及子刊”
- “支撑文献”
- “补引用”

**影响：大。** 你平时大概就是这么说的话；模型看不到这些词，就不会主动用这个技能。

### 怎么改

把这些说法提到简介开头（前 500 字以内）。例如在开头加一句：

> 当用户说「分段引用」「自动给出引用」时使用本技能。

改完再跑一次 `skill_doctor`：这里变成“影响不大”，就说明模型能看到了。

## 需要处理的问题

没有别的问题。按上面的方法把触发词提到开头就行。

---

## 技术细节（可跳过）

- 来源：本地文件（provider: filesystem / source: custom）
- 位置：~/.claude/skills/nature-citation/SKILL.md
- 模型能不能自动用（model-invocable）：能
- 能不能用 `/nature-citation` 手动调用（user-invocable）：能
- 简介长度（description）：956 字 / 上限 500
- 阈值校准基线：dsh 0.2.1-rc.2，与当前 dsh 0.2.1-rc.2 一致
- 命中规则：SD004（warn）
```

</details>

多技能体检会先给一组“共性问题”——同一条规则命中很多技能时，通常只有一个根因：

```text
## 共性问题（1 组，先改这里最划算）

同一条规则命中很多技能，通常只有一个根因。按根因看，比按技能逐个看省事：

- **简介太长，后半段模型看不到**（SD004）—— 4 个技能，占 80%
  - 命中：`nature-doc`、`nature-pdf`、`nature-ppt`、`nature-xlsx`
  - 根因推测：4 个技能全部以 `nature-` 开头，大概率出自同一套模板——改模板比逐个改省事得多。
  - 怎么改：把 `nature-` 这套模板里的简介改短（前 500 字说完“什么时候用”），改一次顶 4 次。
```

## 规则

15 条技能规则，全部可以逐条开关或改级别：

| ID | 级别 | 检查 |
|---|---|---|
| SD001 | error | frontmatter 缺失或无法解析 |
| SD002 | error | 技能名不合法（kebab-case）或与目录名不一致 |
| SD003 | error | description 缺失 |
| SD004 | warn | description 超过目录上限（默认 500） |
| SD005 | warn | description 过短/过于笼统 |
| SD006 | error | 正文为空，或只有标题/分隔线 |
| SD007 | warn | 正文 token 估算超过预算（默认 8000） |
| SD008 | warn | `references/`、`scripts/`、`assets/` 引用不存在 |
| SD009 | warn | 多 root/provider 同名技能，可能被遮蔽 |
| SD010 | warn | invocation 字段不是布尔值（含 legacy camelCase） |
| SD011 | info | 技能名过长（>64） |
| SD012 | warn | 可疑指令启发式：忽略前置指令、外传凭证、隐藏 Unicode、长 base64 |
| SD013 | info | 文件带 UTF-8 BOM |
| SD014 | info | 文件使用 CRLF |
| SD015 | warn | 资源引用包含路径穿越 |

> SD012 只是启发式：命中不等于恶意，需要人工复核。它不替代安全审查。

## 命令行

插件同时提供 `dsh-skill-lint`，**不需要 dsh 运行时**：

```bash
# 扫描当前项目 / 单个技能 / 外部目录
npx --package dsh-skill-doctor dsh-skill-lint .
npx --package dsh-skill-doctor dsh-skill-lint ./skills/code-review
npx --package dsh-skill-doctor dsh-skill-lint ~/.claude/skills

# CI：JSON + warn 也失败
npx --package dsh-skill-doctor dsh-skill-lint . --json --warn-as-error

# 插件体检（直接读 profile 目录，不需要 dsh 运行时）
npx --package dsh-skill-doctor dsh-skill-lint --plugins --profile desktop
```

### 自动修复

只修**改法唯一**的问题，默认只出计划、不写盘：

```bash
npx --package dsh-skill-doctor dsh-skill-lint ~/.claude/skills --fix          # 只看计划
npx --package dsh-skill-doctor dsh-skill-lint ~/.claude/skills --fix --apply  # 真写
npx --package dsh-skill-doctor dsh-skill-lint . --fix --only SD013            # 只修一条
```

能自动修的就两条：**SD013 BOM**（删掉开头 3 个字节）、**SD014 CRLF**（`\r\n` → `\n`）。

写入前在同目录留一份 `<文件>.bak`，写完立刻按同一份配置复验；复验发现新错误就用备份还原并如实报出来。`--apply` 单独使用会直接报错退出，防手滑。

**刻意不修的**：简介怎么重写、同名技能留哪一个、可疑指令要不要删——这些没有唯一答案，自动改等于替你猜意图。报告末尾会列出“命中了但没动”的规则和原因。

退出码：`0` 通过，`1` 有 error（或 `--warn-as-error` 时存在 warn），`2` 参数/读取错误。

GitHub Actions：

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 24
- run: npx --package dsh-skill-doctor dsh-skill-lint ./skills --warn-as-error
```

## 配置

在 bundle 行上配置：

```yaml
- insert:
    - id: skill-doctor
      name: dsh-skill-doctor
      config:
        maxDescriptionLength: 500
        maxBodyTokens: 8000
        extraRoots:
          - ~/.claude/skills
          - ~/.codex/skills
        rules:
          SD012: info        # 只提示，不吓人
          SD014: 'off'       # 关掉 CRLF 提示
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `maxDescriptionLength` | `500` | 与 dsh 模型目录的 description 上限对齐 |
| `maxBodyTokens` | `8000` | 正文 token 估算预算 |
| `maxFileBytes` | `1048576` | 单文件读取上限 |
| `extraRoots` | `[]` | 额外扫描的技能根；外部目录默认不读 |
| `rules` | `{}` | 规则级覆盖：`off` / `info` / `warn` / `error` |
| `severityThreshold` | `info` | 输出过滤级别 |
| `includeProviders` | `[]` | 只检查这些 provider |
| `excludeProviders` | `[]` | 跳过这些 provider |
| `baseline` | `auto`（默认开启） | 病历：`auto` 按 profile 自动维护；`off` 关闭；或指定文件路径（支持 `~`）。默认即带「复诊对比」，无需配置 |

配置非法时插件只打一行 warn 并禁用自己，**不会阻断会话创建**。

## 外部技能挂载（可选第二组件）

0.14.0 起这个包在插件页显示**两行组件**，每行有自己的 `config` 和开关：

| 组件行 | 模块 | 做什么 |
|---|---|---|
| `skill-doctor` | `dsh-skill-doctor` | 四个体检工具、斜杠命令、面板（只读诊断） |
| `skill-doctor-compat` | `dsh-skill-doctor/compat` | 把 Claude Code / Codex / ZCode 的技能目录挂进 dsh 的技能视图 |

关掉第二行只卸载 provider，体检照常跑。底层原因：dsh 的一行组件就是 `cordis.patch.yml` 里 `- insert:` 下的一个子项，行开关作用于整行的 fiber（卸载/挂载）。两类能力写进同一个 `apply()` 就只能一起开、一起关，所以拆成了两个模块入口，通过 `package.json` 的 `exports["./compat"]` 暴露。

**默认行为**：patch 里三家来源都写成 `true`，装上即挂载；目录不存在时静默跳过。dsh 原生技能同名时永远优先（rank 100/400 < 导入的 210–470），项目级导入压过用户级导入。

```yaml
- insert:
    - id: skill-doctor
      name: dsh-skill-doctor
      config:
        maxDescriptionLength: 500
    - id: skill-doctor-compat
      name: dsh-skill-doctor/compat
      config:
        sources:
          claude: true
          codex: false
          zcode: false
```

第二行可用字段（未知键 fail-fast 报错，插件只打一行 warn 并自行禁用，**不阻断会话创建**）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `sources` | 三家全开 | `claude` / `codex` / `zcode`；写 `false` 关闭，也可写对象 `{ enabled, project, root, rank }` |
| `extraDirs` | `[]` | 追加任意目录：`{ path, label?, rank? }` |
| `providerName` | `skill-doctor-compat` | provider 名，避免与单独安装的 `dsh-skill-compat-plus` 撞名 |
| `slugifyNames` | `true` | 外来名不合 dsh 的 kebab-case 时自动转换；关掉则跳过该技能 |
| `synthesizeDescription` | `true` | Claude 允许缺省 description，此时从正文首个非空行合成 |

导入时做字段映射：`when_to_use` / `whenToUse` → `whenToUse`，`disable-model-invocation`、`user-invocable` 按语义折算；`allowed-tools`、`model`、`hooks` 这类 dsh 无对应物的字段留在 metadata 里。技能正文仍按需从原文件读取，不复制。

**四条边界，装前先看：**

- **不带热更新。** `list()` 结果由 registry 按 revision 缓存，改了 `SKILL.md` 要重启 dsh 才重新发现（`get()` 仍每次读当前文件）。这是最小移植砍掉 `chokidar` 换来的，代价是**零新增运行时依赖**。
- **只读发现，不做管理。** 不安装、不删除、不改写外来技能文件，也不执行技能里的脚本。
- **导入技能也会被体检。** `SD002`（kebab-case 名）、`SD004`（500 字截断）是 dsh 的约定、不是通用标准，外来技能容易刷出误报。只想看原生技能，在第一行加 `excludeProviders: [skill-doctor-compat]`。
- **和 `extraRoots` 不是一回事。** `extraRoots` 是体检时临时扫一遍文件（一次性、只影响报告）；`compat` 是运行时把技能挂进模型能看到的目录（长期生效）。两者可以都不开。

> `name: dsh-skill-doctor/compat` 这种第三方包子路径目前只在 Node 的 `exports` 自引用与 YAML 结构上验证过，**尚未在真实 dsh loader 里跑过 e2e**。如果第二行显示异常，先看 devtools 里的加载报错。

## 病历与复诊

体检一次不难，难的是知道“这次比上次好还是坏”。两种用法：

**默认就开着，不需要任何配置**：每次体检自动存病历、自动和上次对比——第一次建档时报告会说明，从第二次开始自带「复诊对比」。病历按 profile 分文件存在 `~/.dsh/skill-doctor/` 下，是你自己的数据目录，几 KB。

不想要就显式关掉（唯一会写病历的功能随之停用）：

```yaml
config:
  baseline: off    # 也可以写具体文件路径，自己管文件
```

**CLI 手动（CI / 想自己管文件）**：

```bash
# 第一次：体检 + 存病历
dsh-skill-lint ~/.claude/skills --save skill-doctor-baseline.json

# 修完之后：复诊，报告里多一节「复诊对比」
dsh-skill-lint ~/.claude/skills --compare skill-doctor-baseline.json

# 确认没问题后，把新状态存成下一份病历（一条命令完成“对比 + 存档”）
dsh-skill-lint ~/.claude/skills --compare skill-doctor-baseline.json --save skill-doctor-baseline.json
```

复诊对比按规则聚合，跟聚类同一个哲学——按根因看，不按个数看：

```text
## 复诊对比

对照上次的病历 `skill-doctor-baseline.json`（2026-10-31 存档），按规则看差值：

- ✅ 好转：简介太长，后半段模型看不到 4 → 2；简介太短或太笼统 1 → 0
- ⚠️ 变差：正文里提到的文件找不到 0 → 1（`new-report`）
- 🆕 这次新扫到：`new-report`
- 🗑 上次有、这次不在：`other-pdf`（改名或删了？）

整体：问题总数 5 → 3。
```

- 病历是普通 JSON，可以提交进仓库；CI 里 `--compare --json` 之后读 `comparison.regressed`，非空就挂门禁。
- 口径要一致：病历会记下当时的 `severityThreshold` 与启用的规则集，口径不同时报告会明确提示“数字不可直接比”，而不是硬比。
- **写入只有三条路径，全部带备份与复验**：① `baseline` 配置后写自己的病历 JSON；② `skill_doctor { name, setDescription }` 在用户确认草稿后写入 description 那一行；③ `skill_doctor { name, fix: true }` 做字节级的 BOM/CRLF 修复。工具不会自己生成或改写文案，也不碰语义内容。
- **同一条写入在终端也有确定性命令**：`dsh-skill-lint --set-description <技能名> --from <草稿文件>`（加 `--apply` 才落盘）与 `--fix --apply`。两者共用同一套实现（YAML 安全转义、保留其余内容与换行符、`.bak`、复验失败自动回滚），客户端里不必开终端。

## 它做不到什么

这几条是能力边界，不是没做：

- **不知道「工具属于哪个插件」。** 工具注册表没有 owner 字段，`schemas()` 能给全量工具名，给不出“谁注册的”。所以“A 和 B 撞名了”只能给疑似，不指名。
- **不知道「插件为什么失败」。** 运行时快照只投影 fiber 阶段，没有错误信息；dsh 也不落盘启动日志，失败只进桌面端 stdout。
- **看不到「完全没被 dsh 收录」的技能。** 名字不合规或文件头坏到解析不了的，压根不在视图里——要用 `roots` 指向那个目录，让插件直接扫文件才看得到。
- **不判断技能内容写得好不好。** 自动修复只有 BOM / CRLF 两条字节级规则；简介改写只出工单、由模型填稿、你确认后才写入，插件自己不生成文案。
- **token 估算是近似值。** ASCII ≈ 4 字符/token，CJK ≈ 0.75 token/字符，不承诺与 provider tokenizer 一致。
- **同名检测只扫配置的 root。** 看不到 registry 内部所有候选，结论标注为“候选”。
- **远端/虚拟技能没有文件级检查。** 没有本地路径，编码和引用规则自动跳过。
- **外部技能挂载不监听文件变化。** 第二行不带 watcher，改了 `SKILL.md` 要重启 dsh；它也不做字段之外的语义转换，外来技能不合 dsh 命名规则时只能 slug 化或跳过。
- **不判断外来技能合不合原 agent 的规矩。** 体检用的是 dsh 的规则（SD001–SD015），对 Claude / Codex 的技能只能给出"在 dsh 里会怎样"，不代表它在原工具里有问题。

## 故障排查

**工具完全没出现**

先确认插件真的进了 profile：

```bash
dsh plugin --profile <你的profile> list
```

在列表里就看工具名冲突——四个工具里少了某一个，说明被别的插件抢先注册，本插件会主动让位（日志里有一行 `already registered — skipping it`）。

**面板没出现，但工具正常**

1. 确认是**完全退出**重开，不是关窗口（托盘退出，或确认进程清空）
2. 打开开发者工具看控制台，`dsh-skill-doctor` 相关报错会写明原因
3. 条在但永远显示「还没有工具调用」→ 是会话 props 没注入，不是面板没加载

**报告里技能数是 0 或偏少**

`skill_doctor` 默认只看 dsh 当前视图。想只扫 `~/.claude/skills` 这类 dsh 不收录的目录，给 `roots`（限定范围），或在会话里说「只体检 D://skills 这个目录，别的地方不要看」。

**插件体检显示「运行时状态这次没查到」**

这是降级，不是失败：`pluginInventory` 只在桌面端 profile 挂载，headless 模板没有。headless 下这一节永远是降级文案。

**配置写错后工具全没了**

配置非法时插件会自禁用（设计如此，避免坏配置阻断会话）。检查 `cordis.patch.yml` 里 `config` 的字段名和类型，改回合法值重启即可。

## 工作原理

1. `ctx.skills.snapshot({ cwd, scope })` 拿当前视图的获胜技能
2. `ctx.skills.get(name)` 拿完整正文，确认它真的能加载
3. `path` 指向本地文件时，只读地读一遍原始 `SKILL.md`，做 frontmatter/引用/编码检查
4. 远端或虚拟技能没有本地路径，自动跳过文件级规则
5. 范围参数分两种：`roots` **限定**只查这些目录（用户点名目录时用），`extraRoots` 在会话技能之外**追加**（查同名遮蔽时用）
6. 文件级检查一律只读；写入只有三条显式路径（`baseline` 的病历 JSON、`setDescription` 写用户确认过的那一行、`fix` 修 BOM/CRLF），全部带 `.bak` 与复验回滚
7. 第二组件行是独立模块（`src/compat-entry.ts`），`apply()` 里只做 `ctx.skills.registerProvider()`；它只读地发现外来技能，不参与上面任何一条写入路径

它**不执行**技能里的脚本，**不自动改写**文案或语义，**不发送**技能内容到网络。

## 与同类插件的关系

生态里和技能沾边的插件大致三类，回答的问题不同，可以一起装：

- **管理类**（浏览、搜索、导入导出、删除技能）：回答"技能在哪、怎么增删"。
- **统计类**（技能使用记分板、被调用次数排行）：回答"用了多少"。本插件的面板也统计加载次数，但用途是"给诊断补动态证据"，不做长期看板。
- **插件审计类**（生态评分、路由鉴权、安装前试装门控）：回答"这个插件安不安全、能不能装"。

本插件回答的是**"为什么坏了 / 为什么模型不选它"**——诊断方向。安全类检测只有 SD012 一条启发式提示，不抢安全定位；安装前门控也不做（那是 precheck 类插件的地盘）。

0.14.0 起的第二组件把「挂载外部技能目录」也纳入了这个包，但它只做只读发现，仍不做浏览、增删、导入导出、技能市场或热更新；已单独装了 `dsh-skill-compat-plus` 的话，两边 provider 可共存（默认名不同）。

## 路线图

- ✅ 处方分级（能自动修 / 一条命令 / 只能人工）
- ✅ 插件运行时体检（fiber 阶段 + 工具注册表交叉）
- ✅ 会话内活动面板 + 跨会话使用统计
- ✅ 病历与复诊（`baseline: auto`，默认开启）
- ✅ 按根因聚类、规则阈值版本校准
- ✅ 技能 × 插件会诊（`PL006`）
- ✅ 改写工单 + 确认后写入（`setDescription`）
- ✅ 目录范围参数、斜杠命令与中文菜单
- ✅ 双组件行：体检 + 可选外部技能挂载（`./compat` 子路径导出，零新增依赖）
- ⬜ 规则文档站与 capability registry
- ⬜ `skill_ab`：同一 prompt 带/不带技能各跑一次，比较 token、延迟和输出

## 开发

```bash
npm install
npm run build     # tsc + esbuild（host / cli / client / compat 四份产物）
npm test          # 242 个用例
npm run smoke     # 真 loader 冒烟
npm run e2e:all   # 真实 dsh headless，全组
```

客户端面板改动后要 `npm run build` 再重启 dsh；`tests/client-bundle.spec.ts` 会验证 bundle 外壳、导出和槽位注册，但视觉效果只能肉眼验。

## License

MIT
