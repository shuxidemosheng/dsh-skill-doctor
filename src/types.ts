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
