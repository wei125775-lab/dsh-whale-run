/**
 * 截「放大特写」，给 README 和 Release 说明用。
 *
 * 为什么不用整窗截图：1440×900 的窗口里，跑道只占中间一条细带、鲸鱼本体才 34px，
 * 缩进文档里就是一片黑。这里用 Page.captureScreenshot 的 clip + scale，
 * 只截跑道那一带、放大若干倍，出来的是能看清的画面。
 *
 * 用法：node test/shoot-shots.mjs [debugPort] [outDir]
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.argv[2] || 9345)
const OUT = process.argv[3] || path.join(HERE, 'shots')
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const HARNESS = 'file:///' + path.join(HERE, 'harness.html').replace(/\\/g, '/')

fs.mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id === undefined) return
      const p = this.pending.get(m.id)
      if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP timeout: ' + method)) } }, 20000)
    })
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(function(){ try { return (${expr}) } catch (e) { return { __err: String(e && e.stack || e) } } })()`,
      returnByValue: true, awaitPromise: true,
    })
    const v = r.result?.value
    if (v && typeof v === 'object' && v.__err) throw new Error('eval error: ' + v.__err)
    return v
  }
  /** 只截跑道那一带（外面留点边距），按 z 倍放大 */
  async shotBand(name, z = 2.5, pad = { x: 26, top: 56, bottom: 44 }) {
    const r = await this.eval(`(function(){
      var e = document.querySelector('.wr-runway');
      if (!e) return null;
      var r = e.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })()`)
    if (!r) throw new Error('no runway')
    const w = Math.min(r.w + pad.x * 2, 1440 - Math.max(0, r.x - pad.x))
    const clip = {
      x: Math.max(0, r.x - pad.x),
      y: Math.max(0, r.y - pad.top),
      width: w,
      height: r.h + pad.top + pad.bottom,
      scale: z,
    }
    const res = await this.send('Page.captureScreenshot', { format: 'png', clip })
    const f = path.join(OUT, name + '.png')
    fs.writeFileSync(f, Buffer.from(res.data, 'base64'))
    console.log('  ->', path.basename(f), Math.round(clip.width * z) + 'x' + Math.round(clip.height * z))
    return f
  }
}

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-run-shoot-'))
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-sync', '--allow-file-access-from-files',
  '--disable-features=msEdgeSyncConfirmation,msEdgeFirstRunExperience',
  '--window-size=1440,900', '--force-device-scale-factor=1',
  '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--user-data-dir=' + userDir,
  HARNESS + '#seed=20261015',
], { stdio: 'ignore' })

const kill = () => { try { spawnSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' }) } catch (e) {} }
process.on('exit', kill)
process.on('SIGINT', () => { kill(); process.exit(130) })

async function target() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page' && t.url.startsWith('file:'))
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl
    } catch (e) {}
    await sleep(250)
  }
  throw new Error('edge 没起来')
}

const ws = new WebSocket(await target())
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
const cdp = new Cdp(ws)
await cdp.send('Runtime.enable')
await cdp.send('Page.enable')

for (let i = 0; i < 60; i++) {
  if (await cdp.eval('!!window.__harnessReady').catch(() => false)) break
  await sleep(150)
}
console.log('harness ready')

// --- 1) 刚拿起来：标题碎成波浪、水面涌出、鲸鱼跟着手 ---
// ⚠️ grab 之后不能马上读跑道的 rect：那会儿 layoutRunway 还没跑过，rect 全是 0，
// moveTo(0,0) 会把鲸鱼扔到屏幕左上角去。先等一帧。
await cdp.eval(`window.__whaleRun.grab('hero')`)
await sleep(180)
await cdp.eval(`(function(){
  var r = document.querySelector('.wr-runway').getBoundingClientRect();
  window.__whaleRun.moveTo(r.left + r.width * 0.34, r.top + r.height * 0.52);
  return true;
})()`)
await sleep(260)   // 碎字刚起波那一瞬：字还在原位附近、只带一点 blur，再晚就飘散得只剩糊影
console.log('  hi-1 诊断:', JSON.stringify(await cdp.eval(`(function(){
  var c = document.querySelector('.wr-carry');
  var r = c.getBoundingClientRect();
  var q = document.querySelector('.wr-runway').getBoundingClientRect();
  return { carryX: window.__whaleRun.carryingX, carryY: window.__whaleRun.carryingY,
           size: window.__whaleRun.carryingSize, live: c.classList.contains('wr-live'),
           op: getComputedStyle(c).opacity, vis: getComputedStyle(c).visibility,
           carryRect: [Math.round(r.left), Math.round(r.top), Math.round(r.width)],
           runway: [Math.round(q.left), Math.round(q.top), Math.round(q.width), Math.round(q.height)] };
})()`)))
await cdp.shotBand('hi-1-拿起来', 2.5)
await cdp.eval('window.__whaleRun.quit()')
await sleep(500)

// --- 2) 跑起来了：有障碍物、有分数 ---
await cdp.eval(`(function(){
  window.__whaleRun.grab('hero');
  var r = document.querySelector('.wr-runway').getBoundingClientRect();
  window.__whaleRun.moveTo(r.left + r.width * 0.5, r.top + r.height * 0.45);
  window.__whaleRun.dropNow();
  return true;
})()`)
for (let i = 0; i < 40; i++) {
  if ((await cdp.eval('window.__whaleRun.entering')) === false) break
  await sleep(100)
}
// 先自然跑一段，让分数涨起来（障碍物也顺带露个脸）
await sleep(2600)
// 再手工摆一组：自然生成的太稀，撑不起一张"卖点图"。x 是跑道局部坐标，
// 从起点算起 0.8 秒后才撞得上，截图那几百毫秒里不会翻车。
await cdp.eval(`(function(){
  var eg = window.__whaleRun.engine, g = eg.groundY;
  eg.st.obstacles.length = 0;
  [
    { kind:'net',       w:38, h:22, oy:22, x:250 },
    { kind:'bottle',    w:16, h:30, oy:30, x:400 },
    { kind:'coral',     w:20, h:40, oy:40, x:530 },
    { kind:'jelly',     w:26, h:22, oy:40, x:670, swim:true, amp:40, k:0.020, ph:4.6 },
    { kind:'jellyHigh', w:26, h:22, oy:62, x:830, swim:true, amp:38, k:0.017, ph:1.1 },
  ].forEach(function(o){ o.alive = true; o.y = o.swim ? eg.swimY(o) : g - o.oy; eg.st.obstacles.push(o) });
  return eg.st.obstacles.length;
})()`)
await sleep(60)   // 让这一帧画上去
await cdp.shotBand('hi-2-跑起来', 2.5)

// --- 3) 撞死：被打飞那一刻（画面里得有结算那屏） ---
await cdp.eval(`(function(){
  var eg = window.__whaleRun.engine;
  eg.st.y = 0; eg.st.grounded = true; eg.st.vy = 0;
  eg.st.obstacles.push({ kind:'coral', x: 60, y: eg.groundY - 40, oy: 40, w: 20, h: 40, alive: true, phase: 0 });
  return true;
})()`)
let over = false
for (let i = 0; i < 60; i++) {
  if (await cdp.eval(`!!(window.__whaleRun.engine && window.__whaleRun.engine.st.phase === 'over')`)) { over = true; break }
  await sleep(60)
}
await sleep(260)   // 让掷出去的那只飞一会儿，同时分数那屏亮起来
await cdp.shotBand('hi-3-撞死', 2.5, { x: 26, top: 90, bottom: 96 })
console.log('over 触发:', over)

kill()
console.log('搞定，图在', OUT)
process.exit(0)
