#!/usr/bin/env node
/**
 * 真实 dsh 运行时 e2e 驱动。
 *
 * 做的事情只有四步：
 *   1. 生成一份临时 patch（provider 二选一：官方 deepseek-account / 本地 OpenAI 兼容网关；
 *      同时把技能目录固定成测试目录）；
 *   2. 用 headless profile 跑一个任务，--json 逐行读事件；
 *   3. 按用例里的结构断言判断通过/失败；
 *   4. 把证据（事件流、stderr、patch）落到 scripts/e2e/out/<runId>/ 方便复盘。
 *
 * 为什么不直接跑 dsh.cmd：cmd.exe 会重写引号，而且子进程是 cmd 的孙子，
 * 超时时杀不干净。所以这里照抄 dsh.cmd 的做法，直接 spawn Electron 的 node 模式。
 *
 * 退出码：0 全过 / 1 有失败 / 2 前置缺失 / 3 provider 不可用 / 4 profile 不可写。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CASES, extractJson, selectCases } from './e2e/cases.mjs'
import * as fixtures from './e2e/fixtures.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

/** Electron 可执行文件与 dsh CLI 入口；可用环境变量覆盖。 */
const DSH_EXE = process.env.DSH_EXE ?? 'D:/DeepSeek Harness/DeepSeek Harness.exe'
const DSH_CLI_JS = process.env.DSH_CLI_JS
  ?? 'D:/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'

/** app.asar 本体的路径：普通 Node 只能校验到这个文件，里面要靠 Electron 解析。 */
const ASAR_FILE = DSH_CLI_JS.slice(0, DSH_CLI_JS.indexOf('.asar') + '.asar'.length)

/** 默认参数。 */
const OPTIONS = {
  ids: [],
  groups: [],
  runs: 1,
  record: false,
  keep: false,
  timeoutMs: 180_000,
  profile: 'headless',
  // account = 官方 deepseek-account 路由（用本机已登录的账号凭据，不需要本地网关）
  // gateway = 自建 OpenAI 兼容网关（历史用法，需要 127.0.0.1:7863 在线）
  provider: process.env.E2E_PROVIDER ?? 'account',
  accountModel: process.env.E2E_ACCOUNT_MODEL ?? 'deepseek-flash',
  baseUrl: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:7863/v1',
  model: process.env.E2E_MODEL ?? 'cn:deepseek-v4.1-flash',
  apiKeyEnv: process.env.E2E_API_KEY_ENV ?? 'OPENAI_COMPLETIONS_API_KEY',
  checkGateway: true,
  outDir: join(HERE, 'e2e', 'out'),
}

/** 解析命令行。 */
function parseArgs(argv) {
  const options = { ...OPTIONS }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    switch (arg) {
      case '--list': options.list = true; break
      case '--case': options.ids.push(...String(next() ?? '').split(',').filter(Boolean)); break
      case '--group': options.groups.push(...String(next() ?? '').split(',').filter(Boolean)); break
      case '--runs': options.runs = Number(next() ?? 1); break
      case '--record': options.record = true; break
      case '--keep': options.keep = true; break
      case '--timeout': options.timeoutMs = Number(next() ?? 180) * 1000; break
      case '--profile': options.profile = String(next()); break
      case '--provider': options.provider = String(next()); break
      case '--account-model': options.accountModel = String(next()); break
      case '--base-url': options.baseUrl = String(next()); break
      case '--model': options.model = String(next()); break
      case '--api-key-env': options.apiKeyEnv = String(next()); break
      case '--out': options.outDir = String(next()); break
      case '--no-gateway-check': options.checkGateway = false; break
      case '-h': case '--help': options.help = true; break
      default: throw new Error(`unknown option: ${arg}`)
    }
  }
  return options
}

