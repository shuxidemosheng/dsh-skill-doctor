/** 测试共用：用真实 scanner 读 fixtures，构造最小 ctx 服务面。 */
import { fileURLToPath } from 'node:url'
import { scanSkillFile } from '../src/scanner/fs-scan.js'
import type { SkillInput } from '../src/types.js'

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))

/** 读取一个 fixture 技能目录。 */
export async function loadFixture(dir: string, maxFileBytes = 1024 * 1024): Promise<SkillInput> {
  const skill = await scanSkillFile(`${FIXTURES}${dir}/SKILL.md`, maxFileBytes)
  if (skill === undefined) throw new Error(`fixture not found: ${dir}`)
  return skill
}

/** 一条伪造的注册表摘要。 */
export interface FakeEntry {
  readonly skill: SkillInput
  readonly provider?: string
  readonly source?: string
}

/** 最小 ctx：tools / skills / workingDirectory / logger。 */
export interface FakeEnv {
  readonly ctx: Record<string, unknown>
  readonly tools: Map<string, { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }>
  readonly warnings: string[]
  readonly skillCalls: { snapshot: number; get: string[] }
}

/** 用给定技能构造 ctx；注册表快照只返回每个 name 的第一个。 */
export function createFakeCtx(entries: readonly FakeEntry[]): FakeEnv {
  const tools = new Map<string, { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }>()
  const warnings: string[] = []
  const skillCalls = { snapshot: 0, get: [] as string[] }

  const winners = new Map<string, SkillInput>()
  for (const entry of entries) {
    if (!winners.has(entry.skill.name)) winners.set(entry.skill.name, entry.skill)
  }

  const ctx: Record<string, unknown> = {
    logger: {
      warn: (message: string) => warnings.push(message),
      error: (message: string) => warnings.push(`[error] ${message}`),
      info: () => {},
    },
    tools: {
      get: (toolName: string) => tools.get(toolName),
      register: (tool: { name: string }) => {
        if (tools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`)
        tools.set(tool.name, tool as never)
      },
    },
    skills: {
      snapshot: async () => {
        skillCalls.snapshot++
        return {
          skills: [...winners.values()].map(skill => ({
            name: skill.name,
            description: skill.description,
            ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
            invocation: skill.invocation,
            source: skill.source,
            provider: skill.provider,
            ...skill.path === undefined ? {} : { path: skill.path },
            ...skill.resourceBase === undefined ? {} : { resourceBase: skill.resourceBase },
          })),
          complete: true,
        }
      },
      get: async (name: string) => {
        skillCalls.get.push(name)
        const skill = winners.get(name)
        if (skill === undefined) return undefined
        return {
          name: skill.name,
          description: skill.description,
          content: skill.content,
          invocation: skill.invocation,
          source: skill.source,
          provider: skill.provider,
          ...skill.path === undefined ? {} : { path: skill.path },
          ...skill.metadata === undefined ? {} : { metadata: skill.metadata },
          ...skill.resourceBase === undefined ? {} : { resourceBase: skill.resourceBase },
        }
      },
    },
    workingDirectory: {
      ensure: async () => FIXTURES,
    },
  }

  return { ctx, tools, warnings, skillCalls }
}

/** 与模型驱动路径一致的 execute 第二参数。 */
export function fakeExec(agent: { id: string } | undefined = { id: 'agent-1' }): Record<string, unknown> {
  return {
    callId: 'call-1',
    name: 'skill_lint',
    arguments: {},
    token: 'tok-1',
    rootCallId: undefined,
    agent,
    parent: undefined,
    signal: new AbortController().signal,
    deferContext: () => {},
    concludeTurn: () => {},
  }
}

/** 调用已注册工具。 */
export async function callTool(env: FakeEnv, name: string, args: unknown): Promise<unknown> {
  const registered = env.tools.get(name)
  if (registered === undefined) throw new Error(`tool "${name}" was not registered`)
  const run = registered.execute.bind(registered)
  return await run(args, fakeExec())
}
