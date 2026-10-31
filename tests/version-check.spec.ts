import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CALIBRATED_DSH,
  calibrationNote,
  calibrationWarning,
  readDshVersion,
} from '../src/version-check'

/** 造一个假的 `$DSH_HOME`，里面放一份 runtime.json。 */
function fakeHome(runtime = 'dsh-primary-runtime', body?: string): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  mkdirSync(join(home, 'dsh-runtimes', runtime), { recursive: true })
  if (body !== undefined) writeFileSync(join(home, 'dsh-runtimes', runtime, 'runtime.json'), body)
  return home
}

const homes: string[] = []
function track(home: string): string {
  homes.push(home)
  return home
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true })
})

describe('readDshVersion', () => {
  it('reads desktopVersion from the runtime manifest', async () => {
    const home = track(fakeHome(undefined, JSON.stringify({ desktopVersion: '0.2.1-rc.2' })))
    const info = await readDshVersion(home)
    expect(info.version).toBe('0.2.1-rc.2')
    expect(info.drifted).toBe(false)
    expect(info.calibrated).toBe(CALIBRATED_DSH)
  })

  it('stays silent instead of throwing when dsh is not installed', async () => {
    // 体检本身不能因为“读不到版本”失败：那只是少一条提示。
    const info = await readDshVersion(join(tmpdir(), 'definitely-not-a-dsh-home'))
    expect(info.version).toBeUndefined()
    expect(info.drifted).toBe(false)
  })

  it('ignores a manifest without desktopVersion', async () => {
    const home = track(fakeHome(undefined, JSON.stringify({ somethingElse: 1 })))
    expect((await readDshVersion(home)).version).toBeUndefined()
  })

  it('skips a broken manifest and tries the next runtime', async () => {
    const home = track(fakeHome('broken', '{ not json'))
    mkdirSync(join(home, 'dsh-runtimes', 'good'), { recursive: true })
    writeFileSync(join(home, 'dsh-runtimes', 'good', 'runtime.json'), JSON.stringify({ desktopVersion: '0.4.0' }))
    const info = await readDshVersion(home)
    expect(info.version).toBe('0.4.0')
    expect(info.drifted).toBe(true)
  })

  it('compares only major.minor so patch releases do not cry wolf', async () => {
    const home = track(fakeHome(undefined, JSON.stringify({ desktopVersion: '0.2.9' })))
    expect((await readDshVersion(home)).drifted).toBe(false)
  })

  it('flags a different major.minor as drifted', async () => {
    const home = track(fakeHome(undefined, JSON.stringify({ desktopVersion: '1.0.0' })))
    expect((await readDshVersion(home)).drifted).toBe(true)
  })
})

describe('calibrationWarning', () => {
  it('warns only when the version actually drifted', () => {
    expect(calibrationWarning({ version: '1.0.0', calibrated: CALIBRATED_DSH, drifted: true }))
      .toContain('1.0.0')
    expect(calibrationWarning({ version: '0.2.1-rc.2', calibrated: CALIBRATED_DSH, drifted: false }))
      .toBeUndefined()
    expect(calibrationWarning({ calibrated: CALIBRATED_DSH, drifted: false })).toBeUndefined()
    expect(calibrationWarning(undefined)).toBeUndefined()
  })

  it('says the thresholds may be stale instead of asserting they are', () => {
    const warning = calibrationWarning({ version: '1.0.0', calibrated: CALIBRATED_DSH, drifted: true })!
    expect(warning).toContain('未必还是问题')
    expect(warning).not.toContain('一定过期')
  })
})

describe('calibrationNote', () => {
  it('says nothing when the version could not be read', () => {
    // 写“读不到”只会让读者去查一个跟他无关的问题。
    expect(calibrationNote({ calibrated: CALIBRATED_DSH, drifted: false })).toBeUndefined()
    expect(calibrationNote(undefined)).toBeUndefined()
  })

  it('marks the baseline as possibly stale when drifted', () => {
    const note = calibrationNote({ version: '0.5.0', calibrated: CALIBRATED_DSH, drifted: true })!
    expect(note).toContain('0.5.0')
    expect(note).toContain('过期')
  })

  it('confirms the baseline when the versions agree', () => {
    const note = calibrationNote({ version: '0.2.1-rc.2', calibrated: CALIBRATED_DSH, drifted: false })!
    expect(note).toContain('一致')
    expect(note).not.toContain('过期')
  })
})
