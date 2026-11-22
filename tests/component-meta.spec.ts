/**
 * 组件行的显示元数据（`<子路径>/locale/<lang>.json`）。
 *
 * dsh 读组件行标题与描述的路径是 `readPluginMeta`：
 *   1. 解析 `<specifier>/locale/en.json`（走 Node 的包解析器 → **受 exports 约束**）
 *   2. 同目录下所有 `<lang>.json` 作为语言字典
 *   3. 取每个文件的 `meta.title` / `meta.description`
 *
 * 三个环节任何一个断了，表现都是「组件没有标题和描述」，而且 dsh 会静默吞掉
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`，不会报错。所以这里逐条钉住：
 * 文件存在、格式正确、exports 允许解析、files 允许发布。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  files?: string[]
  exports?: Record<string, unknown>
}

/** 需要自带显示元数据的子路径组件。 */
const SUBPATHS = ['compat', 'gate', 'audit'] as const
const LANGS = ['en', 'zh'] as const

function readMeta(sub: string, lang: string): { title: string; description: string } {
  const file = join(root, sub, 'locale', `${lang}.json`)
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
    meta?: { title?: unknown; description?: unknown }
  }
  const title = parsed.meta?.title
  const description = parsed.meta?.description
  if (typeof title !== 'string' || title.length === 0) throw new Error(`${file}: meta.title 缺失`)
  if (typeof description !== 'string' || description.length === 0) throw new Error(`${file}: meta.description 缺失`)
  return { title, description }
}

describe('component display metadata', () => {
  it.each(SUBPATHS)('%s 的两种语言都有 title 与 description', (sub) => {
    for (const lang of LANGS) {
      const meta = readMeta(sub, lang)
      // 标题不能是模块路径本身——那正是这层元数据要解决的问题。
      expect(meta.title).not.toContain('dsh-skill-doctor/')
      expect(meta.description.length).toBeGreaterThan(10)
    }
  })

  it('标题就是组件行 id，去掉包名前缀', () => {
    for (const sub of SUBPATHS) {
      // 标题取短名而不是「外部技能挂载」这类中文词：dsh 在 title === rowId 时
      // 不会重复渲染 id，于是只剩 moduleName 一行小字，整体结构与第一个组件一致。
      expect(readMeta(sub, 'zh').title).toBe(`skill-doctor-${sub}`)
      expect(readMeta(sub, 'en').title).toBe(`skill-doctor-${sub}`)
    }
  })

  it('描述是本地化的，中英不同', () => {
    for (const sub of SUBPATHS) {
      const zh = readMeta(sub, 'zh').description
      const en = readMeta(sub, 'en').description
      expect(zh).not.toBe(en)
      // 中文描述里应当有汉字，防止复制英文时漏改。
      expect(/[\u4e00-\u9fa5]/.test(zh)).toBe(true)
    }
  })

  it('exports 允许解析 <子路径>/locale/*，否则 dsh 读不到元数据', () => {
    for (const sub of SUBPATHS) {
      const key = `./${sub}/locale/*`
      // 映射两侧都写成同一个通配（`./x/locale/*` → `./x/locale/*`）。
      expect(manifest.exports?.[key], `exports 缺少 ${key}`).toBe(key)
    }
  })

  it('files 允许把 locale 目录发出去', () => {
    for (const sub of SUBPATHS) {
      const entry = `${sub}/locale`
      expect(manifest.files ?? [], `files 缺少 ${entry}`).toContain(entry)
    }
  })
})
