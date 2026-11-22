/**
 * dsh-skill-doctor —— 审查归档（独立的组件行）。
 *
 * 这是 cordis.patch.yml 第四行 `id: skill-doctor-audit` 的入口，只做一件事：
 * 往上下文里提供 `skillDoctorAudit` 服务，让门禁在审查结束后把**完整结论**
 * 交过来归档。
 *
 * ## 为什么拆成独立一行
 *
 * 归档需要自己的容量与生命周期（20 MB / 5000 条 / 180 天），也需要能被
 * 单独关掉（有人不想留痕）。这两点都不是「门禁的一个配置项」能表达的。
 *
 * ## 关键约束：谁都不能 inject 它
 *
 * 门禁行**不能**把 `skillDoctorAudit` 写进 inject。写了之后，一旦用户关掉
 * 归档行，服务永远不存在，而 cordis 的语义是「注入列表里任一服务缺失就整体
 * 不 apply」——门禁会跟着失效。这正是 0.18.0 那次事故的反面。
 *
 * 所以约定的用法是：调用方在**每次需要记录时**用
 * `ctx.get('skillDoctorAudit', false)` 软探测，拿不到就跳过。
 *
 * 同理，本行也不 inject 任何别的东西——它只依赖 `logger`，而 logger 不是服务。
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  appendEntry,
  auditPath,
  auditStats,
  pruneFile,
  queryEntries,
  toEntry,
  type AuditEntry,
  type AuditQuery,
  type AuditSource,
  type AuditStats,
  type PruneResult,
  type RawVerdict,
} from './audit.js'

/** Cordis 模块名。与 patch 里的 id 保持一致。 */
export const name = 'skill-doctor-audit'

/** 上下文里暴露的服务名。调用方用 `ctx.get('skillDoctorAudit', false)` 探测。 */
export const SERVICE_NAME = 'skillDoctorAudit'

/** 归档服务的形状。 */
export interface AuditService {
  /** 记录一次审查。失败只会 warn，不抛给调用方。 */
  record(verdict: RawVerdict, source: AuditSource): Promise<void>
  query(query?: AuditQuery): Promise<AuditEntry[]>
  stats(): Promise<AuditStats>
  prune(): Promise<PruneResult>
  /** 归档文件路径，供命令展示。 */
  readonly path: string
}

/**
 * @param ctx - Cordis 上下文。没有 config：组件开关就是唯一开关。
 */
export function apply(ctx: Context): void {
  const path = auditPath()

  const service: AuditService = {
    path,

    async record(verdict, source) {
      try {
        const { pruned } = await appendEntry(toEntry(verdict, source), path)
        if (pruned.removed > 0) {
          ctx.logger.info(
            `skill-doctor-audit: pruned ${String(pruned.removed)} old entries (${String(pruned.freedBytes)} bytes freed)`,
          )
        }
      } catch (error) {
        // 归档是旁路：写不进去只留一行 warn，绝不影响这次安装的结果。
        ctx.logger.warn(
          `skill-doctor-audit: could not record ${verdict.spec}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },

    query(query) {
      return queryEntries(query, path)
    },

    stats() {
      return auditStats(path)
    },

    prune() {
      return pruneFile(path)
    },
  }

  // provide 绑定到当前 fiber：关掉这一行时服务随之消失，调用方自动跳过记录。
  ctx.provide(SERVICE_NAME, service)
  ctx.logger.info(`skill-doctor-audit: recording to ${path}`)
}
