/**
 * 往正在跑的 dsh 里塞一段表达式，把结果打印出来。
 *
 * 前置同 cdp-live.mjs：app 必须带 --remote-debugging-port=9222 启动。
 * 用法：node test/cdp-eval.mjs "[port]" "表达式"   或   node test/cdp-eval.mjs "[port]" @脚本文件
 */

import fs from 'node:fs'

const args = process.argv.slice(2)
const PORT = /^\d+$/.test(args[0] || '') ? args[0] : '9222'
let expr = args[0] && /^\d+$/.test(args[0]) ? args[1] : args[0]
if (!expr) {
  console.error('用法: node test/cdp-eval.mjs [port] "<表达式>" | @文件路径')
  process.exit(2)
}
if (expr.startsWith('@')) expr = fs.readFileSync(expr.slice(1), 'utf8')

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && /^(dsh-app:|http:\/\/127\.0\.0\.1)/.test(t.url))
if (!page) { console.error('没找到页面目标，app 是不是没带 --remote-debugging-port 启动？'); process.exit(2) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
let id = 0
const pend = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id) }
})
const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })

const r = await send('Runtime.evaluate', {
  expression: `(function(){ try { return (${expr}) } catch (e) { return { __err: String(e && e.stack || e) } } })()`,
  returnByValue: true,
  awaitPromise: true,
})
if (r.exceptionDetails) console.error('异常:', r.exceptionDetails.exception?.description || r.exceptionDetails.text)
const v = r.result?.value
console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1))
ws.close()
