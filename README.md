<div align="center">

# dsh-skill-doctor

[English](README.en.md) | 中文

**给 dsh 的技能做体检：能不能加载、为什么没生效、描述/体积/引用是否合规。**

[![npm version](https://img.shields.io/npm/v/dsh-skill-doctor)](https://www.npmjs.com/package/dsh-skill-doctor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](package.json)
[![dsh](https://img.shields.io/badge/dsh-%E2%89%A50.2.0--rc.2-4176E6.svg)](https://github.com/deepseek-ai/deepseek-harness)

</div>

技能坏了通常是**静默的**：不加载、被同名覆盖、description 超长被截断、正文里引用的文件根本不存在——用户只看到“模型不用它”。`dsh-skill-doctor` 把这些隐性问题变成可读的报告。

它不做技能市场，也不做安全扫描器；它只回答一个问题：**这个技能在 dsh 里到底能不能正常工作？**

## 快速开始

```bash
dsh plugin --profile <你的profile> add dsh-skill-doctor@0.3.0
```

装完重启（或等 HMR）。然后直接在会话里说：

> 帮我体检一下当前项目里的技能

模型会调用 `skill_doctor`，给出分组结论；如果只想查某一个技能：

> 解释一下 nature-citation 这个技能为什么可能没生效

模型会调用 `skill_doctor({ name })`。第一屏就是人话结论，不需要懂 dsh 内部概念：

```text
# 技能体检：`nature-citation`

**结论：能用，但模型只能看到简介的前 500 字；被切掉的正好是你平时叫它用的那些说法。**

## 模型看到的信息

- 简介（模型靠它决定“要不要用这个技能”）：
  > Add strict Nature/CNS citations to manuscript text by splitting long passages into …

  共 956 字；模型只能看到前 500 字，剩下 456 字它看不到。

## 被切掉的部分（模型看不到）

> text-to-reference correspondence, "分段引用", "自动给出引用", "Nature系列引用", …

里面有几处“什么时候该用它”的说法，模型完全收不到：

- “分段引用”
- “自动给出引用”

**影响：大。** 你平时大概就是这么说的话；模型看不到这些词，就不会主动用这个技能。

### 怎么改

把这些说法提到简介开头（前 500 字以内）。例如在开头加一句：

> 当用户说「分段引用」「自动给出引用」时使用本技能。
```

报告末尾另有一段 **“技术细节（可跳过）”**，放 provider、model-invocable、规则 ID 这些字段；不想要人话版时，用 `format: 'json'` 或 `skill_lint` 拿逐条规则的技术输出。

## 检查什么

| ID | 级别 | 检查 |
|---|---|---|
| SD001 | error | frontmatter 缺失/无法解析 |
| SD002 | error/warn | name 不是 kebab-case（error）；与目录名不一致（warn，dsh 使用 frontmatter.name） |
| SD003 | error | description 缺失/为空 |
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

规则可以逐条开关或改级别：

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
          - ~/.zcode/skills
        rules:
          SD012: info        # 只提示，不吓人
          SD014: 'off'       # 关掉 CRLF 提示
```

> SD012 只是启发式：命中不等于恶意，需要人工复核。它不替代安全审查。

## 四个工具

### `skill_doctor`（推荐先用）

一次给出结论，而不是规则清单：

```json
{ "name": "nature-citation" }
```

多技能体检省略 `name`：

```json
{ "extraRoots": ["~/.claude/skills"] }
```

输出顺序固定为“结论 → 证据 → 怎么改”：

- **结论**：没问题 / 模型看不到部分触发说法 / 模型不会自动用 / 有错误，一句话说清；
- **模型看到的信息**：模型实际拿到的简介（精确到第 500 字截断点）、能不能自动用、能不能 `/名字` 手动调用、正文多大；
- **被切掉的部分**：原文 + 被切掉的触发说法 + 影响大/小；
- **需要处理的问题**：每条都有“现在什么情况”和“怎么改”，不写规则名；
- **技术细节（可跳过）**：provider、model-invocable、规则 ID（SD004 等）集中放在最后。

### `skill_lint`

逐条规则的 verbose/CI 模式：规则 ID 直接写在每条前面，按“需要修复 / 描述被截断 / 其他提示 / 正常”分组，不再把 30 个技能展开成 30 段。想要人话版本请用 `skill_doctor`。

```json
{ "name": "code-review", "format": "json" }
```

参数：

| 参数 | 说明 |
|---|---|
| `name?` | 只查一个技能；省略则查全部 |
| `provider?` | 只看某个 provider |
| `rules?` | 只跑指定规则，例如 `["SD003","SD004"]` |
| `severity?` | `info` / `warn` / `error`，默认跟随配置 |
| `extraRoots?` | 额外扫描的根目录，用于发现同名遮蔽 |
| `format?` | `markdown`（默认）或 `json` |

### `skill_explain`

解释一个技能为什么没出现、没被模型选中、或加载失败。

```json
{ "name": "code-review" }
```

输出会告诉你：

- 最终获胜的 provider / source / path
- 是否 model-invocable、user-invocable
- description 长度、正文 token 估算
- `ctx.skills.get` 是否真的能加载
- 可能原因：`disable-model-invocation=true`、description 被截断、同名遮蔽、虚拟技能、provider 加载失败
- 配置了 `extraRoots` 时，列出同名候选

### `plugin_doctor`（0.3.0 新增）

查**已安装插件之间**的结构性冲突。技能没生效是一类问题，插件互相打架是另一类——典型症状是“某个插件的工具突然不见了”，或者“改了半天配置没反应”。

```json
{ "profile": "desktop" }
```

它从 profile 的 `package.json`、`cordis.yml` 和每个插件的 `cordis.patch.yml` 里读出实际安装与组合结果，检查四件事：

| ID | 级别 | 检查 | 典型症状 |
|---|---|---|---|
| PL001 | warn | 同一个插件在 `dsh.profile.bundles` 里出现多次 | 插件被重复装载 |
| PL002 | warn | 两个插件各自 `insert` 同一条目 id | 只有一个生效，另一个功能丢失 |
| PL003 | warn | 两个插件同时改同一条目（如 `agent-default-model`） | 后加载的覆盖前面的，设置静默失效 |
| PL004 | error/info | 启用了但包不在（error）/ 装了但没启用（info） | 启动报错，或功能不出现 |

输出格式和技能报告一致：结论、插件清单表、冲突逐条说明“现在/怎么改”，技术细节放最后。

**它查不到的**：工具名被两个插件同时注册属于运行时冲突，dsh 的工具注册表不暴露“这个工具是谁注册的”，所以这里不做猜测，报告里会写明。dsh 自带插件（`@deepseek-ai/*`）的 patch 在 `app.asar` 里读不到，条目冲突只在 profile 插件之间比对。

## CLI：给技能作者和 CI

插件同时提供 `dsh-skill-lint`，**不需要 dsh 运行时**：

```bash
# 扫描当前项目里的技能
npx --package dsh-skill-doctor dsh-skill-lint .

# 扫描单个技能
npx --package dsh-skill-doctor dsh-skill-lint ./skills/code-review

# 扫描外部目录
npx --package dsh-skill-doctor dsh-skill-lint ~/.claude/skills --all

# CI：JSON + warn 也失败
npx --package dsh-skill-doctor dsh-skill-lint . --json --warn-as-error

# 插件冲突体检（不需要 dsh 运行时，直接读 profile 目录）
npx --package dsh-skill-doctor dsh-skill-lint --plugins --profile desktop
npx --package dsh-skill-doctor dsh-skill-lint --plugins --profile desktop --json
```

退出码：`0` 通过，`1` 有 error（或 `--warn-as-error` 时存在 warn），`2` 参数/读取错误。

GitHub Actions 示例：

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 24
- run: npx --package dsh-skill-doctor dsh-skill-lint ./skills --warn-as-error
```

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `maxDescriptionLength` | `500` | 与 dsh 模型目录的 description 上限对齐 |
| `maxBodyTokens` | `8000` | 正文 token 估算预算 |
| `maxFileBytes` | `1048576` | 单文件读取上限 |
| `extraRoots` | `[]` | 额外扫描的技能根；外部目录默认不读 |
| `rules` | `{}` | 规则级覆盖：`off` / `info` / `warn` / `error` |
| `severityThreshold` | `info` | 输出过滤阈值 |
| `includeProviders` | `[]` | 只检查这些 provider |
| `excludeProviders` | `[]` | 跳过这些 provider |

配置非法时插件只打一行 warn 并禁用自己，**不会阻断会话创建**。

## 工作原理

1. 用 `ctx.skills.snapshot({ cwd, scope })` 拿到当前视图的获胜技能。
2. 用 `ctx.skills.get(name)` 拿完整正文，确认它真的能加载。
3. 如果 `path` 指向本地文件，只读地读一遍原始 `SKILL.md`，做 frontmatter/引用/编码检查。
4. 远端或虚拟技能没有本地路径时，自动跳过文件级规则，只用定义内容做逻辑检查。
5. `extraRoots` 只用于“同名候选”提示；最终以 registry 的合并结果为准，不假装权威。

它**不执行**技能里的脚本，**不修改**任何文件，**不发送**技能内容到网络。

## 与同类插件的关系

- `dsh-skill-explorer` / `dsh-skills-manager`：浏览、安装、管理技能。本插件是“体检”，可以一起用。
- `dsh-skill-intelligence`：展示一次会话实际加载了哪些技能。本插件解释“为什么没加载/为什么被遮蔽”。
- 安全类技能扫描器：本插件不抢安全定位；SD012 只是启发式提示。

## 已知限制

- 报告里的技能是**dsh 当前视图**里的技能，不只是你目录里的：dsh 自带的虚拟技能（例如 Windows 沙箱诊断）也会出现，会标注“（dsh 自带）”并单独计数。
- 反过来，**完全没被 dsh 收录**的技能（名字不合规、文件头坏了）不会出现在视图里。这类“彻底不出现”的问题要用 `extraRoots` 指回目录，让插件直接扫文件才能看到。
- SD012 是启发式，不是恶意代码判定；不要把它当安全保证。
- token 估算是近似值（ASCII ≈ 4 字符/token，CJK ≈ 0.75 token/字符），不承诺与 provider tokenizer 一致。
- 同名检测只扫描配置的 root，不能看到 registry 内部所有候选；结论标注为“候选”。
- 不判断技能内容“写得好不好”，也不自动修复。
- 远端/虚拟技能无法做文件级检查。
- 以 `_` 开头的目录（如 `_references`）默认视为共享资源目录，不当作技能扫描。

## 路线图

- V1.1：`skill_ab` —— 同一 prompt 带/不带技能各跑一次，比较 token、延迟和输出。
- V1.2：设置面板、规则文档、对外暴露 capability registry。
- V2：可选的自动修复建议（仍需用户确认）。

## 开发

```bash
npm install
npm run build
npm test
npm run smoke
```

## License

MIT
