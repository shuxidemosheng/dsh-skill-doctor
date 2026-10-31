/**
 * 版本号一致性。
 *
 * `dsh-skill-lint --version` 读的是 `src/cli.ts` 里的常量，而 npm 发布看的是
 * `package.json`。这两处曾经漂过（package 是 0.5.0，CLI 还停在 0.4.0），
 * 用户在命令行里看到的版本号因此是错的。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 项目根下某个文件的内容。 */
function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

describe('version', () => {
  it('keeps the CLI --version constant in sync with package.json', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string }
    const match = /const VERSION = '([^']+)'/.exec(read('src/cli.ts'))
    expect(match, 'src/cli.ts 里应该有 const VERSION = ...').not.toBeNull()
    expect(match![1]).toBe(pkg.version)
  })
})
