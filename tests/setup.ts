/**
 * 全局测试隔离：把 DSH_HOME 指到临时目录。
 *
 * 0.10.0 起复诊默认开启，skill_doctor 会在体检后写病历——
 * 不隔离的话单测会往开发者真实的 ~/.dsh 里写 record-default.json，
 * 既污染环境，也让测试带上跨用例状态。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-test-home-'))
