/**
 * 本插件注册的工具名。
 *
 * 单独放一个文件、不放 `index.ts`，是因为运行时体检要检查"我的工具还在不在
 * 注册表里"，而 `index.ts → tools/* → plugins/report` 这条链已经很长，
 * 反过来 import `index.ts` 会形成循环。
 */
export const TOOL_NAMES = ['skill_doctor', 'skill_lint', 'skill_explain', 'plugin_doctor'] as const
