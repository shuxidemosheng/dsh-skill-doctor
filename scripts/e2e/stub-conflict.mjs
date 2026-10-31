#!/usr/bin/env node
/**
 * 工具名冲突的确定性验证（不接 dsh、不接模型）。
 *
 * 真实运行时里几乎撞不到同名工具，所以这里用最小桩 ctx 复现：
 * 先占住 skill_doctor，再 apply 插件，期望它打 warn 并让位，
 * 其余两个工具照常注册 —— 这是插件纪律里最容易回归的一条。
 */
import { fileURLToPath } from 'node:url'
import { apply } from '../../lib/index.js'
import { scanSkillFile } from '../../lib/scanner/fs-scan.js'

const fixtures = fileURLToPath(new URL('../../tests/fixtures/', import.meta.url))
const good = await scanSkillFile(`${fixtures}good-skill/SKILL.md`, 1024 * 1024)
if (good === undefined) throw new Error('fixture missing: tests/fixtures/good-skill/SKILL.md')

/** 已经被别人注册的工具，用来制造冲突。 */
const occupied = { name: 'skill_doctor', execute: async () => 'not mine' }
const tools = new Map([[occupied.name, occupied]])
const warnings = []

const ctx = {
  logger: {
    warn: message => warnings.push(message),
    error: () => {},
    info: () => {},
  },
  tools: {
    get: name => tools.get(name),
    register: tool => tools.set(tool.name, tool),
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

const problems = []
if (tools.get('skill_doctor') !== occupied) problems.push('skill_doctor 被覆盖了，应该让位给已有工具')
if (!tools.has('skill_lint')) problems.push('skill_lint 没有注册')
if (!tools.has('skill_explain')) problems.push('skill_explain 没有注册')
if (!warnings.some(warning => /skill_doctor.*already registered/.test(warning))) {
  problems.push(`没有为冲突打 warn，实际 warnings=${JSON.stringify(warnings)}`)
}

// 让位之后其余工具仍然要能跑，避免“注册成功但执行体坏了”。
const exec = {
  callId: 'stub',
  name: 'skill_lint',
  arguments: {},
  token: 'stub',
  agent: { id: 'agent-stub' },
  signal: new AbortController().signal,
  deferContext: () => {},
  concludeTurn: () => {},
}
const lintOut = String(await tools.get('skill_lint').execute({ name: 'good-skill' }, exec))
if (!lintOut.includes('Skill Doctor')) problems.push(`skill_lint 输出异常：${lintOut.slice(0, 200)}`)

if (problems.length > 0) {
  console.error(`stub-conflict: ${problems.join('; ')}`)
  process.exit(1)
}
console.log('stub-conflict ok')
