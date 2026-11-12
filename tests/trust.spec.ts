/**
 * 信任清单的读写与容错。
 *
 * 重点不是 CRUD 本身，而是三条：坏文件不能让安装失败、按包名不按版本、
 * 重复添加不覆盖原始时间（否则「什么时候开始信任的」就失真了）。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addTrust,
  isTrusted,
  loadTrust,
  removeTrust,
  saveTrust,
  trustPath,
  trustedNames,
} from '../src/trust'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-trust-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function file(): string {
  return join(dir, 'trusted.json')
}

describe('trust list', () => {
  it('returns an empty list when the file does not exist', async () => {
    const loaded = await loadTrust(file())
    expect(loaded.trusted).toEqual([])
    expect(trustedNames(loaded)).toEqual([])
  })

  it('adds a package once and keeps the original timestamp', async () => {
    const first = await addTrust('cc-safety-net', undefined, file())
    expect(first.added).toBe(true)
    const stamp = first.file.trusted[0]!.at

    const again = await addTrust('cc-safety-net', 'second call', file())
    expect(again.added).toBe(false)
    expect(again.file.trusted).toHaveLength(1)
    // 重复添加不覆盖时间，也不追加备注——否则「何时起信任」会被后来的操作改写。
    expect(again.file.trusted[0]!.at).toBe(stamp)
    expect(again.file.trusted[0]!.reason).toBeUndefined()
  })

  it('records an optional reason', async () => {
    const { file: written } = await addTrust('native-addon', '需要 postinstall 编译', file())
    expect(written.trusted[0]!.reason).toBe('需要 postinstall 编译')
  })

  it('removes a package and reports whether it was there', async () => {
    await addTrust('demo', undefined, file())
    const hit = await removeTrust('demo', file())
    expect(hit.removed).toBe(true)
    expect(hit.file.trusted).toEqual([])

    const miss = await removeTrust('demo', file())
    expect(miss.removed).toBe(false)
  })

  it('matches names case-insensitively', async () => {
    const { file: written } = await addTrust('Demo-Pkg', undefined, file())
    expect(isTrusted(written, 'demo-pkg')).toBe(true)
    const removed = await removeTrust('DEMO-PKG', file())
    expect(removed.removed).toBe(true)
  })

  it('survives a corrupt file instead of throwing', async () => {
    // 清单坏了最多是门禁回到默认行为；抛错会让安装直接失败，那比误拦更糟。
    await writeFile(file(), '{ not json', 'utf8')
    await expect(loadTrust(file())).resolves.toEqual({ version: 1, trusted: [] })

    await writeFile(file(), JSON.stringify({ trusted: 'nope' }), 'utf8')
    await expect(loadTrust(file())).resolves.toEqual({ version: 1, trusted: [] })
  })

  it('drops malformed entries but keeps the valid ones', async () => {
    await writeFile(file(), JSON.stringify({
      version: 1,
      trusted: [
        { pkg: 'good', at: '2026-11-12T00:00:00.000Z' },
        { pkg: '', at: '2026-11-12T00:00:00.000Z' },
        { at: '2026-11-12T00:00:00.000Z' },
        null,
        'string',
      ],
    }), 'utf8')
    const loaded = await loadTrust(file())
    expect(loaded.trusted.map(entry => entry.pkg)).toEqual(['good'])
  })

  it('writes a file that can be read back verbatim', async () => {
    await saveTrust({ version: 1, trusted: [{ pkg: 'x', at: '2026-11-12T00:00:00.000Z' }] }, file())
    const raw = await readFile(file(), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw).trusted[0].pkg).toBe('x')
  })

  it('places the default file next to the checkup records', () => {
    // 与病历同目录（$DSH_HOME/skill-doctor/），但不带 profile 后缀。
    expect(trustPath().replace(/\\/g, '/')).toMatch(/skill-doctor\/trusted\.json$/)
  })
})
