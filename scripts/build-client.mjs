/** 浏览器侧面板的构建：esbuild 打成 CJS，再套上宿主要求的 ModuleLoader 外壳。 */
import { build } from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// 宿主的模块表里已有这些包；external 掉，避免打出第二份 React。
export const EXTERNAL = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']

/**
 * 外壳是硬性要求：宿主用 `window.__ModuleLoader__.load()` 装载客户端 bundle，
 * factory 拿到的 `require` 由宿主解析（上面那张模块表）。
 * 注意宿主会 `unwrapExports`，所以入口只能导出 apply / inject，不能有 default。
 */
function bannerFor(name) {
  return `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`
}

const FOOTER = 'return module.exports; } });'

/**
 * 打包客户端代码，返回字符串。测试直接调它，不依赖 `lib/` 里是否已有产物。
 * @param options - 可选覆盖：包名与是否压缩。
 */
export async function buildClientCode(options = {}) {
  const name = options.name ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name
  const result = await build({
    entryPoints: [join(root, 'src/client.tsx')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'chrome120',
    jsx: 'automatic',
    external: EXTERNAL,
    banner: { js: bannerFor(name) },
    footer: { js: FOOTER },
    legalComments: 'none',
    minify: options.minify ?? false,
    write: false,
    logLevel: 'warning',
  })
  return result.outputFiles[0]?.text ?? ''
}

/** 直接执行本脚本时才写文件。 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await buildClientCode()
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'lib/client.js'), code)
  process.stdout.write(`lib/client.js  ${(Buffer.byteLength(code) / 1024).toFixed(1)} kB\n`)
}