/** 极简 YAML 序列化：只覆盖 patch 用到的标量/数组/对象。 */
function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    return value.map(item => {
      if (item !== null && typeof item === 'object') {
        // 第一行内联到 "- " 后面，形成 YAML 常见的 "- key: value" 写法。
        const parts = toYaml(item, indent + 2).split('\n')
        return [`${pad}- ${String(parts[0]).trimStart()}`, ...parts.slice(1)].join('\n')
      }
      return `${pad}- ${scalar(item)}`
    }).join('\n')
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).map(([key, item]) => {
      if (Array.isArray(item)) {
        if (item.length === 0) return `${pad}${key}: []`
        return `${pad}${key}:\n${toYaml(item, indent + 2)}`
      }
      if (item !== null && typeof item === 'object') {
        return `${pad}${key}:\n${toYaml(item, indent + 2)}`
      }
      return `${pad}${key}: ${scalar(item)}`
    }).join('\n')
  }
  return `${pad}${scalar(value)}`
}

/** 标量统一加引号，避免 "abc" 被 YAML 当成非字符串。 */
function scalar(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  // 双引号里必须转义反斜杠：Windows 临时目录带反斜杠，
  // 不转义的话 YAML 会把 \U 当成非法转义（expected hexadecimal character）。
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * 生成一次运行的 patch。
 * 关键点：includeDefaultRoots=false + customSkillDirs，让技能集合完全确定，
 * 不受项目里已安装技能的影响。
 */
function buildPatch({ dirs, doctorConfig }) {
  // 官方账户通道只需要改默认模型路由：鉴权和模型目录由 llm-deepseek-account 自己解析，
  // 无需 baseURL / apiKeyEnv，也就不会碰到本地网关。
  // headless 模板默认把 credentials 与 deepseek-account 关掉了（桌面端才用账号登录），
  // 想走官方账号通道就必须在 patch 里重新打开这两行，否则只会得到 ACCOUNT_SIGN_IN_REQUIRED。
  const modelEntries = OPTIONS.provider === 'account'
    ? [
        {
          id: 'credentials',
          name: '@deepseek-ai/dsh-credentials-local',
          disabled: false,
        },
        {
          // deepseek-account 会等 authorization 服务；headless 模板把它也关了。
          id: 'authorization',
          name: '@deepseek-ai/dsh-authorization',
          disabled: false,
        },
        {
          id: 'deepseek-account',
          name: '@deepseek-ai/dsh-deepseek-account-platform',
          disabled: false,
        },
        {
          id: 'agent-default-model',
          name: '@deepseek-ai/dsh-agent-default-model',
          config: { provider: 'deepseek-account', model: OPTIONS.accountModel },
        },
      ]
    : [
        {
          id: 'agent-default-model',
          name: '@deepseek-ai/dsh-agent-default-model',
          config: { provider: 'openai-completions', model: OPTIONS.model },
        },
        {
          id: 'llm-pi-ai',
          name: '@deepseek-ai/dsh-llm-pi-ai',
          config: {
            providers: {
              'openai-completions': {
                displayName: 'openai-completions',
                apiKeyEnv: OPTIONS.apiKeyEnv,
                api: 'openai-completions',
                baseURL: OPTIONS.baseUrl,
                models: [{
                  id: OPTIONS.model,
                  name: 'DeepSeek V4.1 Flash',
                  contextWindow: 1_000_000,
                  maxTokens: 8192,
                }],
              },
            },
          },
        },
        {
          id: 'llm-deepseek-account',
          name: '@deepseek-ai/dsh-llm-deepseek-account',
          config: { enabled: false },
        },
      ]

  const entries = [
    ...modelEntries,
    {
      id: 'skill-filesystem',
      name: '@deepseek-ai/dsh-skill-filesystem',
      config: { includeDefaultRoots: false, watch: false, customSkillDirs: dirs },
    },
  ]
  if (doctorConfig !== undefined) {
    entries.push({ id: 'skill-doctor', name: 'dsh-skill-doctor', config: doctorConfig })
  }
  return `${entries.map(entry => toYaml([entry]).trimEnd()).join('\n')}\n`
}

/** 只从环境变量或 ~/.dsh/.credentials.yaml 的 refs 段读 key，绝不打印。 */
function resolveApiKey(name) {
  if (typeof process.env[name] === 'string' && process.env[name].length > 0) {
    return process.env[name]
  }
  const file = join(homedir(), '.dsh', '.credentials.yaml')
  if (!existsSync(file)) return undefined
  let source = ''
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const refsAt = source.indexOf('\nrefs:')
  if (refsAt < 0) return undefined
  // refs 段通常是文件末尾，逐行找 key，遇到非缩进行就停。
  const lines = source.slice(refsAt).split(/\r?\n/)
  for (const line of lines.slice(1)) {
    if (line.trim().length === 0) continue
    if (!/^\s+/.test(line)) break
    const match = new RegExp(`^\\s+${name}:\\s*(.+?)\\s*$`).exec(line)
    if (match !== null) return match[1].replace(/^['"]|['"]$/g, '')
  }
  return undefined
}

/** 账户通道探针：本机必须存在 deepseek 账号授权，否则一定 ACCOUNT_SIGN_IN_REQUIRED。 */
function hasAccountGrant() {
  const file = join(homedir(), '.dsh', '.credentials.yaml')
  if (!existsSync(file)) return false
  try {
    return readFileSync(file, 'utf8').includes('deepseek-account-platform/')
  } catch {
    return false
  }
}

/** 网关探针：连不上才算离线；任何 HTTP 响应都说明服务在。 */
async function gatewayOnline() {
  try {
    await fetch(`${OPTIONS.baseUrl.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(4000) })
    return true
  } catch {
    return false
  }
}

/** 调仓库自带 CLI 做基线：技能数量、耗时、输出体积。 */
async function cliBaseline(dir) {
  const started = Date.now()
  const result = spawnSync(process.execPath, [join(REPO, 'lib', 'cli.js'), dir, '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const durationMs = Date.now() - started
  const stdout = result.stdout ?? ''
  let count
  let names
  try {
    const parsed = JSON.parse(stdout)
    count = parsed.summary.skills
    names = parsed.results.map(result => result.name)
  } catch {
    count = undefined
    names = undefined
  }
  return { count, names, durationMs, bytes: Buffer.byteLength(stdout) }
}

/** 取事件里第一个存在的字段，兼容不同版本的事件命名。 */
function pick(object, keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined) return object[key]
  }
  return undefined
}

/** 跑一次 headless；返回事件流、stderr、退出码、耗时。 */
function runHeadless({ patchPath, task, timeoutMs }) {
  return new Promise(resolve => {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    if (OPTIONS.provider === 'gateway' && resolvedKey !== undefined) env[OPTIONS.apiKeyEnv] = resolvedKey
    const child = spawn(DSH_EXE, [
      '--expose-internals', DSH_CLI_JS,
      // 顺序很关键：--patch 是启动器 flag，必须排在第一个 app flag（--json）之前，
      // 否则会被原样透传给 headless app，报 unknown option '--patch'。
      '--profile', OPTIONS.profile,
      '--patch', patchPath,
      '--json',
      '-',
    ], { env, cwd: REPO, windowsHide: true })

    const events = []
    const rawLines = []
    let stderr = ''
    let buffer = ''
    let timedOut = false
    const started = Date.now()

    const timer = setTimeout(() => {
      timedOut = true
      // taskkill /T 才能带走 Electron 派生的子进程。
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        if (line.trim().length > 0) {
          rawLines.push(line)
          try {
            events.push({ at: Date.now(), event: JSON.parse(line) })
          } catch {
            events.push({ at: Date.now(), raw: line })
          }
        }
        index = buffer.indexOf('\n')
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })

    child.on('error', error => {
      clearTimeout(timer)
      resolve({ exitCode: -1, events, rawLines, stderr: `${stderr}\n${error.message}`, durationMs: Date.now() - started, timedOut })
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (buffer.trim().length > 0) {
        rawLines.push(buffer)
        try {
          events.push({ at: Date.now(), event: JSON.parse(buffer) })
        } catch {
          events.push({ at: Date.now(), raw: buffer })
        }
      }
      resolve({ exitCode: code ?? -1, events, rawLines, stderr, durationMs: Date.now() - started, timedOut })
    })

    child.stdin.end(task, 'utf8')
  })
}

/** 从事件数组里抽出断言要用的东西。 */
function summarizeEvents(events) {
  const parsed = events.filter(item => item.event !== undefined)
  const types = parsed.map(item => String(pick(item.event, ['type', 'kind', 'event']) ?? '?'))
  const calls = []
  const results = []
  let finalText
  let sessionId
  for (const item of parsed) {
    const type = pick(item.event, ['type', 'kind', 'event'])
    if (type === 'tool_call') {
      calls.push({
        at: item.at,
        tool: pick(item.event, ['tool', 'name', 'toolName']),
        input: pick(item.event, ['input', 'arguments', 'args']),
        callId: pick(item.event, ['callId', 'id']),
      })
    } else if (type === 'tool_result') {
      results.push({
        at: item.at,
        callId: pick(item.event, ['callId', 'id']),
        status: pick(item.event, ['status', 'state']),
        result: pick(item.event, ['result', 'content', 'output']),
        truncated: pick(item.event, ['truncated']),
      })
    } else if (type === 'final') {
      finalText = pick(item.event, ['text', 'message', 'content'])
    } else if (type === 'session') {
      sessionId = pick(item.event, ['sessionId', 'id'])
    }
  }
  return { types, calls, results, finalText, sessionId }
}

/** 把 result 统一成可读字符串。 */
function resultTextOf(result) {
  if (result === undefined) return ''
  if (typeof result === 'string') return result
  if (Array.isArray(result)) {
    return result.map(item => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n')
  }
  const text = pick(result, ['text', 'content', 'output'])
  return typeof text === 'string' ? text : JSON.stringify(result)
}

/** 判断对象是否包含期望的键值（浅比较）。 */
function containsMatch(actual, expected) {
  if (actual === null || typeof actual !== 'object') return false
  return Object.entries(expected).every(([key, value]) => {
    const got = actual[key]
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return containsMatch(got, value)
    }
    return JSON.stringify(got) === JSON.stringify(value)
  })
}

/** 按用例断言评估一次运行。 */
async function evaluate(item, run, context) {
  const { expect } = item
  const summary = summarizeEvents(run.events)
  const executions = summary.results.map(result => resultTextOf(result.result)).join('\n')
  const failures = []
  let status = 'OK'

  if (run.timedOut) {
    return { status: 'TIMEOUT', failures: [`超时（>${Math.round(OPTIONS.timeoutMs / 1000)}s）没有结束`], summary }
  }
  if (expect.exitCode !== undefined && run.exitCode !== expect.exitCode) {
    failures.push(`退出码 ${run.exitCode}，期望 ${expect.exitCode}`)
  }
  if (expect.noToolCall === true && summary.calls.length > 0) {
    failures.push(`不该调用工具，却调用了 ${summary.calls.map(call => String(call.tool)).join(', ')}`)
  }
  if (expect.tool !== undefined) {
    const matched = summary.calls.filter(call => call.tool === expect.tool)
    if (summary.calls.length === 0) {
      status = 'NO_TOOL_CALL'
      failures.push(`模型没有调用任何工具（期望 ${expect.tool}）`)
    } else if (matched.length === 0) {
      failures.push(`调用了 ${summary.calls.map(call => String(call.tool)).join(', ')}，期望 ${expect.tool}`)
    } else if (expect.inputMatch !== undefined && !matched.some(call => containsMatch(call.input, expect.inputMatch))) {
      failures.push(`入参不匹配：${JSON.stringify(matched.map(call => call.input))}`)
    }
    // 只看“我们关心的那个工具”的结果：模型可能顺带读文件或执行命令，
    // 那些调用失败（例如沙箱 ACL 报错）不该算到插件头上。
    const matchedIds = new Set(matched.map(call => call.callId))
    const matchedResults = summary.results.filter(result => matchedIds.has(result.callId))
    if (matched.length > 0 && matchedResults.length === 0) {
      status = 'NO_RESULT'
      failures.push('有 tool_call 但没有对应的 tool_result')
    }
    const failed = matchedResults.filter(result => result.status !== undefined && result.status !== 'completed')
    if (failed.length > 0) {
      status = 'TOOL_ERROR'
      failures.push(`tool_result 状态异常：${failed.map(result => String(result.status)).join(', ')}`)
    }
  }
  for (const needle of expect.resultIncludes ?? []) {
    if (!executions.includes(needle)) failures.push(`工具结果里缺少「${needle}」`)
  }
  for (const needle of expect.resultExcludes ?? []) {
    if (executions.includes(needle)) failures.push(`工具结果里不应出现「${needle}」`)
  }
  for (const needle of expect.finalIncludes ?? []) {
    if (!String(summary.finalText ?? '').includes(needle)) failures.push(`最终回答里缺少「${needle}」`)
  }
  for (const needle of expect.stderrIncludes ?? []) {
    if (!run.stderr.includes(needle)) failures.push(`stderr 里缺少「${needle}」`)
  }
  if (expect.jsonResult === true) {
    const json = extractJson(executions)
    if (json === undefined) failures.push('工具结果不是可解析的 JSON')
    else if (json.ok === undefined || json.summary === undefined) failures.push('JSON 缺少 ok/summary')
  }
  if (typeof expect.custom === 'function') {
    failures.push(...await expect.custom({
      ...context,
      run,
      summary,
      resultText: executions,
      finalText: String(summary.finalText ?? ''),
    }))
  }
  if (status === 'OK' && failures.length > 0) status = 'WRONG_OUTPUT'
  return { status, failures, summary }
}

/** 生成脱敏后的证据文本：绝不把 key 写进磁盘。 */
function redact(text) {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-<redacted>')
    .replace(/([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET)[A-Z0-9_]*\s*[=:]\s*)\S+/g, '$1<redacted>')
}

/** 单个用例跑 N 次。 */
async function runCase(item, runId) {
  if (item.kind === 'stub') {
    const result = spawnSync(process.execPath, [join(HERE, 'e2e', 'stub-conflict.mjs')], { encoding: 'utf8' })
    const ok = result.status === 0
    return {
      id: item.id,
      title: item.title,
      runs: [{
        index: 1,
        status: ok ? 'OK' : 'STUB_FAIL',
        failures: ok ? [] : [`stub 失败：${(result.stderr || result.stdout || '').slice(0, 400)}`],
      }],
      ok,
    }
  }

  const setup = await item.setup()
  const dirs = setup.skillDirs ?? []
  const task = typeof item.task === 'function' ? await item.task(setup) : item.task
  const patch = buildPatch({ dirs, doctorConfig: setup.doctorConfig })
  const caseDir = join(OPTIONS.outDir, runId, item.id)
  await mkdir(caseDir, { recursive: true })
  const patchPath = join(caseDir, 'patch.yml')
  await writeFile(patchPath, patch, 'utf8')

  const watchBefore = new Map()
  for (const file of setup.watchFiles ?? []) {
    watchBefore.set(file, await hashOf(file))
  }

  const baseline = dirs.length > 0 ? await cliBaseline(dirs[0]) : { count: undefined, durationMs: undefined, bytes: undefined }

  const runs = []
  for (let index = 1; index <= OPTIONS.runs; index++) {
    const run = await runHeadless({ patchPath, task, timeoutMs: OPTIONS.timeoutMs })
    if (OPTIONS.record) {
      const summary = summarizeEvents(run.events)
      console.log(`  [record] ${item.id} run${index} 事件类型：`, JSON.stringify(countTypes(summary.types)))
      console.log(`  [record] 工具调用：`, JSON.stringify(summary.calls.map(call => ({ tool: call.tool, input: call.input }))))
      console.log(`  [record] 结果片段：`, resultTextOf(summary.results[0]?.result).slice(0, 200).replace(/\n/g, ' ⏎ '))
    }
    const evaluation = await evaluate(item, run, {
      baseline,
      dirs,
      cliCount: baseline.count,
      cliNames: baseline.names,
    })
    const dir = join(caseDir, `run-${index}`)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'events.jsonl'), redact(run.rawLines.join('\n')), 'utf8')
    await writeFile(join(dir, 'stderr.log'), redact(run.stderr), 'utf8')
    await writeFile(join(dir, 'result.txt'), redact(resultTextOf(evaluation.summary.results[0]?.result)), 'utf8')

    // 只读文件校验：跑前跑后 hash 必须一致。
    const tampered = []
    for (const [file, before] of watchBefore) {
      const after = await hashOf(file)
      if (after !== before) tampered.push(`${file} 被改写了`)
    }
    if (tampered.length > 0) evaluation.failures.push(...tampered)

    const toolSpanMs = spanOf(evaluation.summary)
    runs.push({
      index,
      status: tampered.length > 0 ? 'WRONG_OUTPUT' : evaluation.status,
      failures: evaluation.failures,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      toolSpanMs,
      resultBytes: Buffer.byteLength(resultTextOf(evaluation.summary.results[0]?.result)),
      truncated: evaluation.summary.results.some(result => result.truncated === true),
      calls: evaluation.summary.calls.map(call => ({ tool: call.tool, input: call.input })),
      eventTypes: countTypes(evaluation.summary.types),
      stderrTail: redact(run.stderr).slice(-2000),
    })
    process.stdout.write(
      `  ${item.id} run${index}: ${runs[runs.length - 1].status}`
      + (toolSpanMs === undefined ? '' : ` · 工具段 ${toolSpanMs}ms`)
      + (runs[runs.length - 1].resultBytes > 0 ? ` · 输出 ${runs[runs.length - 1].resultBytes}B` : '')
      + (runs[runs.length - 1].truncated ? ' · 事件被截断' : '')
      + '\n',
    )
    for (const failure of evaluation.failures) process.stdout.write(`      - ${failure}\n`)
  }

  return {
    id: item.id,
    title: item.title,
    baseline,
    runs,
    ok: runs.every(run => run.status === 'OK'),
  }
}

/** 统计事件类型出现次数，方便 --record 时看结构。 */
function countTypes(types) {
  const counts = {}
  for (const type of types) counts[type] = (counts[type] ?? 0) + 1
  return counts
}

/** tool_call → 对应 tool_result 的间隔，取第一条。 */
function spanOf(summary) {
  const call = summary.calls[0]
  if (call === undefined) return undefined
  const result = summary.results.find(item => item.callId === undefined || item.callId === call.callId)
    ?? summary.results[0]
  if (result === undefined) return undefined
  return result.at - call.at
}

/** 文件内容 hash，用于验证插件不写文件。 */
async function hashOf(file) {
  try {
    return createHash('sha256').update(await readFile(file)).digest('hex')
  } catch {
    return 'missing'
  }
}

/** 打印帮助。 */
function usage() {
  return [
    'Usage: node scripts/e2e-headless.mjs [options]',
    '',
    '  --list                 list case ids',
    '  --case A2[,A3]         run specific cases',
    '  --group A[,B]          run a whole group',
    '  --runs N               repeat each case N times (default 1)',
    '  --record               print event shapes instead of only pass/fail',
    '  --keep                 keep evidence dirs (default keeps only failures)',
    '  --timeout S            per-run timeout in seconds (default 180)',
    '  --provider NAME        account (default, 官方 DeepSeek 账号) | gateway (本地 OpenAI 兼容网关)',
    '  --account-model NAME   账户通道使用的模型 id (default deepseek-flash)',
    '  --base-url URL         gateway 模式的 base url (default http://127.0.0.1:7863/v1)',
    '  --model NAME           model id',
    '  --api-key-env NAME     env var holding the key',
    '  --out DIR              evidence dir (default scripts/e2e/out)',
    '  --no-gateway-check     skip the preflight probe',
    '',
    'Exit: 0 pass / 1 fail / 2 precondition / 3 gateway offline / 4 profile not writable',
  ].join('\n')
}

/** 主流程。 */
async function main() {
  const options = parseArgs(process.argv.slice(2))
  Object.assign(OPTIONS, options)
  if (OPTIONS.provider === 'gateway') resolvedKey = resolveApiKey(OPTIONS.apiKeyEnv)

  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }
  if (options.list) {
    for (const item of CASES) process.stdout.write(`${item.id}  [${item.group}]  ${item.title}\n`)
    return 0
  }
  // app.asar 在操作系统眼里是一个文件，普通 Node 无法 stat 里面的 cli.js，
  // 所以这里只校验 exe 和 asar 本体，cli.js 的路径交给 Electron 自己解析。
  if (!existsSync(DSH_EXE) || !existsSync(ASAR_FILE)) {
    process.stderr.write(`precondition: dsh not found\n  exe=${DSH_EXE}\n  asar=${ASAR_FILE}\n`)
    return 2
  }
  if (OPTIONS.provider === 'account') {
    if (OPTIONS.checkGateway && !hasAccountGrant()) {
      process.stderr.write('account provider unavailable: ~/.dsh/.credentials.yaml 里没有 deepseek-account-platform 授权，'
        + '先在桌面端登录 DeepSeek 账号，或改用 --provider gateway\n')
      return 3
    }
  } else if (OPTIONS.checkGateway && !await gatewayOnline()) {
    process.stderr.write(`gateway offline: ${OPTIONS.baseUrl} — 先启动本地网关再跑（或用 --no-gateway-check 只看结构）\n`)
    return 3
  }

  const selected = selectCases({ ids: OPTIONS.ids, groups: OPTIONS.groups })
  if (selected.length === 0) {
    process.stderr.write('没有匹配的用例；用 --list 看可用 id。\n')
    return 2
  }

  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  await mkdir(join(OPTIONS.outDir, runId), { recursive: true })
  await fixtures.init()

  process.stdout.write(`run ${runId} · ${selected.length} 个用例 × ${OPTIONS.runs} 次\n`)
  const reports = []
  let permissionDenied = false
  try {
    for (const item of selected) {
      process.stdout.write(`\n[${item.id}] ${item.title}\n`)
      const report = await runCase(item, runId)
      reports.push(report)
      if (report.runs.some(run => /EPERM|EACCES|operation not permitted/i.test(`${run.stderrTail ?? ''}\n${run.failures.join('\n')}`))) {
        permissionDenied = true
      }
    }
  } finally {
    await fixtures.cleanup()
  }

  await writeFile(join(OPTIONS.outDir, runId, 'summary.json'), JSON.stringify(reports, null, 2), 'utf8')

  const failed = reports.filter(report => !report.ok)
  process.stdout.write(`\n==== 汇总 ====\n`)
  for (const report of reports) {
    const statuses = report.runs.map(run => run.status).join(',')
    process.stdout.write(`${report.ok ? 'PASS' : 'FAIL'}  ${report.id}  ${statuses}  ${report.title}\n`)
  }
  process.stdout.write(`证据：${join(OPTIONS.outDir, runId)}\n`)

  if (permissionDenied) {
    process.stderr.write('profile 不可写（EPERM/EACCES）：请在普通终端运行，或把 DSH_HOME 指向可写目录。\n')
    return 4
  }
  return failed.length === 0 ? 0 : 1
}

let resolvedKey
main().then(code => { process.exitCode = code }).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
