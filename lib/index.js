/**
 * dsh-whale-run，宿主半侧。
 *
 * 纯 UI 插件：这个空的 apply 存在的唯一目的，是让本包出现在 loader 树里
 * （客户端半侧只挂在 specifier 恰为包名的那条 entry 上），以及让
 * `dsh-client-modules` 能按 loader 行定位到 package.json。
 * 全部逻辑在浏览器半侧 ./client.js。
 */

export const name = '@dph/dsh-whale-run'

export const inject = []

export function apply() {}

export default { name, inject, apply }
