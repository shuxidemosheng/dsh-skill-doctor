<div align="center">

# dsh-skill-doctor

[English](README.en.md) | 中文

**dsh 的技能与插件体检：告诉模型到底看到了什么、插件到底跑起来没、以及下一步该改哪里。**

[![npm version](https://img.shields.io/npm/v/dsh-skill-doctor)](https://www.npmjs.com/package/dsh-skill-doctor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](package.json)
[![dsh](https://img.shields.io/badge/dsh-%E2%89%A50.2.0--rc.2-4176E6.svg)](https://github.com/deepseek-ai/deepseek-harness)

[亮点](#亮点) | [安装](#安装) | [怎么用](#怎么用) | [面板](#面板) | [四个工具](#四个工具) | [规则](#规则) | [命令行](#命令行) | [它做不到什么](#它做不到什么) | [故障排查](#故障排查)

</div>

技能坏了通常是**静默的**：不加载、被同名覆盖、description 超长被截断、正文里引用的文件根本不存在——用户只看到“模型不用它”。

`dsh-skill-doctor` 把这些隐性问题变成可读的报告。它不做技能市场，也不做安全扫描器；它只回答一个问题：**这个东西在 dsh 里到底能不能正常工作？**

## 亮点

- **告诉你模型到底看到了什么。** 不是一句“简介超长”，而是把截断后那段原文**原样贴出来**——你一眼就能看出自己的触发词在不在里面。
- **每条问题都给处方。** 🔧 能自动修 / 🖥 一条命令 / ✍️ 只能人工改，三档分得开，不用猜“然后呢”。
- **判断插件是真跑起来了，还是只是装了。** 读运行时 fiber 阶段，`failed` 的插件会被点名；探测不到时明确说“没查到”，而不是当成没问题。
- **会话里实时看模型在调什么。** 输入框上方常驻一条，模型读了哪个技能、调了哪些工具，一行一条。
- **按根因看，不按个数看。** 13 个技能都“简介超长”，如果它们都叫 `nature-*`，那多半是一套模板的问题——报告会把它聚成一条，告诉你改一次顶 13 次。
- **尺子会过期，报告会说明。** “超过 500 字算长”是 dsh 当时的约定，不是常数。报告会把自己按哪个 dsh 版本校准过写出来；版本对不上时，明确提示阈值可能已过期。
- **CI 里能跑。** `dsh-skill-lint` 不依赖 dsh 运行时，退出码和 `--json` 都准备好了。

## 安装

```bash
dsh plugin --profile <你的profile> add dsh-skill-doctor
```

装的是最新版；想锁定版本就在名字后面加 `@0.7.0`。

装完**完全退出并重开** dsh（面板等客户端代码只在启动时加载）。

装好后直接在会话里说话就行，不需要记工具名：

> 帮我体检一下技能

## 怎么用

三个真实场景，每个都只需要一句话。

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

省略 `name` 就是全体检；`extraRoots` 可以指到 dsh 没收录的目录（比如 `~/.claude/skills`）。

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

配置非法时插件只打一行 warn 并禁用自己，**不会阻断会话创建**。

## 它做不到什么

这几条是能力边界，不是没做：

- **不知道「工具属于哪个插件」。** 工具注册表没有 owner 字段，`schemas()` 能给全量工具名，给不出“谁注册的”。所以“A 和 B 撞名了”只能给疑似，不指名。
- **不知道「插件为什么失败」。** 运行时快照只投影 fiber 阶段，没有错误信息；dsh 也不落盘启动日志，失败只进桌面端 stdout。
- **看不到「完全没被 dsh 收录」的技能。** 名字不合规或文件头坏到解析不了的，压根不在视图里——要用 `extraRoots` 指回目录，让插件直接扫文件才看得到。
- **不判断技能内容写得好不好。** 自动修复只有两条字节级规则，语义问题一律不碰。
- **token 估算是近似值。** ASCII ≈ 4 字符/token，CJK ≈ 0.75 token/字符，不承诺与 provider tokenizer 一致。
- **同名检测只扫配置的 root。** 看不到 registry 内部所有候选，结论标注为“候选”。
- **远端/虚拟技能没有文件级检查。** 没有本地路径，编码和引用规则自动跳过。

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

`skill_doctor` 默认只看 dsh 当前视图。想扫 `~/.claude/skills` 这类 dsh 不收录的目录，要显式给 `extraRoots`，或在会话里说「体检 extraRoots 指向 …」。

**插件体检显示「运行时状态这次没查到」**

这是降级，不是失败：`pluginInventory` 只在桌面端 profile 挂载，headless 模板没有。headless 下这一节永远是降级文案。

**配置写错后工具全没了**

配置非法时插件会自禁用（设计如此，避免坏配置阻断会话）。检查 `cordis.patch.yml` 里 `config` 的字段名和类型，改回合法值重启即可。

## 工作原理

1. `ctx.skills.snapshot({ cwd, scope })` 拿当前视图的获胜技能
2. `ctx.skills.get(name)` 拿完整正文，确认它真的能加载
3. `path` 指向本地文件时，只读地读一遍原始 `SKILL.md`，做 frontmatter/引用/编码检查
4. 远端或虚拟技能没有本地路径，自动跳过文件级规则
5. `extraRoots` 只用于“同名候选”提示；最终以 registry 的合并结果为准

它**不执行**技能里的脚本，**不修改**任何文件（除 CLI 的 `--fix`），**不发送**技能内容到网络。

## 与同类插件的关系

- `dsh-skill-explorer` / `dsh-skills-manager`：浏览、安装、管理技能。本插件是“体检”，可以一起用。
- 安全类技能扫描器：本插件不抢安全定位，SD012 只是启发式提示。

## 路线图

- ✅ 处方分级（能自动修 / 一条命令 / 只能人工）
- ✅ 插件运行时体检（fiber 阶段 + 工具注册表交叉）
- ✅ 会话内活动面板
- ⬜ 规则文档站与 capability registry
- ⬜ `skill_ab`：同一 prompt 带/不带技能各跑一次，比较 token、延迟和输出

## 开发

```bash
npm install
npm run build     # tsc + esbuild（host / cli / client 三份产物）
npm test          # 95 个用例
npm run smoke     # 真 loader 冒烟
npm run e2e       # 真实 dsh headless 跑 A 组
```

客户端面板改动后要 `npm run build` 再重启 dsh；`tests/client-bundle.spec.ts` 会验证 bundle 外壳、导出和槽位注册，但视觉效果只能肉眼验。

## License

MIT
