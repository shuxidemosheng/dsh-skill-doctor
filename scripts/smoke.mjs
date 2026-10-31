/** Smoke：用构建产物 + 打桩 ctx 跑通注册、skill_lint、skill_explain。 */
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'
import { scanSkillFile } from '../lib/scanner/fs-scan.js'

const fixtures = fileURLToPath(new URL('../tests/fixtures/', import.meta.url))
const good = await scanSkillFile(`${fixtures}good-skill/SKILL.md`, 1024 * 1024)
if (good === undefined) throw new Error('fixture missing')

const tools = new Map()
const warnings = []
const ctx = {
  logger: { warn: (message) => warnings.push(message), error: () => {}, info: () => {} },
  tools: {
    get: (name) => tools.get(name),
    register: (tool) => tools.set(tool.name, tool),
  },
  skills: {
    snapshot: async () => ({
      skills: [{
        name: good.name,
        description: good.description,
        invocation: good.invocation,
        source: good.source,
        provider: good.provider,
        path: good.path,
        resourceBase: good.resourceBase,
      }],
      complete: true,
    }),
    get: async () => ({
      name: good.name,
      description: good.description,
      content: good.content,
      invocation: good.invocation,
      source: good.source,
      provider: good.provider,
      path: good.path,
      metadata: good.metadata,
      resourceBase: good.resourceBase,
    }),
  },
  workingDirectory: { ensure: async () => fixtures },
}

apply(ctx, undefined)
if ([...tools.keys()].sort().join(',') !== 'skill_doctor,skill_explain,skill_lint') {
  throw new Error(`unexpected tools: ${[...tools.keys()].join(',')}`)
}

const exec = {
  callId: 'smoke',
  name: 'skill_lint',
  arguments: {},
  token: 'smoke',
  agent: { id: 'agent-smoke' },
  signal: new AbortController().signal,
  deferContext: () => {},
  concludeTurn: () => {},
}

const lint = tools.get('skill_lint')
const lintOut = String(await lint.execute({ name: 'good-skill' }, exec))
if (!lintOut.includes('Skill Doctor')) throw new Error(`unexpected lint output: ${lintOut}`)

const doctor = tools.get('skill_doctor')
const doctorOut = String(await doctor.execute({ name: 'good-skill' }, exec))
if (!doctorOut.includes('结论：没问题')) throw new Error(`unexpected doctor output: ${doctorOut}`)
if (!doctorOut.includes('## 技术细节（可跳过）')) throw new Error(`missing technical footer: ${doctorOut}`)

const explain = tools.get('skill_explain')
const explainOut = String(await explain.execute({ name: 'good-skill' }, exec))
if (!explainOut.includes('provider: filesystem')) throw new Error(`unexpected explain output: ${explainOut}`)
if (warnings.length !== 0) throw new Error(`unexpected warnings: ${warnings.join('; ')}`)

console.log('smoke ok')
