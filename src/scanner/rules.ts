/** 规则目录：ID、默认级别、标题与一句话说明。 */
import type { RuleId, Severity } from '../types.js'

/** 一条规则的元数据。 */
export interface RuleMeta {
  readonly id: RuleId
  readonly defaultSeverity: Severity
  /** 面向 CI / 引擎的规则标题，含技术字段名。 */
  readonly title: string
  /** 面向人的一句话标题：第一屏只显示它，不出现规则 ID。 */
  readonly plainTitle: string
  readonly description: string
}

/**
 * 全部规则。默认级别是“没有配置覆盖时”的级别；
 * 用户可通过 config.rules 把任意规则改成 off/info/warn/error。
 */
export const RULES: Record<RuleId, RuleMeta> = {
  SD001: {
    id: 'SD001',
    defaultSeverity: 'error',
    plainTitle: '文件头写坏了，dsh 读不出这个技能',
    title: 'frontmatter 缺失或无法解析',
    description: 'SKILL.md 必须以独立的 --- 行开头，并以另一条 --- 结束；中间必须是 YAML 对象。',
  },
  SD002: {
    id: 'SD002',
    defaultSeverity: 'error',
    plainTitle: '技能名有问题',
    title: '技能名不合法或与目录名不一致',
    description: 'dsh 技能名必须是 kebab-case（^[a-z0-9]+(?:-[a-z0-9]+)*$）；目录包/平铺文件的名称应与技能名一致。',
  },
  SD003: {
    id: 'SD003',
    defaultSeverity: 'error',
    plainTitle: '没有写给模型看的简介',
    title: 'description 缺失',
    description: 'description 是模型选择技能的唯一依据，必须存在且非空。',
  },
  SD004: {
    id: 'SD004',
    defaultSeverity: 'warn',
    plainTitle: '简介太长，后半段模型看不到',
    title: 'description 超过目录上限',
    description: '模型目录只渲染截断后的 description；超过上限会让后半段对模型不可见。',
  },
  SD005: {
    id: 'SD005',
    defaultSeverity: 'warn',
    plainTitle: '简介太短或太笼统',
    title: 'description 过短或过于笼统',
    description: '过短的 description 难以让模型判断何时使用该技能。',
  },
  SD006: {
    id: 'SD006',
    defaultSeverity: 'error',
    plainTitle: '技能正文是空的',
    title: '技能正文为空',
    description: '加载技能后模型需要正文；只有标题或只有空行等于没有指令。',
  },
  SD007: {
    id: 'SD007',
    defaultSeverity: 'warn',
    plainTitle: '正文太长，会占掉很多上下文',
    title: '正文 token 估算超过预算',
    description: '技能正文会整体进入上下文；超过预算时建议拆分或精简。',
  },
  SD008: {
    id: 'SD008',
    defaultSeverity: 'warn',
    plainTitle: '正文里提到的文件找不到',
    title: '引用的资源文件不存在',
    description: '正文里引用的 references/、scripts/、assets/ 路径在资源基址下找不到。',
  },
  SD009: {
    id: 'SD009',
    defaultSeverity: 'warn',
    plainTitle: '有同名技能，可能被覆盖',
    title: '同名技能可能被遮蔽',
    description: '多个技能目录/ provider 暴露了同一个名字；registry 只会保留一个获胜者。',
  },
  SD010: {
    id: 'SD010',
    defaultSeverity: 'warn',
    plainTitle: '开关字段填错了，dsh 读不懂',
    title: 'invocation 字段不是布尔值',
    description: 'disable-model-invocation 与 user-invocable 只接受布尔值（以及官方兼容的 1/0、yes/no、on/off）。',
  },
  SD011: {
    id: 'SD011',
    defaultSeverity: 'info',
    plainTitle: '技能名太长，不好输入',
    title: '技能名过长',
    description: '过长的名字在 /命令 补全和手工输入时不方便。',
  },
  SD012: {
    id: 'SD012',
    defaultSeverity: 'warn',
    plainTitle: '内容有点可疑，需要人工看一眼',
    title: '可疑指令模式',
    description: '命中忽略前置指令、外传凭证、隐藏 Unicode、长 base64 块等启发式模式；需要人工复核，不直接定性。',
  },
  SD013: {
    id: 'SD013',
    defaultSeverity: 'info',
    plainTitle: '文件开头有个多余的隐藏标记',
    title: '文件带 BOM',
    description: 'UTF-8 BOM 可能让首行 --- 判定失败；建议保存为无 BOM 的 UTF-8。',
  },
  SD014: {
    id: 'SD014',
    defaultSeverity: 'info',
    plainTitle: '换行符是 Windows 格式',
    title: '文件使用 CRLF',
    description: 'CRLF 通常能被解析，但跨平台编辑时容易产生混合行尾；建议统一为 LF。',
  },
  SD015: {
    id: 'SD015',
    defaultSeverity: 'warn',
    plainTitle: '引用的路径跑到了技能目录外面',
    title: '资源引用包含路径穿越',
    description: 'references/../、scripts/../../ 之类的路径可能逃出技能目录。',
  },
}

/** 稳定顺序的规则 ID 列表（config 校验与 CLI 帮助用）。 */
export const RULE_IDS = Object.keys(RULES) as RuleId[]
