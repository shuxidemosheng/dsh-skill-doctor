/**
 * 版本校准：确认"正常值"这把尺子还没漂。
 *
 * 医生量体温，37℃ 是生物学常数，几十年不变。我们判断"简介超过 500 字就算长"
 * 却不是常数，那是 dsh 当时的模型目录约定，会随版本改。dsh 把上限调到 800 的
 * 那天，我们不会自动知道，用户更不会——13 个"问题"里可能有 8 个瞬间变成误报，
 * 而报告依旧信誓旦旦。
 *
 * 所以这里记下"这套阈值是按哪个 dsh 版本校准的"，读到实际版本后在报告里对一下。
 * 版本取自 `$DSH_HOME/dsh-runtimes/<runtime>/runtime.json` 的 `desktopVersion`，
 * 这是磁盘文件，CLI 和插件都能读，不用靠猜。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHome } from './plugins/scan.js'

/** 当前这 15 条规则的阈值（500 / 8000 / kebab-case）是按这个版本校准的。 */
export const CALIBRATED_DSH = '0.2.1-rc.2'

/** 版本对照结果。 */
export interface DshVersionInfo {
  /** 实际读到的 dsh 版本；读不到就没有这个字段。 */
  readonly version?: string
  /** 校准版本。 */
  readonly calibrated: string
  /** 读到版本、且与校准版本的主次版本号不同。 */
  readonly drifted: boolean
}

/** 只取主次版本号（`0.2.1-rc.2` → `0.2`），补丁与 rc 号不影响阈值。 */
function majorMinor(version: string): string | undefined {
  const match = /^(\d+)\.(\d+)/.exec(version.trim())
  if (match === null) return undefined
  return `${match[1]}.${match[2]}`
}

/** 从一个 runtime.json 里抠出 desktopVersion。 */
function pickVersion(raw: unknown): string | undefined {
  const value = raw as { desktopVersion?: unknown } | undefined
  return typeof value?.desktopVersion === 'string' && value.desktopVersion.length > 0
    ? value.desktopVersion
    : undefined
}

/**
 * 读 dsh 的实际版本。任何失败都返回"读不到"，不影响体检本身。
 * @param home - 可选，覆盖 `$DSH_HOME`（测试用）。
 */
export async function readDshVersion(home = dshHome()): Promise<DshVersionInfo> {
  const base: DshVersionInfo = { calibrated: CALIBRATED_DSH, drifted: false }

  let runtimes: string[]
  try {
    runtimes = await readdir(join(home, 'dsh-runtimes'))
  } catch {
    return base
  }

  for (const runtime of runtimes) {
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(join(home, 'dsh-runtimes', runtime, 'runtime.json'), 'utf8'))
    } catch {
      continue
    }
    const version = pickVersion(raw)
    if (version === undefined) continue
    const actual = majorMinor(version)
    const expected = majorMinor(CALIBRATED_DSH)
    return {
      version,
      calibrated: CALIBRATED_DSH,
      drifted: actual !== undefined && expected !== undefined && actual !== expected,
    }
  }

  return base
}

/**
 * 报告顶部的一句提示；不需要提示时返回 undefined。
 * @param info - 版本对照结果。
 */
export function calibrationWarning(info: DshVersionInfo | undefined): string | undefined {
  if (info?.version === undefined || !info.drifted) return undefined
  return `这套规则的阈值是按 dsh ${majorMinor(CALIBRATED_DSH)} 校准的，你当前是 ${info.version}。`
    + '上游改过 description 上限或正文预算的话，报告里的“超长”未必还是问题——先按结论处理，别当铁律。'
}

/**
 * 技术细节里的一行，说明这把尺子是哪来的。
 * @param info - 版本对照结果。
 */
export function calibrationNote(info: DshVersionInfo | undefined): string | undefined {
  // 读不到版本就什么都别写：那多半是 dsh 装在别处或还没初始化，
  // 写一句“读不到”只会让读者去排查一个跟他无关的问题。
  if (info?.version === undefined) return undefined
  return info.drifted
    ? `阈值校准基线：dsh ${info.calibrated}；当前 dsh ${info.version} —— **主次版本不同，阈值可能已过期**`
    : `阈值校准基线：dsh ${info.calibrated}，与当前 dsh ${info.version} 一致`
}
