/** 共享类型：规则、finding、技能输入与扫描结果。 */

/** 单条检查的严重级别。 */
export type Severity = 'info' | 'warn' | 'error'

/** 规则 ID。新增规则时同步 RULES 与 tests。 */
export type RuleId =
  | 'SD001'
  | 'SD002'
  | 'SD003'
  | 'SD004'
  | 'SD005'
  | 'SD006'
  | 'SD007'
  | 'SD008'
  | 'SD009'
  | 'SD010'
  | 'SD011'
  | 'SD012'
  | 'SD013'
  | 'SD014'
  | 'SD015'

/** 一条检查结果。 */
export interface Finding {
  readonly rule: RuleId
  readonly severity: Severity
  readonly message: string
  /** 相关文件；运行时技能可能没有本地路径。 */
  readonly file?: string
  /** 1-based 行号，能定位时给出。 */
  readonly line?: number
  /** 可操作的建议。 */
  readonly suggestion?: string
}

/** 资源基址，与 @deepseek-ai/dsh-skill 的 SkillResourceBase 同构。 */
export type ResourceBase =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'opaque'; readonly description: string }

/**
 * 一条待检查技能的归一化输入。
 *
 * 运行时来自 ctx.skills.snapshot/get；CLI 来自文件扫描。
 * `raw` 是原始 SKILL.md 文本（可含 frontmatter），仅本地文件可得。
 */
export interface SkillInput {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly content: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly path?: string
  readonly provider: string
  readonly source: string
  readonly invocation: {
    readonly modelInvocable: boolean
    readonly userInvocable: boolean
  }
  readonly resourceBase?: ResourceBase
  /** 原始文件文本；远端/虚拟技能为 undefined。 */
  readonly raw?: string
  /** 技能所在目录名或平铺文件名（不含扩展名），用于 name 一致性检查。 */
  readonly directoryName?: string
}

/** 单技能 lint 结果。 */
export interface SkillLintResult {
  readonly skill: SkillInput
  readonly findings: readonly Finding[]
  readonly errors: number
  readonly warnings: number
  readonly infos: number
  readonly ok: boolean
}

/** 一次多技能扫描的汇总。 */
export interface ScanResult {
  readonly results: readonly SkillLintResult[]
  readonly errors: number
  readonly warnings: number
  readonly infos: number
  readonly ok: boolean
}


/**
 * registry 里某个技能名的获胜者，来自 ctx.skills.snapshot()。
 *
 * 注意它**不是** SkillInput 的一部分：snapshot 返回的 SkillSummary 刻意剥掉了
 * rank / locator（那些是 registry 内部裁决用的），所以给 SkillInput 加 rank 字段
 * 只会得到一个永远填不上值的死字段。胜负用「名字 + 获胜者的 path」来表示，
 * 由报告层拿它去和同名候选的 path 比对。
 */
export interface WinnerInfo {
  readonly name: string
  readonly provider: string
  readonly source: string
  /** 远端 / 虚拟技能没有本地路径，此时无法做 path 匹配，只能降级为「候选」。 */
  readonly path?: string
}

/** 一个同名遮蔽组的诊断结果；里面的路径都已脱敏，可直接上屏。 */
export interface ProvenanceShadow {
  readonly name: string
  /** 判定出的获胜者路径；没判出来就是 undefined。 */
  readonly winner?: string
  /** 该组里其余候选的路径（含未判定时的全部候选）。 */
  readonly shadowed: readonly string[]
  /** 是否拿到了 registry 的确定裁决。 */
  readonly resolved: boolean
}

/**
 * 「来源与遮蔽」视图的结构化数据。
 *
 * 它**不产生 Finding**：病历（baseline）只按 finding.rule 计数，如果这里也
 * 生成 finding，一次文案升级就会让老病历被误判成「新冒出来一个」。
 * 视图完全由本次扫描到的 SkillInput 派生，findings 集合保持零变化。
 */
export interface ProvenanceView {
  /** 按 provider 分组计数，数量降序；如实列出，不猜测哪些算「原生 / 导入」。 */
  readonly byProvider: readonly { readonly provider: string; readonly count: number }[]
  /** 按来源根目录分组计数，数量降序；路径已折叠。 */
  readonly byRoot: readonly { readonly root: string; readonly count: number }[]
  /** 同名遮蔽组（只含 >= 2 个候选的名字）。 */
  readonly shadows: readonly ProvenanceShadow[]
}


/**
 * 「目录预算」视图数据：第一层渐进披露注入的技能清单有多大。
 *
 * 纯展示数据，不是 Finding：病历只按 finding.rule 计数，如果这里也生成一条
 * 告警，一次文案调整就会让老病历被误判成「新冒出来一个」。也不参与 ok 判定。
 */
export interface AnnouncementBudget {
  /** 参与第一层的技能数（modelInvocable 为 true）。 */
  readonly skills: number
  /** name + description + whenToUse 的总字符数。 */
  readonly chars: number
  /** 按 3 字符/token 的粗估，仅供量级参考。 */
  readonly approxTokens: number
  /** 对照用的参考预算（字符）；来源未在 dsh 上校准，不是硬阈值。 */
  readonly referenceBudget: number
}
