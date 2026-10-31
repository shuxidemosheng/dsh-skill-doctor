/**
 * e2e 用的临时技能目录生成器。
 *
 * 所有目录都写在系统临时目录下（不进仓库），跑完由 e2e-headless.mjs 调用 cleanup() 删除。
 * 这样既能造 500 个技能的压测数据，也不会污染 ~/.claude/skills 或仓库。
 */
import { mkdir, mkdtemp, rm, writeFile, chmod, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 本次运行的临时根目录；由 init() 赋值。 */
let root = ''

/** 创建本次运行的临时根。 */
export async function init() {
  root = await mkdtemp(join(tmpdir(), 'dsh-skill-doctor-e2e-'))
  return root
}

/** 当前临时根。 */
export function tempRoot() {
  return root
}

/** 在临时根下新建一个目录。 */
async function dir(...parts) {
  const path = join(root, ...parts)
  await mkdir(path, { recursive: true })
  return path
}

/** 生成一个技能文件内容；description 可指定长度。 */
function skillFile(name, description, body = 'Do the thing.\n') {
  return `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\n${body}`
}

/** 空目录：一个技能都没有。 */
export async function emptyRoot() {
  return dir('empty')
}

/** 只有子目录、没有 SKILL.md：用来验证“不崩、不误报 SD001”。 */
export async function rootWithoutSkillFiles() {
  const path = await dir('no-skill-md')
  await dir('no-skill-md', 'just-a-folder')
  await writeFile(join(path, 'README.md'), 'not a skill\n', 'utf8')
  return path
}

/** 简介超长（默认 800 字），并且被切掉的部分带中文触发词。 */
export async function longDescriptionRoot(length = 800) {
  const path = await dir('long-description')
  const filler = 'Handles general research writing tasks for manuscripts. '.repeat(20)
  const triggers = '当用户说「分段引用」「自动给出引用」时使用本技能。'
  const description = `${filler.slice(0, Math.max(0, length - triggers.length))}${triggers}`
  await mkdir(join(path, 'long-desc'), { recursive: true })
  await writeFile(join(path, 'long-desc', 'SKILL.md'), skillFile('long-desc', description), 'utf8')
  return path
}

/** BOM + CRLF：编码类规则的真实来源。 */
export async function bomCrlfRoot() {
  const path = await dir('bom-crlf')
  const text = skillFile('bom-crlf', 'Use this skill when the user asks about encoding edge cases.')
    .replace(/\n/g, '\r\n')
  await mkdir(join(path, 'bom-crlf'), { recursive: true })
  await writeFile(join(path, 'bom-crlf', 'SKILL.md'), `\uFEFF${text}`, 'utf8')
  return path
}

/** 两个 root 里放同名技能，验证同名遮蔽提示。 */
export async function duplicateRoots() {
  const a = await dir('dup-a')
  const b = await dir('dup-b')
  const description = 'Use this skill when the user asks to demonstrate duplicate name handling.'
  for (const [base, tag] of [[a, 'A'], [b, 'B']]) {
    await mkdir(join(base, 'dup-demo'), { recursive: true })
    await writeFile(join(base, 'dup-demo', 'SKILL.md'), skillFile('dup-demo', description, `Variant ${tag}.\n`), 'utf8')
  }
  return [a, b]
}

/** 只读技能文件：验证插件不写文件、不崩。 */
export async function readonlyRoot() {
  const path = await dir('readonly')
  const source = join(path, 'readonly-skill', 'SKILL.md')
  await mkdir(join(path, 'readonly-skill'), { recursive: true })
  await writeFile(source, skillFile('readonly-skill', 'Use this skill when the user asks about read-only skill files.'), 'utf8')
  await chmod(source, 0o444)
  return { root: path, file: source }
}

/** 中文技能名：验证非 ASCII 名字的报错文案不崩。 */
export async function chineseNameRoot() {
  const path = await dir('chinese-name')
  await mkdir(join(path, '技能示例'), { recursive: true })
  await writeFile(
    join(path, '技能示例', 'SKILL.md'),
    skillFile('技能示例', '当用户需要演示中文技能名时使用这个技能。'),
    'utf8',
  )
  return path
}

/**
 * 合成 N 个技能，用于性能测试。
 * 每 10 个里有 1 个简介超过 500 字，让报告有真实的截断分组。
 */
export async function syntheticRoot(count) {
  const path = await dir(`synthetic-${count}`)
  const long = 'Handles general research writing tasks for manuscripts, citations and figures. '.repeat(9)
  for (let i = 1; i <= count; i++) {
    const name = `perf-skill-${String(i).padStart(3, '0')}`
    const description = i % 10 === 0
      ? `${long.slice(0, 700)}当用户说「性能测试」时使用。`
      : `Use this skill when the user asks about performance case ${i} in the synthetic corpus.`
    const dirPath = join(path, name)
    await mkdir(dirPath, { recursive: true })
    await writeFile(join(dirPath, 'SKILL.md'), skillFile(name, description, 'Step 1.\nStep 2.\n'), 'utf8')
  }
  return path
}

/** 把一个真实技能复制到临时目录并设为只读（保留原始内容，避免污染用户目录）。 */
export async function copyReadonly(sourceFile, name) {
  const path = await dir(`copy-${name}`)
  const target = join(path, 'SKILL.md')
  await copyFile(sourceFile, target)
  await chmod(target, 0o444)
  return path
}

/** 删除本次运行的全部临时目录。 */
export async function cleanup() {
  if (root === '') return
  await rm(root, { recursive: true, force: true })
  root = ''
}
